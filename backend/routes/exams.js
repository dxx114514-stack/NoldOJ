const express = require('express');
const AdmZip = require('adm-zip');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { sanitizeText } = require('../utils/securityHelpers');
const examProgram = require('../services/examProgram');
const {
  normalizeExamTime, validateExamWindow, examWindowState,
  fromSqliteUtc, toSqliteUtc, resolveFreeze, checkExamWindow
} = require('../utils/examWindow');

const router = express.Router();

const EXAM_PROBLEM_ID_BASE = db.EXAM_PROBLEM_ID_BASE;
// 编程题测试数据上限（防滥用：单点 512KB、总数 500、ZIP base64 7MB）
const MAX_TC_CHARS = 512 * 1024;
const MAX_TC_COUNT = 500;
const MAX_ZIP_B64_CHARS = Math.ceil(7 * 1024 * 1024 * 4 / 3) + 4;

// 试卷内编程题的题目 id 分配（EXAM_PROBLEM_ID_BASE 起的独立号段）
function nextExamProblemId() {
  const row = db.prepare('SELECT MAX(id) as m FROM problems WHERE id >= ?').get(EXAM_PROBLEM_ID_BASE);
  return Math.max(EXAM_PROBLEM_ID_BASE, (row?.m || 0) + 1);
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function enabledLanguageNames() {
  return new Set(db.prepare('SELECT name FROM languages WHERE is_enabled = 1').all().map(r => r.name));
}

// 解析编程题测试数据：inline 数组与 ZIP base64（*.in + *.out/*.ans，允许一层子目录=subtask）合并返回
function parseProgramTestcases(p) {
  const cases = [];
  if (Array.isArray(p.testcases)) {
    for (const tc of p.testcases) {
      if (!tc || typeof tc !== 'object') continue;
      const input = String(tc.input ?? '');
      const output = String(tc.output ?? '');
      if (input.length > MAX_TC_CHARS || output.length > MAX_TC_CHARS) {
        throw new Error('单个测试点输入/输出不能超过 512KB。');
      }
      cases.push({
        input,
        output,
        score: Math.max(0, Number(tc.score) || 0),
        subtask: tc.subtask ? String(tc.subtask).replace(/[<>:"/\\|?*]/g, '_').slice(0, 64) : ''
      });
    }
  }
  if (p.testcase_zip_base64) {
    const b64 = String(p.testcase_zip_base64);
    if (b64.length > MAX_ZIP_B64_CHARS) {
      throw new Error('测试数据 ZIP 过大（base64 上限约 7MB）。');
    }
    const zip = new AdmZip(Buffer.from(b64, 'base64'));
    const entries = zip.getEntries();
    if (entries.length > 1000) throw new Error('ZIP 条目过多（上限 1000）。');
    let totalBytes = 0;
    const pairs = {};
    const addPair = (name, ext, data, subtask) => {
      const key = subtask + '|' + name;
      if (!pairs[key]) pairs[key] = { subtask, name, input: '', output: '' };
      if (ext === 'in') pairs[key].input = data;
      else pairs[key].output = data;
    };
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      totalBytes += entry.header.size;
      if (totalBytes > 32 * 1024 * 1024) throw new Error('ZIP 解压后总大小超过 32MB。');
      const entryPath = entry.entryName.replace(/\\/g, '/');
      const parts = entryPath.split('/').filter(Boolean);
      if (parts.length === 0 || parts.length > 2) continue;
      // Zip Slip / 脏文件名防御（与题库 testdata-zip 同款）
      if (parts.some(s => s === '..' || s === '.') || !parts.every(s => /^[\w.\-\u4e00-\u9fa5]+$/.test(s))) continue;
      const fileName = parts[parts.length - 1];
      const m = fileName.match(/^(.+)\.(in|out|ans)$/i);
      if (!m) continue;
      const subtask = parts.length === 2 ? parts[0].slice(0, 64) : '';
      const ext = m[2].toLowerCase() === 'in' ? 'in' : 'out';
      let data;
      try { data = entry.getData().toString('utf8'); } catch { continue; }
      if (data.length > MAX_TC_CHARS) throw new Error(`ZIP 内 ${fileName} 超过 512KB。`);
      addPair(m[1].replace(/^\.+/, ''), ext, data, subtask);
    }
    for (const pair of Object.values(pairs)) {
      if (!pair.input && !pair.output) continue;
      cases.push({ input: pair.input, output: pair.output, score: 1, subtask: pair.subtask });
    }
  }
  return cases;
}

// 校验并归一化 program 题目负载（不落库）；失败抛 Error（由调用方转 400）
function normalizeProgramQuestion(q) {
  const p = q.problem;
  if (!p || typeof p !== 'object') {
    throw new Error('编程题缺少 problem 配置。');
  }
  const testcases = parseProgramTestcases(p);
  if (testcases.length === 0) {
    throw new Error('编程题至少需要 1 个测试点（inline 输入输出对或 ZIP 上传）。');
  }
  if (testcases.length > MAX_TC_COUNT) {
    throw new Error(`测试点数量不能超过 ${MAX_TC_COUNT}。`);
  }
  const langs = enabledLanguageNames();
  const allowed = (Array.isArray(p.allowed_languages) ? p.allowed_languages : [])
    .filter(l => typeof l === 'string' && langs.has(l)).slice(0, 20);
  return {
    question_type: 'program',
    title: sanitizeText(q.title || ''),
    score: Math.max(0, Number(q.score) || 0),
    sort_order: q.sort_order,
    problem_id: q.problem_id ? Number(q.problem_id) : null,
    problem: {
      description: sanitizeText(p.description || ''),
      background: sanitizeText(p.background || ''),
      input_desc: sanitizeText(p.input_desc || ''),
      output_desc: sanitizeText(p.output_desc || ''),
      hint: sanitizeText(p.hint || ''),
      time_limit: clampInt(p.time_limit, 1, 10000, 1000),
      memory_limit: clampInt(p.memory_limit, 1, 1048576, 256),
      allowed_languages: JSON.stringify(allowed)
    },
    testcases
  };
}

// 创建或更新试卷内编程题的 problems 行 + 测试数据（inline 落库，不写磁盘）
function upsertProgramProblem(examId, existingProblemId, norm, creatorId) {
  let problemId = existingProblemId;
  if (problemId) {
    const cur = db.prepare('SELECT id FROM problems WHERE id = ? AND exam_id = ?').get(problemId, examId);
    if (!cur) throw new Error('problem_id 不属于该试卷。');
    db.prepare(`
      UPDATE problems SET title = ?, description = ?, background = ?, input_desc = ?, output_desc = ?, hint = ?,
        time_limit = ?, memory_limit = ?, allowed_languages = ?, updated_at = datetime('now')
      WHERE id = ? AND exam_id = ?
    `).run(
      norm.title || 'Program', norm.problem.description, norm.problem.background,
      norm.problem.input_desc, norm.problem.output_desc, norm.problem.hint,
      norm.problem.time_limit, norm.problem.memory_limit, norm.problem.allowed_languages,
      problemId, examId
    );
  } else {
    problemId = nextExamProblemId();
    db.prepare(`
      INSERT INTO problems (id, title, description, background, input_desc, output_desc, hint, time_limit, memory_limit,
        problem_type, compare_mode, allowed_languages, subtask_mode, is_public, is_hidden, created_by, exam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'traditional', 'text_strict', ?, 'simple', 0, 1, ?, ?)
    `).run(
      problemId, norm.title || 'Program', norm.problem.description, norm.problem.background,
      norm.problem.input_desc, norm.problem.output_desc, norm.problem.hint,
      norm.problem.time_limit, norm.problem.memory_limit, norm.problem.allowed_languages,
      creatorId, examId
    );
  }

  // 全量替换测试数据；带 subtask 的测试点建组（组分 = 组内测试点分之和）
  db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(problemId);
  db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(problemId);
  const groupIds = new Map();
  const insGroup = db.prepare('INSERT INTO test_groups (problem_id, subtask_id, score, aggregator, dependency) VALUES (?, ?, ?, ?, ?)');
  const insCase = db.prepare('INSERT INTO test_cases (problem_id, group_id, input_data, output_data, score, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  norm.testcases.forEach((tc, i) => {
    let groupId = null;
    if (tc.subtask) {
      if (!groupIds.has(tc.subtask)) {
        const g = insGroup.run(problemId, tc.subtask, 0, 'sum', '[]');
        groupIds.set(tc.subtask, g.lastInsertRowid);
      }
      groupId = groupIds.get(tc.subtask);
    }
    insCase.run(problemId, groupId, tc.input, tc.output, tc.score, i + 1);
  });
  // 组分回填 = 组内测试点分之和（判题端分组计分的展示口径）
  for (const gid of groupIds.values()) {
    const sum = db.prepare('SELECT COALESCE(SUM(score), 0) as s FROM test_cases WHERE group_id = ?').get(gid).s;
    db.prepare('UPDATE test_groups SET score = ? WHERE id = ?').run(sum, gid);
  }
  return problemId;
}

// 题目变更后的汇总刷新：同步 program 答题满分/折算分，并重算各次提交总分与试卷总分
function refreshExamScores(examId) {
  const answers = db.prepare(`
    SELECT ea.id as answer_id, ea.code_submission_id, ea.grading_status, eq.id as question_id, eq.question_type
    FROM exam_answers ea
    JOIN exam_submissions es ON es.id = ea.submission_id
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE es.exam_id = ? AND eq.question_type = 'program'
  `).all(examId);
  const updAnswer = db.prepare('UPDATE exam_answers SET score = ?, max_score = ?, is_correct = ?, grading_status = ?, graded_at = datetime(\'now\') WHERE id = ?');
  for (const a of answers) {
    const q = db.prepare('SELECT * FROM exam_questions WHERE id = ?').get(a.question_id);
    if (!q) continue;
    if (a.code_submission_id) {
      const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(a.code_submission_id);
      const r = examProgram.scoreFromSubmission(q, sub);
      if (r.pending) continue; // 判题中：保持 pending，判完由 judge 回填
      updAnswer.run(r.score, q.score, r.correct ? 1 : 0, 'ai_graded', a.answer_id);
      continue;
    }
    db.prepare('UPDATE exam_answers SET max_score = ?, score = 0, is_correct = 0 WHERE id = ?').run(q.score, a.answer_id);
  }
  const subs = db.prepare('SELECT id FROM exam_submissions WHERE exam_id = ?').all(examId);
  for (const s of subs) examProgram.recomputeExamSubmission(s.id);
  db.prepare(`
    UPDATE exam_submissions SET max_score = (SELECT COALESCE(SUM(score), 0) FROM exam_questions WHERE exam_id = ?)
    WHERE exam_id = ?
  `).run(examId, examId);
}

// 获取试卷列表
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 20, 100);

  let where = '';
  const params = [];

  if (!req.user || !['teacher', 'admin', 'su'].includes(req.user.role)) {
    where = 'WHERE e.is_public = 1 AND e.is_hidden = 0';
  }

  if (search) {
    const cond = "REPLACE(e.title, ' ', '') LIKE ?";
    where = where ? `${where} AND (${cond})` : `WHERE (${cond})`;
    params.push('%' + search.replace(/\s+/g, '') + '%');
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM exams e ${where}`).get(...params).c;

  const exams = db.prepare(`
    SELECT e.*, u.username as creator_name,
      (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) as question_count,
      (SELECT COUNT(*) FROM exam_submissions WHERE exam_id = e.id) as submission_count
    FROM exams e LEFT JOIN users u ON e.creator_id = u.id
    ${where}
    ORDER BY e.id DESC LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, exams });
});

