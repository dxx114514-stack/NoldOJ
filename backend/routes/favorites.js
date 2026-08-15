const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');

const router = express.Router();

// 收藏列表（我的收藏 + 分页）
router.get('/', requireAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const total = db.prepare('SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?').get(req.user.id).c;
  const items = db.prepare(`
    SELECT f.problem_id, p.title, p.difficulty, p.problem_type, f.created_at,
      EXISTS(SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ? AND s.status = 'accepted') as solved
    FROM user_favorites f
    JOIN problems p ON p.id = f.problem_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, req.user.id, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, favorites: items });
});

// 检查是否已收藏（批量，ids=1,2,3）
router.get('/status', requireAuth, (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  if (ids.length === 0) return res.json({ favorites: {} });
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT problem_id FROM user_favorites WHERE user_id = ? AND problem_id IN (${placeholders})`)
    .all(req.user.id, ...ids);
  const fav = {};
  rows.forEach(r => fav[r.problem_id] = true);
  res.json({ favorites: fav });
});

// 收藏
router.post('/:problemId', requireAuth, (req, res) => {
  const pid = parseInt(req.params.problemId, 10);
  if (!Number.isInteger(pid)) return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid problem id.' });
  const p = db.prepare('SELECT id FROM problems WHERE id = ?').get(pid);
  if (!p) return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  db.prepare('INSERT OR IGNORE INTO user_favorites (user_id, problem_id) VALUES (?, ?)').run(req.user.id, pid);
  res.json({ favorited: true });
});

// 取消收藏
router.delete('/:problemId', requireAuth, (req, res) => {
  const pid = parseInt(req.params.problemId, 10);
  db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND problem_id = ?').run(req.user.id, pid);
  res.json({ favorited: false });
});

module.exports = router;