const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');

const router = express.Router();

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 10000;

// 讨论详情（含回复，最多两层楼中楼）
router.get('/:id', optionalAuth, (req, res) => {
  const disc = db.prepare(`
    SELECT d.*, u.username, u.nickname, u.role
    FROM discussions d LEFT JOIN users u ON d.author_id = u.id
    WHERE d.id = ?
  `).get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  // 比赛讨论锁定的处理
  if (disc.contest_id) {
    const contest = db.prepare('SELECT end_time FROM contests WHERE id = ?').get(disc.contest_id);
    if (contest && new Date(contest.end_time).getTime() > Date.now() && !disc.is_official) {
      // 比赛进行中且非官方公告，普通用户不可见
      if (!req.user || !['admin', 'su', 'teacher'].includes(req.user.role)) {
        return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '比赛进行中暂不开放讨论。' });
      }
    }
  }
  // 一级回复
  const replies = db.prepare(`
    SELECT r.id, r.discussion_id, r.parent_id, r.content, r.created_at,
           u.username, u.nickname, u.role, u.id as user_id
    FROM discussion_replies r LEFT JOIN users u ON r.author_id = u.id
    WHERE r.discussion_id = ? AND r.parent_id IS NULL
    ORDER BY r.id ASC
  `).all(disc.id);
  // 二级回复
  const replyIds = replies.map(r => r.id);
  let children = [];
  if (replyIds.length > 0) {
    const placeholders = replyIds.map(() => '?').join(',');
    children = db.prepare(`
      SELECT r.id, r.discussion_id, r.parent_id, r.content, r.created_at,
             u.username, u.nickname, u.role, u.id as user_id
      FROM discussion_replies r LEFT JOIN users u ON r.author_id = u.id
      WHERE r.parent_id IN (${placeholders})
      ORDER BY r.id ASC
    `).all(...replyIds);
  }
  // 组织树形结构: 用 Map 按 parent_id 分组，O(n) 而非 O(n*m)
  const childrenByParent = new Map();
  for (const c of children) {
    const list = childrenByParent.get(c.parent_id) || [];
    list.push(c);
    childrenByParent.set(c.parent_id, list);
  }
  const tree = replies.map(r => ({ ...r, children: childrenByParent.get(r.id) || [] }));
  res.json({ ...disc, replies: tree });
});

// 创建讨论（登录用户）
router.post('/', requireAuth, (req, res) => {
  const { problem_id, contest_id, title, content } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  if (String(title).length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Title must be at most ${MAX_TITLE_LENGTH} characters.` });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Content is required.' });
  }
  if (String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Content must be at most ${MAX_CONTENT_LENGTH} characters.` });
  }
  if (!problem_id && !contest_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id or contest_id is required.' });
  }
  // 比赛进行中：禁止非官方讨论
  if (contest_id) {
    const contest = db.prepare('SELECT end_time FROM contests WHERE id = ?').get(contest_id);
    if (contest && new Date(contest.end_time).getTime() > Date.now()) {
      if (!['admin', 'su', 'teacher'].includes(req.user.role)) {
        return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '比赛进行中暂不开放讨论。' });
      }
    }
  }
  const isOfficial = ['admin', 'su', 'teacher'].includes(req.user.role) ? (req.body.is_official ? 1 : 0) : 0;
  const result = db.prepare(
    'INSERT INTO discussions (problem_id, contest_id, title, content, author_id, is_official) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(problem_id || null, contest_id || null, title.trim(), content.trim(), req.user.id, isOfficial);
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(disc);
});

// 更新讨论（作者或 admin）
router.put('/:id', requireAuth, (req, res) => {
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  if (req.user.id !== disc.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit others\' discussions.' });
  }
  const { title, content } = req.body;
  if (title !== undefined && String(title).length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Title must be at most ${MAX_TITLE_LENGTH} characters.` });
  }
  if (content !== undefined && String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Content must be at most ${MAX_CONTENT_LENGTH} characters.` });
  }
  const u = buildUpdates([
    { key: 'title', value: title !== undefined ? title.trim() : undefined },
    { key: 'content', value: content !== undefined ? content.trim() : undefined }
  ], { touchUpdatedAt: true });
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  db.prepare(`UPDATE discussions SET ${u.clause} WHERE id = ?`).run(...u.values, disc.id);
  const updated = db.prepare('SELECT * FROM discussions WHERE id = ?').get(disc.id);
  res.json(updated);
});

