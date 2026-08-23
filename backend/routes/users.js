const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const config = require('../config/config');
const { requireAuth, requireRole, optionalAuth, getOnlineUsers, removeOnlineUser, ONLINE_TTL_MS } = require('../middleware/auth');
const { sanitizeLog, sanitizeText } = require('../utils/securityHelpers');
const { parsePageLimit } = require('../utils/pagination');
const { isValidRole, canManage, isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { generateAccessToken } = require('../utils/tokens');
const { isStrongPassword } = require('../utils/validation');

const router = express.Router();

// 结构化审计日志: 记录敏感管理操作（操作者 → 目标），脱敏后输出
function audit(operator, action, target) {
  const t = target ? `${sanitizeLog(target.username)}(id=${target.id})` : 'n/a';
  console.log(`[AUDIT] ${sanitizeLog(action)}: operator=${sanitizeLog(operator.username)}(id=${operator.id}) -> target=${t} at ${new Date().toISOString()}`);
}

router.get('/online', requireAuth, requireRole('admin'), (req, res) => {
  const users = getOnlineUsers(ONLINE_TTL_MS);
  res.json({ total: users.length, users });
});

// R12-3: 注册开关查询/热切换 (仅超管)。写在 /:id 之前避免被通配路由吞掉
router.get('/register-enabled', requireAuth, requireRole('su'), (req, res) => {
  res.json({ enabled: config.register.enabled });
});
router.put('/register-enabled', requireAuth, requireRole('su'), (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'enabled 必须为布尔值。' });
  }
  try {
    const content = '# 是否允许访客自行注册 (R12-3)\n# true = 开放注册 / false = 仅管理员创建账号\nREGISTER_ENABLED=' + (enabled ? 'true' : 'false') + '\n';
    fs.writeFileSync(config.register.path, content, 'utf8');
  } catch (err) {
    return res.status(500).json({ code: 2, reason: 'ERR_INTERNAL', message: '写入配置失败: ' + sanitizeLog(String(err.message || err)) });
  }
  config.register.enabled = enabled; // 热更新内存态
  audit(req.user, enabled ? '开启自行注册' : '关闭自行注册', null);
  res.json({ enabled });
});

// 公开排行榜。show_hidden=1 需要登录且 admin/su（optionalAuth 保持公开访问，同时对隐私分支显式认证）
router.get('/rating', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, show_hidden = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE hide_rating = 0';
  if (show_hidden === '1') {
    if (!req.user || !isAdminOrSu(req.user.role)) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'show_hidden requires admin or su role.' });
    }
    where = '';
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get().c;
  const users = db.prepare(`
    SELECT id, username, nickname, role, rating, created_at
    FROM users ${where} ORDER BY rating DESC, created_at ASC LIMIT ? OFFSET ?
  `).all(limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, users });
});

