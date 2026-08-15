const express = require('express');
const fs = require('fs');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');
const { enqueueSubmission } = require('../services/judge');
const { reviewCode, CODE_LENGTH_LIMIT } = require('../services/security');
const { sanitizeLog, banUserAndRevoke } = require('../utils/securityHelpers');
const { parsePageLimit } = require('../utils/pagination');
const config = require('../config/config');

const router = express.Router();
const rateLimit = createRateLimit(config.rateLimit.submissions);

router.get('/', requireAuth, (req, res) => {
  const { page = 1, limit = 50, user_id, problem_id, status, score_min, score_max, username } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE 1=1';
  const params = [];

  // 用户筛选：普通用户固定只能看自己的提交，杜绝通过 user_id 参数越权查看他人
  if (req.user.role === 'user') {
    where += ' AND s.user_id = ?';
    params.push(req.user.id);
  } else if (user_id) {
    where += ' AND s.user_id = ?';
    params.push(parseInt(user_id));
  } else if (username) {
    // 转义 LIKE 通配符，防止 % _ 被当作模式匹配（避免越权用 % 匹配所有用户）
    const esc = String(username).replace(/[\\%_]/g, m => `\\${m}`);
    where += ' AND u.username LIKE ? ESCAPE ?';
    params.push(`%${esc}%`, '\\');
  }

  if (problem_id) {
    where += ' AND s.problem_id = ?';
    params.push(parseInt(problem_id));
  }
  if (status) {
    where += ' AND s.status = ?';
    params.push(status);
  }
  // 分数段筛选
  if (score_min !== undefined && score_min !== '') {
    where += ' AND s.score >= ?';
    params.push(parseFloat(score_min));
  }
  if (score_max !== undefined && score_max !== '') {
    where += ' AND s.score <= ?';
    params.push(parseFloat(score_max));
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM submissions s LEFT JOIN users u ON s.user_id = u.id ${where}`).get(...params).c;
  const submissions = db.prepare(`
    SELECT s.id, s.user_id, s.problem_id, s.language, s.status, s.score, s.time_used, s.memory_used, s.created_at,
           u.username, p.title as problem_title
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN problems p ON s.problem_id = p.id
    ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, submissions });
});

router.get('/:id', requireAuth, (req, res) => {
  const submission = db.prepare(`
    SELECT s.*, u.username, p.title as problem_title, p.time_limit, p.memory_limit
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN problems p ON s.problem_id = p.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  if (req.user.role === 'user' && submission.user_id !== req.user.id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot view other users\' submissions.' });
  }

  const details = db.prepare(`
    SELECT sd.*, tg.subtask_id as group_subtask_id, tg.score as group_score
    FROM submission_details sd
    LEFT JOIN test_groups tg ON sd.group_id = tg.id
    WHERE sd.submission_id = ?
    ORDER BY COALESCE(sd.group_id, 0), sd.id
  `).all(submission.id);

  const testGroups = db.prepare('SELECT id, subtask_id, score FROM test_groups WHERE problem_id = ? ORDER BY id').all(submission.problem_id);

  const files = db.prepare('SELECT filename, content FROM submission_files WHERE submission_id = ? ORDER BY id').all(submission.id);
  const canViewCode = req.user.role !== 'user' || submission.user_id === req.user.id;

  res.json({
    ...submission,
    source_code: canViewCode ? submission.source_code : '[HIDDEN]',
    details,
    test_groups: testGroups,
    files: canViewCode ? files : (files.map(f => ({ filename: f.filename, content: '[HIDDEN]' })))
  });
});

// 根据语言推断默认主文件名
function defaultFilename(language) {
  const map = { c: 'main.c', cpp: 'main.cpp', python3: 'main.py', java: 'Main.java', javascript: 'main.js' };
  return map[language] || 'main.txt';
}

router.post('/', requireAuth, rateLimit, async (req, res) => {
  const { problem_id, language, source_code, code, answer_data, files, virtual_contest_id } = req.body;

  if (!problem_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id is required.' });
  }
  if (!language) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'language is required.' });
  }

  if (req.user.role !== 'su' && !req.user.submit_lock_exempt) {
    const pending = db.prepare("SELECT id FROM submissions WHERE user_id = ? AND status IN ('pending_review','pending','running','compiling','judging') LIMIT 1").get(req.user.id);
    if (pending) {
      return res.status(429).json({ code: 4, reason: 'ERR_SUBMIT_LIMIT_EXCEEDED', message: '您有尚未完成的提交，请等待评测完成后再提交。' });
    }
  }

  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(problem_id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }

  // 功能9：虚拟比赛提交校验
  if (virtual_contest_id) {
    const vc = db.prepare('SELECT * FROM virtual_contests WHERE id = ?').get(virtual_contest_id);
    if (!vc) {
      return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Virtual contest not found.' });
    }
    if (vc.user_id !== req.user.id) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '无权向他人虚拟比赛提交。' });
    }
    if (new Date(vc.end_time).getTime() < Date.now()) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '虚拟比赛已结束，无法提交。' });
    }
    // 题目必须在原比赛的题目列表中
    const inContest = db.prepare('SELECT 1 FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(vc.contest_id, problem_id);
    if (!inContest) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '此题目不在该虚拟比赛中。' });
    }
  }

  // 兼容三种格式：files 数组 / code（旧别名）/ source_code（旧字段）
  let normalizedFiles = [];
  let mainCode = source_code || code || '';
  if (Array.isArray(files) && files.length > 0) {
    normalizedFiles = files.map(f => ({ filename: f.filename || defaultFilename(language), content: f.content || '' }));
    mainCode = normalizedFiles[0].content;
  } else if (mainCode) {
    normalizedFiles = [{ filename: defaultFilename(language), content: mainCode }];
  }

  if (problem.problem_type !== 'submit_answer' && normalizedFiles.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'source_code is required for this problem type.' });
  }

  if (mainCode && mainCode.length > CODE_LENGTH_LIMIT) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `源代码超过 ${CODE_LENGTH_LIMIT} 字符限制。` });
  }

  const allowed = JSON.parse(problem.allowed_languages || '[]');
  if (allowed.length > 0 && !allowed.includes(language)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Language '${language}' is not allowed for this problem.` });
  }

  const langCheck = db.prepare('SELECT id FROM languages WHERE name = ? AND is_enabled = 1').get(language);
  if (!langCheck) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Language '${language}' is not available.` });
  }

  const newId = db.findNextId('submissions');
  db.prepare('INSERT INTO submissions (id, user_id, problem_id, language, source_code, answer_data, status, virtual_contest_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    newId, req.user.id, problem_id, language, mainCode, answer_data || '', 'pending_review', virtual_contest_id || null
  );

  // 写入多文件记录
  if (normalizedFiles.length > 0) {
    const insFile = db.prepare('INSERT INTO submission_files (submission_id, filename, content) VALUES (?, ?, ?)');
    for (const f of normalizedFiles) insFile.run(newId, f.filename, f.content);
  }

  res.status(201).json({
    submission_id: newId,
    message: 'Submission received and queued for judging.'
  });

  if (mainCode && mainCode.length >= 50) {
    reviewCode(mainCode, language).then(result => {
      if (!result.safe) {
        console.log(`[Security] Malicious code detected in submission #${newId} by user #${req.user.id}: ${sanitizeLog(result.reason)}`);
        // D-M4: 仅正则命中 + AI 双重确认才永久封号；仅拦截不封号，避免误伤
        if (result.confirmed) banUserAndRevoke(req.user.id);
        db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(newId);
      } else {
        db.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").run(newId);
        enqueueSubmission(newId);
      }
    }).catch(e => {
      console.error('Async security review error:', sanitizeLog(String(e && e.message)));
      // Fail-Closed: 审查服务异常时不放行，标记 system_error 由管理员处理
      db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(newId);
    });
  } else {
    db.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").run(newId);
    enqueueSubmission(newId);
  }
});