// 获取试卷详情
router.get('/:id', optionalAuth, (req, res) => {
  const exam = db.prepare(`
    SELECT e.*, u.username as creator_name
    FROM exams e LEFT JOIN users u ON e.creator_id = u.id
    WHERE e.id = ?
  `).get(req.params.id);

  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  if (exam.is_hidden && !(req.user && ['teacher', 'admin', 'su'].includes(req.user.role))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }

  // 时间窗：开考前对考生不可见（教师/管理员可预览）；结束后仍可查看结果
  if (examWindowState(exam) === 'not_started' &&
      !(req.user && ['teacher', 'admin', 'su'].includes(req.user.role))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '考试尚未开始。' });
  }

  // 获取题目（不含答案，除非是教师+且有查询参数 show_answers=true）
  const showAnswers = req.query.show_answers === 'true' && req.user && ['teacher', 'admin', 'su'].includes(req.user.role);

  let questions;
  if (showAnswers) {
    questions = db.prepare(`
      SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY sort_order
    `).all(exam.id);
  } else {
    questions = db.prepare(`
      SELECT id, exam_id, question_type, title, options, score, sort_order, is_subjective, problem_id
      FROM exam_questions WHERE exam_id = ? ORDER BY sort_order
    `).all(exam.id);
  }

  // 如果已登录，获取用户提交记录
  let userSubmission = null;
  let currentAttempt = 1;
  if (req.user) {
    const attemptCount = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(exam.id, req.user.id).c;
    currentAttempt = attemptCount + 1;
    userSubmission = db.prepare(`
      SELECT * FROM exam_submissions WHERE exam_id = ? AND user_id = ?
      ORDER BY submitted_at DESC LIMIT 1
    `).get(exam.id, req.user.id);
  }

  // 编程题：下发内部题目配置；教师 show_answers 时附题目全文与测试数据；考生附当前 attempt 的提交状态
  const programQuestions = questions.filter(q => q.question_type === 'program');
  if (programQuestions.length > 0) {
    for (const q of programQuestions) {
      const p = q.problem_id ? db.prepare('SELECT * FROM problems WHERE id = ?').get(q.problem_id) : null;
      const program = {
        problem_id: q.problem_id || null,
        description: p ? p.description : '',
        background: p ? p.background : '',
        input_desc: p ? p.input_desc : '',
        output_desc: p ? p.output_desc : '',
        hint: p ? p.hint : '',
        time_limit: p ? p.time_limit : 1000,
        memory_limit: p ? p.memory_limit : 256,
        allowed_languages: (() => {
          try { return JSON.parse(p ? p.allowed_languages : '[]'); } catch { return []; }
        })()
      };
      if (showAnswers && q.problem_id) {
        program.groups = db.prepare('SELECT subtask_id, score FROM test_groups WHERE problem_id = ? ORDER BY id').all(q.problem_id);
        program.testcases = db.prepare(`
          SELECT tc.input_data as input, tc.output_data as output, tc.score, tc.sort_order, IFNULL(g.subtask_id, '') as subtask
          FROM test_cases tc LEFT JOIN test_groups g ON g.id = tc.group_id
          WHERE tc.problem_id = ? ORDER BY tc.sort_order, tc.id
        `).all(q.problem_id);
        program.problem = p;
      }
      if (req.user && q.problem_id) {
        const mine = db.prepare(`
          SELECT id, status, score, created_at FROM submissions
          WHERE exam_id = ? AND user_id = ? AND problem_id = ? AND exam_attempt = ?
          ORDER BY id DESC LIMIT 1
        `).get(exam.id, req.user.id, q.problem_id, currentAttempt);
        program.attempt_no = currentAttempt;
        program.my_submission = mine || null;
      }
      q.program = program;
    }
  }

  res.json({ ...exam, questions, user_submission: userSubmission, current_attempt: currentAttempt });
});