// 删除讨论（作者或 admin）
router.delete('/:id', requireAuth, (req, res) => {
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  if (req.user.id !== disc.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' discussions.' });
  }
  db.prepare('DELETE FROM discussion_replies WHERE discussion_id = ?').run(disc.id);
  db.prepare('DELETE FROM discussions WHERE id = ?').run(disc.id);
  res.json({ message: 'Discussion deleted.' });
});

// 创建回复（登录用户）
router.post('/:id/replies', requireAuth, (req, res) => {
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  if (disc.locked && !['admin', 'su', 'teacher'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该讨论已锁定。' });
  }
  const { content, parent_id } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Content is required.' });
  }
  if (String(content).length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Content must be at most ${MAX_CONTENT_LENGTH} characters.` });
  }
  // 限制最多两层楼中楼
  let parentId = null;
  if (parent_id) {
    const parent = db.prepare('SELECT id, parent_id FROM discussion_replies WHERE id = ? AND discussion_id = ?').get(parent_id, disc.id);
    if (!parent) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Parent reply not found.' });
    }
    if (parent.parent_id) {
      // 二级回复的回复，挂在原一级回复下
      parentId = parent.parent_id;
    } else {
      parentId = parent.id;
    }
  }
  const result = db.prepare(
    'INSERT INTO discussion_replies (discussion_id, parent_id, content, author_id) VALUES (?, ?, ?, ?)'
  ).run(disc.id, parentId, content.trim(), req.user.id);
  const reply = db.prepare(`
    SELECT r.*, u.username, u.nickname, u.role
    FROM discussion_replies r LEFT JOIN users u ON r.author_id = u.id
    WHERE r.id = ?
  `).get(result.lastInsertRowid);
  res.status(201).json(reply);
});

// 删除回复（作者或 admin）
router.delete('/:id/replies/:rid', requireAuth, (req, res) => {
  const reply = db.prepare('SELECT * FROM discussion_replies WHERE id = ? AND discussion_id = ?').get(req.params.rid, req.params.id);
  if (!reply) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Reply not found.' });
  }
  if (req.user.id !== reply.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete others\' replies.' });
  }
  // 级联删除该回复的所有直接子回复
  db.prepare('DELETE FROM discussion_replies WHERE parent_id = ?').run(reply.id);
  db.prepare('DELETE FROM discussion_replies WHERE id = ?').run(reply.id);
  res.json({ message: 'Reply deleted.' });
});

// 置顶/取消置顶（admin/teacher）
router.put('/:id/pin', requireAuth, requireRole('teacher'), (req, res) => {
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  const pinned = req.body.pinned ? 1 : 0;
  db.prepare("UPDATE discussions SET pinned = ?, updated_at = datetime('now') WHERE id = ?").run(pinned, disc.id);
  const updated = db.prepare('SELECT * FROM discussions WHERE id = ?').get(disc.id);
  res.json(updated);
});

// 锁定/解锁（admin/teacher）
router.put('/:id/lock', requireAuth, requireRole('teacher'), (req, res) => {
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  const locked = req.body.locked ? 1 : 0;
  db.prepare("UPDATE discussions SET locked = ?, updated_at = datetime('now') WHERE id = ?").run(locked, disc.id);
  const updated = db.prepare('SELECT * FROM discussions WHERE id = ?').get(disc.id);
  res.json(updated);
});

// 设置/取消官方标记（admin/teacher）
router.put('/:id/official', requireAuth, requireRole('teacher'), (req, res) => {
  const disc = db.prepare('SELECT * FROM discussions WHERE id = ?').get(req.params.id);
  if (!disc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Discussion not found.' });
  }
  const is_official = req.body.is_official ? 1 : 0;
  db.prepare("UPDATE discussions SET is_official = ?, updated_at = datetime('now') WHERE id = ?").run(is_official, disc.id);
  const updated = db.prepare('SELECT * FROM discussions WHERE id = ?').get(disc.id);
  res.json(updated);
});

module.exports = router;
