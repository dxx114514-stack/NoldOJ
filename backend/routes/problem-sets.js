const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// 列表（公开题单 + 分页）
router.get('/', (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const sizeNum = Math.min(50, Math.max(1, parseInt(size) || 20));
  const offset = (pageNum - 1) * sizeNum;

  const total = db.prepare('SELECT COUNT(*) as c FROM problem_sets WHERE is_public = 1').get().c;
  const items = db.prepare(`
    SELECT ps.id, ps.title, ps.description, ps.creator_id, ps.is_public, ps.created_at,
           u.username as creator_name,
           (SELECT COUNT(*) FROM problem_set_items WHERE set_id = ps.id) as problem_count
    FROM problem_sets ps LEFT JOIN users u ON ps.creator_id = u.id
    WHERE ps.is_public = 1
    ORDER BY ps.id DESC LIMIT ? OFFSET ?
  `).all(sizeNum, offset);

  // 若用户已登录，附带每题单进度
  const userId = req.user ? req.user.id : null;
  const result = items.map(it => {
    if (!userId) return { ...it, solved_count: 0 };
    const solved = db.prepare(`
      SELECT COUNT(*) as c FROM problem_set_progress
      WHERE user_id = ? AND set_id = ? AND solved = 1
    `).get(userId, it.id).c;
    return { ...it, solved_count: solved };
  });

  res.json({ total, page: pageNum, size: sizeNum, problem_sets: result });
});

// 详情（含题目列表 + 当前用户进度）
router.get('/:id', optionalAuth, (req, res) => {
  const ps = db.prepare(`
    SELECT ps.*, u.username as creator_name
    FROM problem_sets ps LEFT JOIN users u ON ps.creator_id = u.id
    WHERE ps.id = ?
  `).get(req.params.id);
  if (!ps) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem set not found.' });
  }
  if (!ps.is_public && (!req.user || !['admin', 'su'].includes(req.user.role)) && req.user?.id !== ps.creator_id) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'This set is private.' });
  }

  const problems = db.prepare(`
    SELECT psi.sort_order, p.id, p.title, p.difficulty,
      EXISTS(SELECT 1 FROM submissions sub WHERE sub.problem_id = p.id AND sub.user_id = ? AND sub.status = 'accepted') as user_accepted
    FROM problem_set_items psi
    JOIN problems p ON psi.problem_id = p.id
    WHERE psi.set_id = ?
    ORDER BY psi.sort_order
  `).all(req.user ? req.user.id : 0, ps.id);

  const userId = req.user ? req.user.id : 0;
  let solvedCount = 0;
  const problemList = problems.map(p => {
    const solved = p.user_accepted > 0 ? 1 : 0;
    if (solved) solvedCount++;
    return { id: p.id, title: p.title, difficulty: p.difficulty, sort_order: p.sort_order, solved };
  });

  res.json({
    ...ps,
    problems: problemList,
    solved_count: solvedCount,
    total_count: problemList.length
  });
});

// 进度查询
router.get('/:id/progress', requireAuth, (req, res) => {
  const ps = db.prepare('SELECT id FROM problem_sets WHERE id = ?').get(req.params.id);
  if (!ps) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem set not found.' });
  }
  const items = db.prepare(`
    SELECT psi.problem_id, COALESCE(p.solved, 0) as solved, p.solved_at
    FROM problem_set_items psi
    LEFT JOIN problem_set_progress p ON p.set_id = psi.set_id AND p.problem_id = psi.problem_id AND p.user_id = ?
    WHERE psi.set_id = ?
    ORDER BY psi.sort_order
  `).all(req.user.id, ps.id);
  const solved = items.filter(i => i.solved).length;
  res.json({ total: items.length, solved, items });
});

// 创建（admin/teacher）
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description = '', is_public = 1, problemIds = [] } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  const result = db.prepare(
    'INSERT INTO problem_sets (title, description, creator_id, is_public) VALUES (?, ?, ?, ?)'
  ).run(title.trim(), description, req.user.id, is_public ? 1 : 0);
  const setId = result.lastInsertRowid;
  if (Array.isArray(problemIds) && problemIds.length > 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO problem_set_items (set_id, problem_id, sort_order) VALUES (?, ?, ?)');
    problemIds.forEach((pid, idx) => ins.run(setId, pid, idx));
  }
  const ps = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(setId);
  res.status(201).json(ps);
});

// 更新（作者或 admin）
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const ps = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(req.params.id);
  if (!ps) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem set not found.' });
  }
  if (req.user.id !== ps.creator_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit others\' problem sets.' });
  }
  const { title, description, is_public } = req.body;
  const updates = [];
  const values = [];
  if (title !== undefined) { updates.push('title = ?'); values.push(title.trim()); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (is_public !== undefined) { updates.push('is_public = ?'); values.push(is_public ? 1 : 0); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(ps.id);
  db.prepare(`UPDATE problem_sets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(ps.id);
  res.json(updated);
});

// 设置题目列表（覆盖式）
router.put('/:id/problems', requireAuth, requireRole('teacher'), (req, res) => {
  const ps = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(req.params.id);
  if (!ps) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem set not found.' });
  }
  if (req.user.id !== ps.creator_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot modify others\' problem sets.' });
  }
  const { problemIds } = req.body;
  if (!Array.isArray(problemIds)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problemIds must be an array.' });
  }
  db.prepare('DELETE FROM problem_set_items WHERE set_id = ?').run(ps.id);
  const ins = db.prepare('INSERT OR IGNORE INTO problem_set_items (set_id, problem_id, sort_order) VALUES (?, ?, ?)');
  problemIds.forEach((pid, idx) => ins.run(ps.id, pid, idx));
  res.json({ message: 'Problem list updated.', count: problemIds.length });
});

// 删除（作者或 admin）
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const ps = db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(req.params.id);
  if (!ps) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem set not found.' });
  }
  if (req.user.id !== ps.creator_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' problem sets.' });
  }
  db.prepare('DELETE FROM problem_set_progress WHERE set_id = ?').run(ps.id);
  db.prepare('DELETE FROM problem_set_items WHERE set_id = ?').run(ps.id);
  db.prepare('DELETE FROM problem_sets WHERE id = ?').run(ps.id);
  res.json({ message: 'Problem set deleted.' });
});

// 标记进度（用户 AC 后由评测系统调用，或前端手动调用）
router.post('/:id/progress/:pid', requireAuth, (req, res) => {
  const ps = db.prepare('SELECT id FROM problem_sets WHERE id = ?').get(req.params.id);
  if (!ps) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem set not found.' });
  }
  const item = db.prepare('SELECT problem_id FROM problem_set_items WHERE set_id = ? AND problem_id = ?').get(ps.id, req.params.pid);
  if (!item) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not in this set.' });
  }
  // 校验用户是否真的 AC
  const ac = db.prepare("SELECT id FROM submissions WHERE user_id = ? AND problem_id = ? AND status = 'accepted' LIMIT 1").get(req.user.id, req.params.pid);
  if (!ac) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'You have not solved this problem.' });
  }
  db.prepare(`
    INSERT INTO problem_set_progress (user_id, set_id, problem_id, solved, solved_at)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(user_id, set_id, problem_id) DO UPDATE SET solved = 1, solved_at = datetime('now')
  `).run(req.user.id, ps.id, req.params.pid);
  res.json({ message: 'Progress recorded.' });
});

module.exports = router;
