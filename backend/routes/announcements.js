const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// 列表（公开读取）支持 type 过滤与分页，置顶排前
router.get('/', (req, res) => {
  const { type = 'global', page = 1, size = 10 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const sizeNum = Math.min(50, Math.max(1, parseInt(size) || 10));
  const offset = (pageNum - 1) * sizeNum;

  let where = 'WHERE a.type = ?';
  const params = [type];
  if (type === 'contest') {
    // 比赛公告由专用接口返回，此处仅返回全局公告
    where = 'WHERE a.type = ?';
    params[0] = 'global';
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM announcements a ${where}`).get(...params).c;
  const items = db.prepare(`
    SELECT a.id, a.title, a.type, a.contest_id, a.pinned, a.author_id, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    ${where} ORDER BY a.pinned DESC, a.id DESC LIMIT ? OFFSET ?
  `).all(...params, sizeNum, offset);

  res.json({ total, page: pageNum, size: sizeNum, announcements: items });
});

// 详情
router.get('/:id', (req, res) => {
  const a = db.prepare(`
    SELECT a.*, u.username, u.nickname
    FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!a) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Announcement not found.' });
  }
  res.json(a);
});

// 创建（admin/teacher）
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, content, type = 'global', contest_id = null, pinned = 0 } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Content is required.' });
  }
  if (type === 'contest' && !contest_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'contest_id is required for contest announcements.' });
  }
  const result = db.prepare(
    'INSERT INTO announcements (title, content, type, contest_id, pinned, author_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title.trim(), content.trim(), type, type === 'contest' ? contest_id : null, pinned ? 1 : 0, req.user.id);
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(ann);
});

// 更新（作者或 admin）
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!ann) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Announcement not found.' });
  }
  if (req.user.id !== ann.author_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit others\' announcements.' });
  }
  const { title, content, type, contest_id, pinned } = req.body;
  const updates = [];
  const values = [];
  if (title !== undefined) { updates.push('title = ?'); values.push(title.trim()); }
  if (content !== undefined) { updates.push('content = ?'); values.push(content.trim()); }
  if (type !== undefined) {
    updates.push('type = ?'); values.push(type);
    updates.push('contest_id = ?'); values.push(type === 'contest' ? contest_id : null);
  }
  if (pinned !== undefined) { updates.push('pinned = ?'); values.push(pinned ? 1 : 0); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  updates.push("updated_at = datetime('now')");
  values.push(ann.id);
  db.prepare(`UPDATE announcements SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM announcements WHERE id = ?').get(ann.id);
  res.json(updated);
});

// 删除（作者或 admin）
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!ann) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Announcement not found.' });
  }
  if (req.user.id !== ann.author_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' announcements.' });
  }
  db.prepare('DELETE FROM announcements WHERE id = ?').run(ann.id);
  res.json({ message: 'Announcement deleted.' });
});

module.exports = router;
