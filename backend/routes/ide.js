const express = require('express');
const db = require('../database/db');
const { optionalAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');
const config = require('../config/config');
const { reviewCode, CODE_LENGTH_LIMIT } = require('../services/security');
const { enqueueIdeRun } = require('../services/ideJudge');

const router = express.Router();
const rateLimit = createRateLimit(config.rateLimit.ideRun);

router.get('/languages', (req, res) => {
  const languages = db.prepare('SELECT name, display_name, extension FROM languages WHERE is_enabled = 1').all();
  res.json(languages);
});

router.post('/review', optionalAuth, async (req, res) => {
  const { language, source_code } = req.body;
  if (!language || !source_code || source_code.length < 50) {
    return res.json({ safe: true });
  }
  try {
    const result = await reviewCode(source_code, language);
    if (!result.safe && req.user) {
      db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(req.user.id);
      db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(req.user.id);
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
    }
    res.json(result);
  } catch (e) {
    res.json({ safe: true });
  }
});

router.post('/run', optionalAuth, rateLimit, async (req, res) => {
  const { language, source_code, stdin } = req.body;

  if (!language || !source_code) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'language and source_code are required.' });
  }
  if (source_code.length > CODE_LENGTH_LIMIT) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Source code too large. Maximum ${CODE_LENGTH_LIMIT} characters.` });
  }

  const langCheck = db.prepare('SELECT id FROM languages WHERE name = ? AND is_enabled = 1').get(language);
  if (!langCheck) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Language '${language}' is not available.` });
  }

  if (source_code.length >= 50) {
    const securityReview = await reviewCode(source_code, language);
    if (!securityReview.safe) {
      if (req.user) {
        db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(req.user.id);
        db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(req.user.id);
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
      }
      return res.status(403).json({
        code: 6,
        reason: 'ERR_FORBIDDEN',
        message: `代码安全审查未通过: ${securityReview.reason}。威胁等级: ${securityReview.threat_level}。账号已被封禁。`
      });
    }
  }

  const newId = db.prepare('INSERT INTO ide_runs (user_id, language, source_code, stdin, status) VALUES (?, ?, ?, ?, ?)').run(
    req.user ? req.user.id : null, language, source_code, stdin || '', 'pending'
  ).lastInsertRowid;

  enqueueIdeRun(newId);

  res.status(201).json({ run_id: newId, status: 'pending' });
});

router.get('/run/:id', optionalAuth, (req, res) => {
  const run = db.prepare('SELECT * FROM ide_runs WHERE id = ?').get(req.params.id);
  if (!run) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Run not found.' });
  }
  // 越权防护: 未登录用户不能读取；他人运行结果不能读取（管理员除外）
  if (!req.user) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Authentication required.' });
  }
  if (run.user_id !== req.user.id && req.user.role !== 'su') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Access denied.' });
  }
  res.json({
    id: run.id,
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    compile_output: run.compile_output,
    exit_code: run.exit_code,
    time_used: run.time_used,
    memory_used: run.memory_used || 0,
    language: run.language,
    created_at: run.created_at
  });
});

module.exports = router;
