const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 全部成就 + 我的解锁状态
router.get('/', requireAuth, (req, res) => {
  const all = db.prepare('SELECT * FROM achievements ORDER BY id').all();
  const mineRows = db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?').all(req.user.id);
  const mineMap = new Map(mineRows.map(r => [r.achievement_id, r.unlocked_at]));
  const total = all.length;
  const unlocked = mineRows.length;
  res.json({
    total,
    unlocked,
    achievements: all.map(a => ({ ...a, unlocked: mineMap.has(a.id), unlocked_at: mineMap.get(a.id) || null }))
  });
});

module.exports = router;