// 排行榜：完成门槛 + 封榜过滤 + 每人最佳一次尝试排名（仅考生入榜）
router.get('/:id/leaderboard', optionalAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }
  const staff = !!req.user && ['teacher', 'admin', 'su'].includes(req.user.role);
  if (exam.is_hidden && !staff) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }
  if (!exam.leaderboard_enabled) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Leaderboard not found.' });
  }
  // 完成门槛：有交卷记录=已完成；未完成者（含匿名）仅在教师放开时可看
  const finished = req.user
    ? db.prepare('SELECT 1 as x FROM exam_submissions WHERE exam_id = ? AND user_id = ? LIMIT 1').get(exam.id, req.user.id)
    : null;
  if (!staff && !finished && !exam.leaderboard_view_incomplete) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '完成考试后可查看排行榜。' });
  }

  const fz = resolveFreeze(exam);

  // 封榜时只统计封榜时刻前的交卷；教师/管理员不入榜
  let sql = `
    SELECT es.user_id, es.total_score, es.max_score, es.submitted_at, es.status, u.username, u.nickname,
      (SELECT COUNT(*) FROM exam_submissions x WHERE x.exam_id = es.exam_id AND x.user_id = es.user_id) as attempts
    FROM exam_submissions es JOIN users u ON u.id = es.user_id
    WHERE es.exam_id = ? AND u.role = 'user'`;
  const params = [exam.id];
  if (fz.frozen && fz.freeze_at) {
    sql += ' AND es.submitted_at <= ?';
    params.push(toSqliteUtc(fz.freeze_at));
  }
  const rows = db.prepare(sql).all(...params);

  // 每人取最佳一次：分数降序，同分先交卷者靠前
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.user_id);
    if (!cur || r.total_score > cur.total_score ||
        (r.total_score === cur.total_score && String(r.submitted_at) < String(cur.submitted_at))) {
      best.set(r.user_id, r);
    }
  }
  const sorted = [...best.values()].sort((a, b) =>
    (b.total_score - a.total_score) || String(a.submitted_at).localeCompare(String(b.submitted_at))
  );

  const toIso = (s) => {
    const d = fromSqliteUtc(s);
    return d ? d.toISOString() : null;
  };
  const entryOf = (r, idx) => ({
    rank: idx + 1,
    user_id: r.user_id,
    username: r.username,
    nickname: r.nickname || '',
    total_score: r.total_score,
    max_score: r.max_score,
    attempts: r.attempts,
    status: r.status,
    submitted_at: toIso(r.submitted_at)
  });

  const limit = clampInt(req.query.limit, 1, 200, 100);
  const leaderboard = sorted.slice(0, limit).map(entryOf);
  let my = null;
  if (req.user) {
    const idx = sorted.findIndex(r => r.user_id === req.user.id);
    if (idx >= 0) my = entryOf(sorted[idx], idx);
  }

  res.json({
    exam_id: exam.id,
    title: exam.title,
    total_score: exam.total_score,
    start_time: exam.start_time || null,
    end_time: exam.end_time || null,
    freeze_minutes: exam.freeze_minutes || 0,
    frozen: !!fz.frozen,
    freeze_at: fz.freeze_at,
    freeze_source: fz.source,
    manual_frozen: !!exam.manual_frozen,
    unfrozen: !!exam.unfrozen,
    view_incomplete: !!exam.leaderboard_view_incomplete,
    leaderboard,
    my
  });
});

