const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 个人数据看板：提交日历 / 语言分布 / 难度分布
router.get('/me/stats', requireAuth, (req, res) => {
  const uid = req.user.id;

  // 提交日历：最近 365 天，每天提交数 + AC 数
  const calStart = new Date();
  calStart.setUTCDate(calStart.getUTCDate() - 364);
  const startStr = calStart.toISOString().slice(0, 10);
  const calRows = db.prepare(`
    SELECT substr(created_at, 1, 10) as d,
      COUNT(*) as submits,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as acs
    FROM submissions WHERE user_id = ? AND created_at >= ?
    GROUP BY substr(created_at, 1, 10)
  `).all(uid, startStr);
  const calMap = new Map(calRows.map(r => [r.d, { submits: r.submits, acs: r.acs || 0 }]));
  const calendar = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(calStart);
    d.setUTCDate(calStart.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const v = calMap.get(key);
    calendar.push({ date: key, submits: v ? v.submits : 0, acs: v ? v.acs : 0 });
  }

  // 语言分布：按语言统计提交数与 AC 数
  const langRows = db.prepare(`
    SELECT language,
      COUNT(*) as submits,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as acs
    FROM submissions WHERE user_id = ?
    GROUP BY language ORDER BY submits DESC
  `).all(uid);
  const languages = langRows.map(r => ({ language: r.language, submits: r.submits, acs: r.acs || 0 }));

  // 难度分布：AC 的题目按难度（去重）分布
  const diffRows = db.prepare(`
    SELECT p.difficulty, COUNT(*) as c
    FROM (SELECT DISTINCT problem_id FROM submissions WHERE user_id = ? AND status = 'accepted') ac
    JOIN problems p ON p.id = ac.problem_id
    GROUP BY p.difficulty ORDER BY p.difficulty
  `).all(uid);
  const difficulty = diffRows.map(r => ({ difficulty: r.difficulty, count: r.c }));

  // 概览
  const totalAccepted = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND status = 'accepted'").get(uid).c;
  const totalSubmits = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ?').get(uid).c;
  const totalProblems = db.prepare("SELECT COUNT(DISTINCT problem_id) as c FROM submissions WHERE user_id = ? AND status = 'accepted'").get(uid).c;
  const totalFavorites = db.prepare('SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?').get(uid).c;
  const achievements = db.prepare('SELECT COUNT(*) as c FROM user_achievements WHERE user_id = ?').get(uid).c;

  res.json({
    overview: { totalAccepted, totalSubmits, totalProblems, totalFavorites, achievements },
    calendar,
    languages,
    difficulty
  });
});

module.exports = router;