router.get('/:id/detail', requireAuth, (req, res) => {
  const submission = db.prepare(`
    SELECT s.*, u.username, p.title as problem_title, p.time_limit, p.memory_limit
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN problems p ON s.problem_id = p.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }
  if (req.user.role === 'user' && submission.user_id !== req.user.id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Access denied.' });
  }
  const details = db.prepare(`
    SELECT sd.*, tg.subtask_id as group_subtask_id, tg.score as group_score
    FROM submission_details sd
    LEFT JOIN test_groups tg ON sd.group_id = tg.id
    WHERE sd.submission_id = ?
    ORDER BY COALESCE(sd.group_id, 0), sd.id
  `).all(submission.id);
  const testGroups = db.prepare('SELECT id, subtask_id, score FROM test_groups WHERE problem_id = ? ORDER BY id').all(submission.problem_id);
  res.json({ submission, details, test_groups });
});

// 代码 Diff View：返回同用户同题的上一次提交代码 + 当前代码；WA 时附带期望/实际输出
router.get('/:id/diff', requireAuth, (req, res) => {
  const submission = db.prepare('SELECT id, user_id, problem_id, source_code, status FROM submissions WHERE id = ?').get(req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }
  if (req.user.role === 'user' && submission.user_id !== req.user.id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Access denied.' });
  }

  const prev = db.prepare(`
    SELECT id, source_code FROM submissions
    WHERE user_id = ? AND problem_id = ? AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(submission.user_id, submission.problem_id, submission.id);

  const result = {
    prev_id: prev ? prev.id : null,
    prev_code: prev ? prev.source_code : null,
    curr_code: submission.source_code
  };

  // WA 时附带首个 WA 测试点的期望输出 vs 实际输出
  if (submission.status === 'wrong_answer') {
    const waDetail = db.prepare(`
      SELECT sd.stdout, sd.test_case_id, tc.output_data, tc.output_file
      FROM submission_details sd
      LEFT JOIN test_cases tc ON sd.test_case_id = tc.id
      WHERE sd.submission_id = ? AND sd.status = 'wrong_answer'
      ORDER BY sd.id LIMIT 1
    `).get(submission.id);
    if (waDetail) {
      let expected = waDetail.output_data || '';
      if (!expected && waDetail.output_file) {
        try { expected = fs.readFileSync(waDetail.output_file, 'utf8'); } catch {}
      }
      result.expected_output = expected;
      result.actual_output = waDetail.stdout || '';
      result.wa_test_case_id = waDetail.test_case_id;
    }
  }

  res.json(result);
});

router.post('/:id/rejudge', requireAuth, requireRole('teacher'), (req, res) => {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }
  const prevStatus = submission.status;
  db.prepare("UPDATE submissions SET status = 'pending_rejudge', score = 0, time_used = 0, memory_used = 0 WHERE id = ?").run(submission.id);
  db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(submission.id);
  enqueueSubmission(submission.id, prevStatus);
  res.json({ message: 'Submission queued for re-judge.' });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }
  db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(submission.id);
  db.prepare('DELETE FROM submissions WHERE id = ?').run(submission.id);
  res.json({ message: 'Submission deleted.' });
});

module.exports = router;
