const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { canViewUserData } = require('../utils/roles');

const router = express.Router();

function getStatsData(uid) {
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

  return {
    overview: { totalAccepted, totalSubmits, totalProblems, totalFavorites, achievements },
    calendar,
    languages,
    difficulty
  };
}

// 个人数据看板：提交日历 / 语言分布 / 难度分布
// 无 user_id 参数 = 本人；带 user_id 查看他人（受 hide_dashboard 隐私开关约束，admin/su 除外）
router.get('/me/stats', requireAuth, (req, res) => {
  const rawUid = req.query.user_id;
  const targetId = rawUid !== undefined && rawUid !== '' ? parseInt(String(rawUid), 10) : req.user.id;
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid user_id.' });
  }
  const target = db.prepare('SELECT id, hide_dashboard FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (!canViewUserData(req.user, target, 'hide_dashboard')) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已对其它用户隐藏看板。' });
  }
  res.json(getStatsData(targetId));
});

module.exports = router;