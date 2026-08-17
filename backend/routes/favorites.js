const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { canViewUserData } = require('../utils/roles');

const router = express.Router();

// 收藏列表（我的收藏 + 分页）
// 无 user_id 参数 = 本人；带 user_id 查看他人（受 hide_favorites 隐私开关约束，admin/su 除外）
router.get('/', requireAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const rawUid = req.query.user_id;
  const targetId = rawUid !== undefined && rawUid !== '' ? parseInt(String(rawUid), 10) : req.user.id;
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid user_id.' });
  }
  const target = db.prepare('SELECT id, hide_favorites FROM users WHERE id = ?').get(targetId);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (!canViewUserData(req.user, target, 'hide_favorites')) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已对其它用户隐藏收藏。' });
  }
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const total = db.prepare('SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?').get(targetId).c;
  const items = db.prepare(`
    SELECT f.problem_id, p.title, p.difficulty, p.problem_type, f.created_at,
      EXISTS(SELECT 1 FROM submissions s WHERE s.problem_id = p.id AND s.user_id = ? AND s.status = 'accepted') as solved
    FROM user_favorites f
    JOIN problems p ON p.id = f.problem_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, targetId, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, favorites: items });
});

// 检查是否已收藏（批量，ids=1,2,3）
router.get('/status', requireAuth, (req, res) => {
  let ids = String(req.query.ids || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  // R9-10: IN 占位符数量上限（SQLite MAX_VARIABLE_NUMBER 约 999），截断到 500
  if (ids.length > 500) ids = ids.slice(0, 500);
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