// 创建试卷
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading,
    start_time, end_time, freeze_minutes, leaderboard_enabled, leaderboard_view_incomplete, questions } = req.body;

  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title is required.' });
  }

  // 时间窗校验（须同时设置或同时留空）
  let st;
  let et;
  try {
    st = normalizeExamTime(start_time);
    et = normalizeExamTime(end_time);
    validateExamWindow(st, et);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  // 题目预校验（编程题在此解析 ZIP/inline 测试数据），失败直接 400，避免建出半套试卷
  let normalizedQuestions = [];
  if (Array.isArray(questions) && questions.length > 0) {
    try {
      normalizedQuestions = questions.map(q => (q && q.question_type === 'program') ? normalizeProgramQuestion(q) : q);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }
  }

  const result = db.prepare(`
    INSERT INTO exams (title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading,
      start_time, end_time, freeze_minutes, leaderboard_enabled, leaderboard_view_incomplete, creator_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sanitizeText(title).trim(),
    sanitizeText(description || ''),
    time_limit || 0,
    pass_score || 0,
    max_attempts || 1,
    show_answer ? 1 : 0,
    is_public !== false ? 1 : 0,
    is_hidden ? 1 : 0,
    allow_ai_grading !== false ? 1 : 0,
    st,
    et,
    clampInt(freeze_minutes, 0, 10080, 0),
    leaderboard_enabled === false ? 0 : 1,
    leaderboard_view_incomplete ? 1 : 0,
    req.user.id
  );

  const examId = result.lastInsertRowid;

  // 创建题目
  if (normalizedQuestions.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective, ai_grading_prompt, problem_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalScore = 0;
    try {
      for (let i = 0; i < normalizedQuestions.length; i++) {
        const q = normalizedQuestions[i];
        let problemId = null;
        if (q.question_type === 'program') {
          problemId = upsertProgramProblem(examId, null, q, req.user.id);
        }
        stmt.run(
          examId,
          q.question_type,
          q.question_type === 'program' ? q.title : sanitizeText(q.title),
          q.question_type === 'program' ? '[]' : JSON.stringify(q.options || []),
          q.correct_answer || '',
          q.score || 0,
          q.sort_order || i,
          q.is_subjective ? 1 : 0,
          q.ai_grading_prompt || '',
          problemId
        );
        totalScore += q.score || 0;
      }
    } catch (e) {
      // 补偿回滚：删除已建的考试题与内部题目，避免留下半套试卷
      db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM problems WHERE exam_id = ?').run(examId);
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }

    // 更新总分
    db.prepare('UPDATE exams SET total_score = ? WHERE id = ?').run(totalScore, examId);
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  res.status(201).json(exam);
});

// 更新试卷
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  const { title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading, questions } = req.body;
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

  // 时间窗：先算出生效值并校验，失败不动库（未提供则沿用原值）
  let effStart = exam.start_time;
  let effEnd = exam.end_time;
  try {
    if (has('start_time')) effStart = normalizeExamTime(req.body.start_time);
    if (has('end_time')) effEnd = normalizeExamTime(req.body.end_time);
    validateExamWindow(effStart, effEnd);
  } catch (e) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
  }

  db.prepare(`
    UPDATE exams SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      time_limit = COALESCE(?, time_limit),
      pass_score = COALESCE(?, pass_score),
      max_attempts = COALESCE(?, max_attempts),
      show_answer = COALESCE(?, show_answer),
      is_public = COALESCE(?, is_public),
      is_hidden = COALESCE(?, is_hidden),
      allow_ai_grading = COALESCE(?, allow_ai_grading),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title !== undefined ? sanitizeText(title).trim() : null,
    description !== undefined ? sanitizeText(description) : null,
    time_limit !== undefined ? time_limit : null,
    pass_score !== undefined ? pass_score : null,
    max_attempts !== undefined ? max_attempts : null,
    show_answer !== undefined ? (show_answer ? 1 : 0) : null,
    is_public !== undefined ? (is_public ? 1 : 0) : null,
    is_hidden !== undefined ? (is_hidden ? 1 : 0) : null,
    allow_ai_grading !== undefined ? (allow_ai_grading ? 1 : 0) : null,
    req.params.id
  );

  // 时间窗 / 排行榜设置 / 手动封解榜状态机：
  // 封榜动作（manual_frozen=1）强制解除手动解榜标记；解榜动作清空快照锚点
  const newManualFrozen = has('manual_frozen') ? (req.body.manual_frozen ? 1 : 0) : (exam.manual_frozen || 0);
  let newUnfrozen = has('unfrozen') ? (req.body.unfrozen ? 1 : 0) : (exam.unfrozen || 0);
  if (newManualFrozen) newUnfrozen = 0;
  let newFrozenAt = exam.manual_frozen_at || null;
  if (has('manual_frozen')) {
    newFrozenAt = newManualFrozen ? toSqliteUtc(Date.now()) : null;
  }
  db.prepare(`
    UPDATE exams SET
      start_time = ?, end_time = ?, freeze_minutes = ?,
      leaderboard_enabled = ?, leaderboard_view_incomplete = ?,
      manual_frozen = ?, manual_frozen_at = ?, unfrozen = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    effStart,
    effEnd,
    has('freeze_minutes') ? clampInt(req.body.freeze_minutes, 0, 10080, 0) : (exam.freeze_minutes || 0),
    has('leaderboard_enabled') ? (req.body.leaderboard_enabled ? 1 : 0) : (exam.leaderboard_enabled || 1),
    has('leaderboard_view_incomplete') ? (req.body.leaderboard_view_incomplete ? 1 : 0) : (exam.leaderboard_view_incomplete || 0),
    newManualFrozen,
    newFrozenAt,
    newUnfrozen,
    req.params.id
  );

  // 如果提供了题目：非编程题全量替换；编程题按 problem_id diff（保留已判答题记录）
  if (Array.isArray(questions)) {
    // 预校验（编程题解析测试数据 + problem_id 归属），失败不动库
    let normalized;
    try {
      normalized = questions.map(q => (q && q.question_type === 'program') ? normalizeProgramQuestion(q) : q);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }
    for (const q of normalized) {
      if (q.question_type === 'program' && q.problem_id) {
        const owned = db.prepare('SELECT id FROM problems WHERE id = ? AND exam_id = ?').get(q.problem_id, req.params.id);
        if (!owned) {
          return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id 不属于该试卷。' });
        }
      }
    }

    const existing = db.prepare('SELECT * FROM exam_questions WHERE exam_id = ?').all(req.params.id);
    const existingByPid = new Map();
    for (const x of existing) {
      if (x.question_type === 'program' && x.problem_id) existingByPid.set(x.problem_id, x);
    }

    try {
      // 1) 非编程题：先删后插（保持原有全量替换语义，旧答题记录随之级联清理）
      db.prepare("DELETE FROM exam_questions WHERE exam_id = ? AND question_type != 'program'").run(req.params.id);

      const stmt = db.prepare(`
        INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective, ai_grading_prompt, problem_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updStmt = db.prepare(`
        UPDATE exam_questions SET title = ?, score = ?, sort_order = ? WHERE id = ?
      `);

      let totalScore = 0;
      const keptPids = new Set();

      for (let i = 0; i < normalized.length; i++) {
        const q = normalized[i];
        if (q.question_type === 'program') {
          const matched = q.problem_id ? existingByPid.get(q.problem_id) : null;
          const problemId = upsertProgramProblem(
            req.params.id,
            matched ? matched.problem_id : q.problem_id,
            q,
            exam.creator_id
          );
          keptPids.add(problemId);
          if (matched) {
            updStmt.run(q.title, q.score, q.sort_order ?? matched.sort_order ?? i, matched.id);
          } else {
            stmt.run(req.params.id, 'program', q.title, '[]', '', q.score, q.sort_order || i, 0, '', problemId);
          }
        } else {
          stmt.run(
            req.params.id,
            q.question_type,
            sanitizeText(q.title),
            JSON.stringify(q.options || []),
            q.correct_answer || '',
            q.score || 0,
            q.sort_order || i,
            q.is_subjective ? 1 : 0,
            q.ai_grading_prompt || '',
            null
          );
        }
        totalScore += q.score || 0;
      }

      // 2) 未出现在新列表中的编程题：连同内部题目一起删除（级联清理测试数据/代码提交/答题记录）
      for (const x of existing) {
        if (x.question_type !== 'program') continue;
        if (x.problem_id && keptPids.has(x.problem_id)) continue;
        if (x.problem_id) {
          db.prepare('DELETE FROM problems WHERE id = ? AND exam_id = ?').run(x.problem_id, req.params.id);
        } else {
          db.prepare('DELETE FROM exam_questions WHERE id = ?').run(x.id);
        }
      }

      db.prepare('UPDATE exams SET total_score = ?, updated_at = datetime(\'now\') WHERE id = ?').run(totalScore, req.params.id);
    } catch (e) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: e.message });
    }

    // 题分/测试数据可能已变：同步 program 答题满分与折算分，重算各次提交
    refreshExamScores(req.params.id);
  }

  const updated = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// 删除试卷
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(req.params.id);
  db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(req.params.id);
  // 试卷内编程题（级联清理其代码提交/测试数据/答题记录；须先于 exam 行删除）
  db.prepare('DELETE FROM problems WHERE exam_id = ?').run(req.params.id);
  db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);

  res.json({ message: 'Exam deleted.' });
});