// 公开用户资料 API（所有人可访问）
// 返回隐私开关，供前端决定是否展示成就/看板/收藏入口
router.get('/:id/profile', (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, role, signature, bio, rating, hide_achievements, hide_dashboard, hide_favorites, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  res.json(user);
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, role, signature, bio, rating, preferred_language, submit_lock_exempt, hide_achievements, hide_dashboard, hide_favorites, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// 功能9：我的虚拟比赛列表
router.get('/me/virtual-contests', requireAuth, (req, res) => {
  const { myVirtualContests } = require('./virtual-contests');
  myVirtualContests(req, res);
});

router.put('/me', requireAuth, (req, res) => {
  const { nickname, signature, bio, hide_rating, hide_achievements, hide_dashboard, hide_favorites, preferred_language } = req.body;
  // 10.3: preferred_language 必须是已启用语言名之一，且限长，防止任意值/超长字符串入库
  if (preferred_language !== undefined && preferred_language !== null && preferred_language !== '') {
    const lang = String(preferred_language).slice(0, 32);
    const exists = db.prepare('SELECT name FROM languages WHERE name = ? AND is_enabled = 1').get(lang);
    if (!exists) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'preferred_language 必须是已启用的语言。' });
    }
    if (preferred_language !== lang) req.body.preferred_language = lang;
  }
  const u = buildUpdates([
    { key: 'nickname', value: nickname, transform: v => sanitizeText(String(v ?? '').slice(0, 50)) },
    { key: 'signature', value: signature, transform: v => sanitizeText(String(v ?? '').slice(0, 1000)) },
    { key: 'bio', value: bio, transform: v => sanitizeText(String(v ?? '').slice(0, 100000)) },
    { key: 'hide_rating', value: hide_rating, transform: v => v ? 1 : 0 },
    { key: 'hide_achievements', value: hide_achievements, transform: v => v ? 1 : 0 },
    { key: 'hide_dashboard', value: hide_dashboard, transform: v => v ? 1 : 0 },
    { key: 'hide_favorites', value: hide_favorites, transform: v => v ? 1 : 0 },
    { key: 'preferred_language', value: req.body.preferred_language }
  ], { touchUpdatedAt: true });
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  db.prepare(`UPDATE users SET ${u.clause} WHERE id = ?`).run(...u.values, req.user.id);
  const user = db.prepare('SELECT id, username, nickname, role, signature, bio, rating, hide_rating, hide_achievements, hide_dashboard, hide_favorites, preferred_language FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

router.put('/:id/rating', requireAuth, requireRole('su'), (req, res) => {
  const { rating } = req.body;
  // D-L8: Number.isFinite 拦截 NaN/Infinity（typeof NaN === 'number'）
  if (typeof rating !== 'number' || !Number.isFinite(rating)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'rating must be a finite number.' });
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
  if (!canManage(req.user, target)) {
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
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE 1=1';
  const params = [];
  if (search) {
    // 转义 LIKE 通配符，防止 % _ \ 被当作模式匹配
    const esc = String(search).replace(/[\\%_]/g, m => `\\${m}`);
    where += ' AND (username LIKE ? ESCAPE ? OR nickname LIKE ? ESCAPE ?)';
    params.push(`%${esc}%`, '\\', `%${esc}%`, '\\');
  }
  if (role) {
    where += ' AND role = ?';
    params.push(role);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(...params).c;
  const users = db.prepare(`SELECT id, username, nickname, email, role, banned, rating, hide_rating, created_at FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, users });
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
  if (!isValidRole(role)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Invalid role.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (user.id === req.user.id) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot change your own role.' });
  }
  if (user.role === 'su' && role !== 'su') {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot demote another super administrator.' });
  }
  db.prepare('UPDATE users SET role = ?, updated_at = datetime(\'now\') WHERE id = ?').run(role, req.params.id);
  audit(req.user, 'change-role', { ...user, username: user.username, id: user.id });
  res.json({ message: 'Role updated.', user: { id: user.id, username: user.username, role } });
});

router.post('/:id/ban', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot ban a user with equal or higher privileges (except yourself).' });
  }
  db.prepare('UPDATE users SET banned = 1, updated_at = datetime(\'now\') WHERE id = ?').run(target.id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(target.id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
  removeOnlineUser(target.id);
  audit(req.user, 'ban', target);
  res.json({ message: 'User banned and logged out.' });
});

router.post('/:id/unban', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  db.prepare('UPDATE users SET banned = 0, updated_at = datetime(\'now\') WHERE id = ?').run(target.id);
  audit(req.user, 'unban', target);
  res.json({ message: 'User unbanned.' });
});

router.post('/:id/force-logout', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot force logout a user with equal or higher privileges (except yourself).' });
  }
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(target.id);
  removeOnlineUser(target.id);
  audit(req.user, 'force-logout', target);
  res.json({ message: 'User forced to logout.' });
});

router.post('/:id/reset-password', requireAuth, requireRole('su'), (req, res) => {
  const { new_password } = req.body;
  // 与注册/改密一致的强度要求: 至少 8 位，含字母，且含数字或符号；bcrypt 前 72 字节截断防御
  if (!isStrongPassword(new_password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, req.params.id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id);
  audit(req.user, 'reset-password', user);
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
  const token = generateAccessToken(target.id);
  audit(req.user, 'sudo-login', target);
  res.json({ access_token: token, user: { id: target.id, username: target.username, nickname: target.nickname, role: target.role } });
});

router.post('/', requireAuth, requireRole('su'), (req, res) => {
  const { username, password, nickname, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }
  // 与注册接口一致的强度要求
  if (!isStrongPassword(password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  // 与注册接口一致的字符集限制
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username may only contain letters, digits, underscore, dot and dash.' });
  }
  if (role && !isValidRole(role)) {
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
  // D-L7: 同级（su）不可互删，仅可管理严格低级别
  if (!canManage(req.user, target)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete a user with equal or higher privileges.' });
  }
  if (target.role === 'su') {
    const suCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'su'").get().c;
    if (suCount <= 1) {
      return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot delete the last super administrator.' });
    }
  }
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(target.id);
  // 清理该用户作为作者/创建者的依赖数据（FK 已开启，需在删除前处理，避免 500）
  db.prepare('DELETE FROM discussion_replies WHERE author_id = ?').run(target.id);
  db.prepare('DELETE FROM discussions WHERE author_id = ?').run(target.id);
  db.prepare('DELETE FROM articles WHERE author_id = ?').run(target.id); // problem_solutions 级联
  db.prepare('DELETE FROM announcements WHERE author_id = ?').run(target.id);
  db.prepare('DELETE FROM problem_sets WHERE creator_id = ?').run(target.id); // items/progress 级联
  db.prepare('UPDATE problems SET created_by = NULL WHERE created_by = ?').run(target.id);
  db.prepare('UPDATE contests SET created_by = NULL WHERE created_by = ?').run(target.id);
  db.prepare('DELETE FROM submissions WHERE user_id = ?').run(target.id); // submission_details 级联
  // R9-20: 删用户时清理其上传到磁盘的文件（uploaded_files 是 SET NULL，只删行会留孤儿文件）
  const uploadDir = path.join(__dirname, '../../data/uploads');
  const files = db.prepare('SELECT filename FROM uploaded_files WHERE user_id = ?').all(target.id);
  for (const f of files) {
    try {
      const fp = path.resolve(uploadDir, path.basename(String(f.filename)));
      if (fp.startsWith(uploadDir) && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }
  db.prepare('DELETE FROM uploaded_files WHERE user_id = ?').run(target.id);
  // 10.3: 清理该用户邮箱的验证码记录（防止遗留隐私数据）
  if (target.email) db.prepare('DELETE FROM email_codes WHERE email = ?').run(target.email);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  audit(req.user, 'delete-user', target);
  res.json({ message: 'User deleted.' });
});

module.exports = router;
