const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { requireAuth, requireRole, getOnlineUsers, removeOnlineUser } = require('../middleware/auth');

const router = express.Router();

router.get('/online', requireAuth, requireRole('admin'), (req, res) => {
  const users = getOnlineUsers(5 * 60 * 1000);
  res.json({ total: users.length, users });
});

router.get('/rating', (req, res) => {
  const { page = 1, limit = 50, show_hidden = '' } = req.query;
  const pageNum1 = Math.max(1, parseInt(page) || 1);
  const limitNum1 = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum1 - 1) * limitNum1;
  let where = 'WHERE hide_rating = 0';
  if (show_hidden === '1' && req.user && ['admin', 'su'].includes(req.user.role)) {
    where = '';
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get().c;
  const users = db.prepare(`
    SELECT id, username, nickname, role, rating, created_at
    FROM users ${where} ORDER BY rating DESC, created_at ASC LIMIT ? OFFSET ?
  `).all(limitNum1, offset);
  res.json({ total, page: pageNum1, limit: limitNum1, users });
});

// 公开用户资料 API（所有人可访问）
router.get('/:id/profile', (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, role, signature, bio, rating, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  res.json(user);
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, role, signature, bio, rating, preferred_language, submit_lock_exempt, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// 功能9：我的虚拟比赛列表
router.get('/me/virtual-contests', requireAuth, (req, res) => {
  const { myVirtualContests } = require('./virtual-contests');
  myVirtualContests(req, res);
});

router.put('/me', requireAuth, (req, res) => {
  const { nickname, signature, bio, hide_rating, preferred_language } = req.body;
  const updates = [];
  const values = [];
  if (nickname !== undefined) { updates.push('nickname = ?'); values.push(nickname); }
  if (signature !== undefined) { updates.push('signature = ?'); values.push(signature.slice(0, 1000)); }
  if (bio !== undefined) { updates.push('bio = ?'); values.push(bio); }
  if (hide_rating !== undefined) { updates.push('hide_rating = ?'); values.push(hide_rating ? 1 : 0); }
  if (preferred_language !== undefined) { updates.push('preferred_language = ?'); values.push(preferred_language); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  updates.push("updated_at = datetime('now')");
  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const user = db.prepare('SELECT id, username, nickname, role, signature, bio, rating, hide_rating, preferred_language FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

router.put('/:id/rating', requireAuth, requireRole('su'), (req, res) => {
  const { rating } = req.body;
  if (typeof rating !== 'number') {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'rating must be a number.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  db.prepare('UPDATE users SET rating = ?, updated_at = datetime(\'now\') WHERE id = ?').run(Math.round(rating), req.params.id);
  res.json({ message: 'Rating updated.', rating: Math.round(rating) });
});

router.put('/:id/hide-rating', requireAuth, requireRole('admin'), (req, res) => {
  const { hide_rating } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const hierarchy = ['user', 'teacher', 'admin', 'su'];
  const myLevel = hierarchy.indexOf(req.user.role);
  const targetLevel = hierarchy.indexOf(target.role);
  if (targetLevel > myLevel || (targetLevel === myLevel && String(target.id) !== String(req.user.id))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot modify a user with equal or higher privileges (except yourself).' });
  }
  db.prepare('UPDATE users SET hide_rating = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hide_rating ? 1 : 0, req.params.id);
  res.json({ message: 'Hide rating updated.', hide_rating: hide_rating ? 1 : 0 });
});

router.put('/:id/submit-lock-exempt', requireAuth, requireRole('su'), (req, res) => {
  const { submit_lock_exempt } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  db.prepare("UPDATE users SET submit_lock_exempt = ?, updated_at = datetime('now') WHERE id = ?").run(submit_lock_exempt ? 1 : 0, req.params.id);
  res.json({ message: 'Submit lock exempt updated.', submit_lock_exempt: submit_lock_exempt ? 1 : 0 });
});

router.put('/:id/upload-limits', requireAuth, requireRole('su'), (req, res) => {
  const { max_file_size, max_storage } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const fileSize = (typeof max_file_size === 'number' && max_file_size >= 0) ? Math.floor(max_file_size) : 0;
  const storage = (typeof max_storage === 'number' && max_storage >= 0) ? Math.floor(max_storage) : 0;
  db.prepare("UPDATE users SET max_file_size = ?, max_storage = ?, updated_at = datetime('now') WHERE id = ?").run(fileSize, storage, req.params.id);
  res.json({ message: 'Upload limits updated.', max_file_size: fileSize, max_storage: storage });
});

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const { page = 1, limit = 50, search = '', role = '' } = req.query;
  const pageNum2 = Math.max(1, parseInt(page) || 1);
  const limitNum2 = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum2 - 1) * limitNum2;
  let where = 'WHERE 1=1';
  const params = [];
  if (search) {
    where += ' AND (username LIKE ? OR nickname LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where += ' AND role = ?';
    params.push(role);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(...params).c;
  const users = db.prepare(`SELECT id, username, nickname, email, role, banned, rating, hide_rating, created_at FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limitNum2, offset);
  res.json({ total, page: pageNum2, limit: limitNum2, users });
});

router.get('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, role, banned, created_at, updated_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  res.json(user);
});

router.put('/:id/role', requireAuth, requireRole('su'), (req, res) => {
  const { role } = req.body;
  const validRoles = ['user', 'teacher', 'admin', 'su'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid role.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (user.id === req.user.id) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot change your own role.' });
  }
  const hierarchy = ['user', 'teacher', 'admin', 'su'];
  if (user.role === 'su' && role !== 'su') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot demote another super administrator.' });
  }
  db.prepare('UPDATE users SET role = ?, updated_at = datetime(\'now\') WHERE id = ?').run(role, req.params.id);
  res.json({ message: 'Role updated.', user: { id: user.id, username: user.username, role } });
});

router.post('/:id/ban', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const hierarchy = ['user', 'teacher', 'admin', 'su'];
  const banMyLevel = hierarchy.indexOf(req.user.role);
  const banTargetLevel = hierarchy.indexOf(target.role);
  if (banTargetLevel > banMyLevel || (banTargetLevel === banMyLevel && String(target.id) !== String(req.user.id))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot ban a user with equal or higher privileges (except yourself).' });
  }
  db.prepare('UPDATE users SET banned = 1, updated_at = datetime(\'now\') WHERE id = ?').run(target.id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(target.id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
  removeOnlineUser(target.id);
  res.json({ message: 'User banned and logged out.' });
});

router.post('/:id/unban', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  db.prepare('UPDATE users SET banned = 0, updated_at = datetime(\'now\') WHERE id = ?').run(target.id);
  res.json({ message: 'User unbanned.' });
});

router.post('/:id/force-logout', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const hierarchy = ['user', 'teacher', 'admin', 'su'];
  const flMyLevel = hierarchy.indexOf(req.user.role);
  const flTargetLevel = hierarchy.indexOf(target.role);
  if (flTargetLevel > flMyLevel || (flTargetLevel === flMyLevel && String(target.id) !== String(req.user.id))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot force logout a user with equal or higher privileges (except yourself).' });
  }
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(target.id);
  removeOnlineUser(target.id);
  res.json({ message: 'User forced to logout.' });
});

router.post('/:id/reset-password', requireAuth, requireRole('su'), (req, res) => {
  const { new_password } = req.body;
  // 与注册/改密一致的强度要求: 至少 8 位，含字母，且含数字或符号
  if (!new_password || new_password.length < 8 || !/[a-zA-Z]/.test(new_password) || !(/\d/.test(new_password) || /[^a-zA-Z0-9]/.test(new_password))) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, req.params.id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id);
  res.json({ message: 'Password reset successfully.' });
});

router.post('/sudo-login', requireAuth, requireRole('su'), (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'user_id is required.' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  // 封禁用户不允许 sudo 登录，防止绕过封禁
  if (target.banned) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '该用户已被封禁，无法登录。' });
  }
  const jwt = require('jsonwebtoken');
  const config = require('../config/config');
  const token = jwt.sign({ userId: target.id }, config.jwt.accessSecret, { expiresIn: config.jwt.accessExpiry });
  res.json({ access_token: token, user: { id: target.id, username: target.username, nickname: target.nickname, role: target.role } });
});

router.post('/', requireAuth, requireRole('su'), (req, res) => {
  const { username, password, nickname, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }
  const validRoles = ['user', 'teacher', 'admin', 'su'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid role.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username already exists.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const newId = db.findNextId('users');
  db.prepare('INSERT INTO users (id, username, password_hash, nickname, role) VALUES (?, ?, ?, ?, ?)').run(newId, username, hash, nickname || username, role || 'user');
  res.status(201).json({ message: 'User created.', user: { id: newId, username, role: role || 'user' } });
});

router.delete('/:id', requireAuth, requireRole('su'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (target.role === 'su') {
    const suCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'su'").get().c;
    if (suCount <= 1) {
      return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot delete the last super administrator.' });
    }
  }
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ message: 'User deleted.' });
});

module.exports = router;