// 规范化答案（支持判断题 T/F、对/错、1/0、正确/错误）
function normalizeAnswer(type, val) {
  const s = String(val ?? '').trim().toLowerCase();
  if (type === 'true_false') {
    if (['true', 't', '1', '正确', '对', 'v', '√', 'yes', 'y'].includes(s)) return 'true';
    if (['false', 'f', '0', '错误', '错', 'x', '×', 'no', 'n'].includes(s)) return 'false';
  }
  return s;
}

// 提交试卷
router.post('/:id/submit', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  if (!exam.is_public) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
  }
  if (exam.is_hidden && !['teacher', 'admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }

  // 时间窗门禁：开考前/结束后禁止交卷（教师/管理员放行）
  const winMsg = checkExamWindow(exam, req.user);
  if (winMsg) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: winMsg });
  }

  // 检查尝试次数；当前尝试号 = 已提交次数 + 1（程序题代码按此号归属）
  const attemptCount = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(exam.id, req.user.id).c;
  if (exam.max_attempts > 0 && attemptCount >= exam.max_attempts) {
    return res.status(400).json({ code: 1, reason: 'ERR_MAX_ATTEMPTS', message: '已达到最大尝试次数。' });
  }
  const attempt = attemptCount + 1;

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers is required.' });
  }

  // 获取题目
  const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id = ?').all(exam.id);
  const questionMap = {};
  questions.forEach(q => { questionMap[q.id] = q; });

  // 归集答题：客户端条目 + 所有程序题（服务端兜底补全；程序题分数一律服务端折算，防伪造）
  const entries = [];
  const seen = new Set();
  for (const a of answers) {
    if (!a || seen.has(a.question_id)) continue;
    seen.add(a.question_id);
    entries.push(a);
  }
  for (const q of questions) {
    if (q.question_type === 'program' && !seen.has(q.id)) {
      entries.push({ question_id: q.id });
      seen.add(q.id);
    }
  }
  if (entries.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers is required.' });
  }

  // 程序题：取当前尝试下该生该题的代码提交
  const programSubs = new Map();
  for (const q of questions) {
    if (q.question_type !== 'program') continue;
    const sub = db.prepare(`
      SELECT * FROM submissions
      WHERE exam_id = ? AND user_id = ? AND problem_id = ? AND exam_attempt = ?
      ORDER BY id DESC LIMIT 1
    `).get(exam.id, req.user.id, q.problem_id, attempt);
    if (sub) programSubs.set(q.id, sub);
  }

  let result;
  db.exec('BEGIN');
  try {
    // 创建提交记录
    const submissionResult = db.prepare(`
      INSERT INTO exam_submissions (exam_id, user_id, status, max_score)
      VALUES (?, ?, 'submitted', ?)
    `).run(exam.id, req.user.id, exam.total_score);

    const submissionId = submissionResult.lastInsertRowid;

    // 处理每道题的答案
    let totalScore = 0;
    let hasSubjective = false;
    let hasPendingProgram = false;

    const answerStmt = db.prepare(`
      INSERT INTO exam_answers (submission_id, question_id, answer, score, max_score, is_correct, is_subjective, grading_status, code_submission_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of entries) {
      const question = questionMap[a.question_id];
      if (!question) continue;

      if (question.question_type === 'program') {
        const sub = programSubs.get(question.id) || null;
        const r = examProgram.scoreFromSubmission(question, sub);
        let score = 0;
        let correct = 0;
        let gradingStatus;
        if (r.pending) {
          hasPendingProgram = true;
          gradingStatus = 'pending';
        } else {
          score = r.score;
          correct = r.correct ? 1 : 0;
          gradingStatus = 'ai_graded';
        }
        totalScore += score;
        answerStmt.run(
          submissionId, question.id, sub ? String(sub.id) : '', score, question.score,
          correct, 0, gradingStatus, sub ? sub.id : null
        );
        continue;
      }

      const isSubjective = question.question_type === 'long_answer' ||
                           (question.question_type === 'fill_blank' && question.is_subjective);

      let score = 0;
      let isCorrect = 0;
      let gradingStatus;

      if (!isSubjective) {
        // 客观题自动评分（规范化对比）
        const userAnswer = normalizeAnswer(question.question_type, a.answer);
        const correctAnswer = normalizeAnswer(question.question_type, question.correct_answer);

        if (question.question_type === 'choice' || question.question_type === 'true_false' || question.question_type === 'fill_blank') {
          if (userAnswer === correctAnswer) {
            score = question.score;
            isCorrect = 1;
          }
        }
        gradingStatus = 'ai_graded';
      } else {
        // 主观题：等待评分
        hasSubjective = true;
        gradingStatus = 'pending';
      }

      totalScore += score;
      answerStmt.run(submissionId, question.id, a.answer || '', score, question.score, isCorrect, isSubjective ? 1 : 0, gradingStatus, null);
    }

    // 更新提交状态：有主观题或程序题判题中 → grading，否则 graded
    const finalStatus = (hasSubjective || hasPendingProgram) ? 'grading' : 'graded';
    db.prepare('UPDATE exam_submissions SET total_score = ?, status = ?, ai_graded = ? WHERE id = ?')
      .run(totalScore, finalStatus, finalStatus === 'graded' ? 1 : 0, submissionId);

    db.exec('COMMIT');

    result = {
      submission_id: submissionId,
      status: finalStatus,
      total_score: totalScore,
      max_score: exam.total_score,
      has_subjective: hasSubjective,
      has_pending_program: hasPendingProgram
    };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[EXAM] submit failed:', e && e.message);
    return res.status(500).json({ code: 1, reason: 'ERR_INTERNAL', message: 'Submit failed.' });
  }

  res.status(201).json(result);
});

// 获取提交详情
router.get('/:id/submission/:sid', requireAuth, (req, res) => {
  const submission = db.prepare(`
    SELECT es.*, e.title as exam_title, e.show_answer, e.total_score as exam_total_score
    FROM exam_submissions es
    JOIN exams e ON e.id = es.exam_id
    WHERE es.id = ? AND es.user_id = ?
  `).get(req.params.sid, req.user.id);

  if (!submission) {
    // 检查是否是教师+查看他人提交
    if (req.user && ['teacher', 'admin', 'su'].includes(req.user.role)) {
      const sub = db.prepare(`
        SELECT es.*, e.title as exam_title, e.show_answer, e.total_score as exam_total_score
        FROM exam_submissions es
        JOIN exams e ON e.id = es.exam_id
        WHERE es.id = ?
      `).get(req.params.sid);
      if (!sub) {
        return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
      }
      // 教师可以查看任何提交
      const answers = db.prepare(`
        SELECT ea.*, eq.title as question_title, eq.question_type, eq.options, eq.correct_answer, eq.is_subjective
        FROM exam_answers ea
        JOIN exam_questions eq ON eq.id = ea.question_id
        WHERE ea.submission_id = ?
        ORDER BY eq.sort_order
      `).all(req.params.sid);

      return res.json({ ...sub, answers });
    }
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  const answers = db.prepare(`
    SELECT ea.*, eq.title as question_title, eq.question_type, eq.options, eq.correct_answer, eq.is_subjective
    FROM exam_answers ea
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE ea.submission_id = ?
    ORDER BY eq.sort_order
  `).all(req.params.sid);

  // 如果不显示答案，隐藏正确答案
  if (!submission.show_answer) {
    answers.forEach(a => {
      delete a.correct_answer;
    });
  }

  res.json({ ...submission, answers });
});

// 获取某试卷的所有提交（教师用）
router.get('/:id/submissions', requireAuth, requireRole('teacher'), (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);

  const total = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ?').get(req.params.id).c;

  const submissions = db.prepare(`
    SELECT es.*, u.username, u.nickname
    FROM exam_submissions es
    JOIN users u ON u.id = es.user_id
    WHERE es.exam_id = ?
    ORDER BY es.submitted_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, submissions });
});

