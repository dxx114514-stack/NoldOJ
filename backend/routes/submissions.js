const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');
const { enqueueSubmission } = require('../services/judge');
const { reviewCode, CODE_LENGTH_LIMIT } = require('../services/security');
const config = require('../config/config');

const router = express.Router();
const rateLimit = createRateLimit(config.rateLimit.submissions);

router.get('/', requireAuth, (req, res) => {
  const { page = 1, limit = 50, user_id, problem_id, status } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE 1=1';
  const params = [];

  if (user_id) {
    where += ' AND s.user_id = ?';
    params.push(parseInt(user_id));
  } else if (req.user.role === 'user') {
    where += ' AND s.user_id = ?';
    params.push(req.user.id);
  }

  if (problem_id) {
    where += ' AND s.problem_id = ?';
    params.push(parseInt(problem_id));
  }
  if (status) {
    where += ' AND s.status = ?';
    params.push(status);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM submissions s ${where}`).get(...params).c;
  const submissions = db.prepare(`
    SELECT s.id, s.user_id, s.problem_id, s.language, s.status, s.score, s.time_used, s.memory_used, s.created_at,
           u.username, p.title as problem_title
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN problems p ON s.problem_id = p.id
    ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ total, page: parseInt(page), limit: parseInt(limit), submissions });
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

  res.json({
    ...submission,
    source_code: req.user.role !== 'user' || submission.user_id === req.user.id ? submission.source_code : '[HIDDEN]',
    details,
    test_groups: testGroups
  });
});

router.post('/', requireAuth, rateLimit, async (req, res) => {
  const { problem_id, language, source_code, answer_data } = req.body;

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

  if (problem.problem_type !== 'submit_answer' && !source_code) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'source_code is required for this problem type.' });
  }

  if (source_code && source_code.length > CODE_LENGTH_LIMIT) {
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
  db.prepare('INSERT INTO submissions (id, user_id, problem_id, language, source_code, answer_data, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    newId, req.user.id, problem_id, language, source_code || '', answer_data || '', 'pending_review'
  );

  res.status(201).json({
    submission_id: newId,
    message: 'Submission received and queued for judging.'
  });

  if (source_code && source_code.length >= 50) {
    reviewCode(source_code, language).then(result => {
      if (!result.safe) {
        console.log(`[Security] Malicious code detected in submission #${newId} by user #${req.user.id}: ${result.reason}`);
        db.prepare('UPDATE users SET banned = 1, updated_at = datetime(\'now\') WHERE id = ?').run(req.user.id);
        db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(req.user.id);
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
        db.prepare("UPDATE submissions SET status = 'system_error' WHERE id = ?").run(newId);
      } else {
        db.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").run(newId);
        enqueueSubmission(newId);
      }
    }).catch(e => {
      console.error('Async security review error:', e.message);
      db.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").run(newId);
      enqueueSubmission(newId);
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

router.post('/:id/rejudge', requireAuth, requireRole('teacher'), (req, res) => {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }
  db.prepare("UPDATE submissions SET status = 'pending_rejudge', score = 0, time_used = 0, memory_used = 0 WHERE id = ?").run(submission.id);
  db.prepare('DELETE FROM submission_details WHERE submission_id = ?').run(submission.id);
  enqueueSubmission(submission.id);
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