// 批改试卷（教师或 AI）
router.post('/:id/grade/:sid', requireAuth, requireRole('teacher'), (req, res) => {
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE id = ? AND exam_id = ?').get(req.params.sid, req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers array is required.' });
  }

  let totalScore = 0;
  const updateStmt = db.prepare(`
    UPDATE exam_answers SET score = ?, is_correct = CASE WHEN ? >= max_score THEN 1 ELSE 0 END, human_comment = ?, grading_status = 'human_graded', graded_at = datetime('now')
    WHERE id = ?
  `);

  // 获取当前所有答案（包含客观题得分）
  const allAnswers = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ?').all(req.params.sid);
  const answerMap = {};
  allAnswers.forEach(a => { answerMap[a.id] = a; });

  // 先计算客观题得分
  allAnswers.forEach(a => {
    if (!a.is_subjective) {
      totalScore += a.score;
    }
  });

  // 更新主观题得分
  answers.forEach(a => {
    const answer = answerMap[a.answer_id];
    if (!answer || !answer.is_subjective) return;

    const s = Number(a.score) || 0;
    updateStmt.run(s, s, a.comment || '', a.answer_id);
    totalScore += s;
  });

  // 更新提交记录
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = 'graded', human_graded = 1, graded_at = datetime('now'), graded_by = ?
    WHERE id = ?
  `).run(totalScore, req.user.id, req.params.sid);

  res.json({ total_score: totalScore, status: 'graded' });
});

// AI 批改试卷
router.post('/:id/ai-grade/:sid', requireAuth, requireRole('teacher'), async (req, res) => {
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE id = ? AND exam_id = ?').get(req.params.sid, req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam.allow_ai_grading) {
    return res.status(400).json({ code: 1, reason: 'ERR_AI_GRADING_DISABLED', message: '此试卷未启用 AI 评分。' });
  }

  // 检查 AI 是否启用
  const config = require('../config/config');
  const { aiEnabled, aiChat } = require('../services/aiClient');
  const aiCfg = config.ai?.hint || config.ai?.security;
  if (!aiEnabled(aiCfg)) {
    return res.status(503).json({ code: 5, reason: 'ERR_AI_UNAVAILABLE', message: 'AI 服务未启用。' });
  }

  // 获取待评分的主观题答案
  const pendingAnswers = db.prepare(`
    SELECT ea.*, eq.title as question_title, eq.question_type, eq.correct_answer, eq.ai_grading_prompt
    FROM exam_answers ea
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE ea.submission_id = ? AND ea.is_subjective = 1 AND ea.grading_status = 'pending'
  `).all(req.params.sid);

  if (pendingAnswers.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_NO_PENDING', message: '没有待评分的主观题。' });
  }

  for (const answer of pendingAnswers) {
    try {
      const prompt = answer.ai_grading_prompt ||
        `你是一位严格的老师。请根据参考答案评判学生的回答。

题目：${answer.question_title}
参考答案：${answer.correct_answer || '无'}
学生回答：${answer.answer}
满分：${answer.max_score}分

请给出评分（0-${answer.max_score}）和简短评语。
格式：{"score": 分数, "comment": "评语"}`;

      const aiResult = await aiChat('你是一位严格的计算机与算法试卷批改教师。请按照要求客观公正评判。', prompt, { cfg: aiCfg });
      let score = 0;
      let comment = '';

      try {
        // 尝试解析 JSON
        const parsed = JSON.parse(aiResult);
        score = Math.min(Math.max(0, parsed.score || 0), answer.max_score);
        comment = parsed.comment || '';
      } catch {
        // 如果解析失败，尝试从文本中提取分数
        const scoreMatch = aiResult.match(/(\d+)/);
        score = scoreMatch ? Math.min(parseInt(scoreMatch[1]), answer.max_score) : 0;
        comment = aiResult;
      }

      db.prepare(`
        UPDATE exam_answers SET score = ?, is_correct = CASE WHEN ? >= max_score THEN 1 ELSE 0 END, ai_comment = ?, grading_status = 'ai_graded', graded_at = datetime('now')
        WHERE id = ?
      `).run(score, score, comment, answer.id);
    } catch (err) {
      console.error('[AI Grading] Error:', err.message);
    }
  }

  // 更新提交状态
  const totalScore = db.prepare('SELECT SUM(score) as total FROM exam_answers WHERE submission_id = ?').get(req.params.sid).total || 0;
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = 'graded', ai_graded = 1, graded_at = datetime('now'), graded_by = ?
    WHERE id = ?
  `).run(totalScore, req.user.id, req.params.sid);

  res.json({ total_score: totalScore, status: 'graded' });
});

module.exports = router;