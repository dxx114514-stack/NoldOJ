const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const config = require('../config/config');
const { requireAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');
const { generateCode, sendVerificationEmail, sendPasswordResetEmail, saveCode, verifyCode } = require('../services/email');
const { generateCaptcha, verifyCaptcha } = require('../services/captcha');
const { generateAccessToken, generateRefreshToken } = require('../utils/tokens');
const { isStrongPassword } = require('../utils/validation');
const { sanitizeText } = require('../utils/securityHelpers');

const router = express.Router();
const registerRateLimit = createRateLimit({ windowMs: 3600000, max: 1 });
const loginRateLimit = createRateLimit({ windowMs: 60000, max: 10 });
const refreshRateLimit = createRateLimit({ windowMs: 60000, max: 30 });
const changePasswordRateLimit = createRateLimit({ windowMs: 60000, max: 5 });

// 验证码校验中间件（login/register 共用）
function requireCaptcha(req, res, next) {
  if (config.captcha.enabled) {
    const { captcha_id, captcha_code } = req.body;
    if (!captcha_id || !captcha_code) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '请完成验证码。' });
    }
    const ok = verifyCaptcha(captcha_id, captcha_code);
    if (!ok) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '验证码错误，请重试。' });
    }
  }
  next();
}

// 设置 refresh_token httpOnly cookie（login/register/refresh 共用）
function setRefreshCookie(res, refreshToken) {
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: 'strict',
    maxAge: config.jwt.refreshExpiryMs
  });
}

router.get('/captcha', (req, res) => {
  if (!config.captcha.enabled) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Captcha disabled' });
  }
  const captcha = generateCaptcha();
  // NoldOJ_CAPTCHA_DEBUG=1 时 generateCaptcha 返回 code（仅测试用），其余情况只有 id/svg
  res.json(captcha);
});

const emailCodeRateLimit = createRateLimit({ windowMs: 60000, max: 3, key: req => String(req.body?.email || '').toLowerCase() });
// 验证码校验接口独立限流，防止 6 位验证码被暴力枚举；限流键同时包含邮箱维度（D-M3）
const verifyCodeRateLimit = createRateLimit({ windowMs: 60000, max: 10, key: req => String(req.body?.email || '').toLowerCase() });
// 密码找回: 请求重置邮件独立限流，防止用他人邮箱轰炸
const forgotPasswordRateLimit = createRateLimit({ windowMs: 60000, max: 5, key: req => String(req.body?.email || '').toLowerCase() });
const resetPasswordRateLimit = createRateLimit({ windowMs: 60000, max: 10, key: req => String(req.body?.email || '').toLowerCase() });

router.post('/send-code', emailCodeRateLimit, requireCaptcha, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '请输入有效的邮箱地址。' });
  }
  // 不区分邮箱是否已注册，统一响应，防止枚举已注册邮箱
  const code = generateCode();
  saveCode(email, code);
  const sent = await sendVerificationEmail(email, code);
  if (!sent) {
    return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '验证码发送失败，请稍后重试。' });
  }
  res.json({ message: '验证码已发送。' });
});

router.post('/verify-code', verifyCodeRateLimit, (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '邮箱和验证码不能为空。' });
  }
  const ok = verifyCode(email, code);
  if (!ok) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '验证码无效或已过期。' });
  }
  res.json({ message: '验证成功。' });
});

// 密码找回第一步：校验用户名+邮箱匹配，向绑定邮箱发送重置验证码。
// 未绑定邮箱 / 用户名不存在 / 邮箱不匹配 → 发送失败（不泄露账号是否存在）
router.post('/forgot-password', forgotPasswordRateLimit, requireCaptcha, async (req, res) => {
  const { username, email } = req.body;
  if (!username || !email) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '用户名和邮箱不能为空。' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '请输入有效的邮箱地址。' });
  }
  const user = db.prepare('SELECT id, username, email, email_verified FROM users WHERE username = ?').get(username);
  // 用户不存在、未绑定邮箱、邮箱不匹配均视为发送失败，返回同一提示，防止枚举已注册账号
  if (!user || !user.email || !user.email_verified || user.email !== email) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '未找到与用户名匹配且已验证的邮箱，无法发送重置邮件。' });
  }
  if (!config.email.enabled || !config.email.apiKey) {
    return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '邮件服务未启用，无法发送重置邮件。' });
  }
  const code = generateCode();
  saveCode(email, code);
  const sent = await sendPasswordResetEmail(email, code);
  if (!sent) {
    return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '重置邮件发送失败，请稍后重试。' });
  }
  res.json({ message: '重置邮件已发送，请查收。' });
});

// 密码找回第二步：校验验证码后设置新密码，并使该账号所有会话失效
router.post('/reset-password', resetPasswordRateLimit, (req, res) => {
  const { username, email, code, new_password } = req.body;
  if (!username || !email || !code || !new_password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '用户名、邮箱、验证码和新密码不能为空。' });
  }
  if (!isStrongPassword(new_password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  const user = db.prepare('SELECT id, username, email, email_verified FROM users WHERE username = ?').get(username);
  if (!user || !user.email || !user.email_verified || user.email !== email) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '用户名与邮箱不匹配。' });
  }
  if (!verifyCode(email, code)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '验证码无效或已过期。' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, user.id);
  // 重置后强制所有会话下线
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id);
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(user.id);
  res.json({ message: '密码已重置，请使用新密码登录。' });
});

router.get('/email-enabled', (req, res) => {
  res.json({ enabled: config.email.enabled });
});

router.post('/login', loginRateLimit, requireCaptcha, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // D-L1: 用户不存在时也执行一次 bcrypt 对比，抹平计时侧信道（防用户名枚举）
  if (!user) {
    bcrypt.compareSync(password, '$2a$10$7QJN4k1P0bWtHjM6Y0vzOe0Y2kZ3p4q5r6s7t8u9v0w1x2y3z4a');
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Invalid username or password.' });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Invalid username or password.' });
  }
  if (user.banned) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '此账号已被封禁，请联系管理员解封。' });
  }
  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);

  setRefreshCookie(res, refreshToken);

  res.json({
    access_token: accessToken,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, rating: user.rating, preferred_language: user.preferred_language || '' }
  });
});

// R12-3: 注册开关守卫——置于最前, 关闭时不消耗限流配额且优先返回明确错误
function requireRegisterOpen(req, res, next) {
  if (!config.register.enabled) {
    return res.status(403).json({ code: 6, reason: 'ERR_REGISTER_DISABLED', message: '本站已关闭自行注册，请联系管理员创建账号。' });
  }
  next();
}

router.post('/register', requireRegisterOpen, registerRateLimit, requireCaptcha, async (req, res) => {
  const { username, password, nickname, email, email_code } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }

  if (config.email.enabled) {
    if (!email || !email_code) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '请先验证邮箱。' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '请输入有效的邮箱地址。' });
    }
    const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (emailExists) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '注册信息不可用，请更换用户名或邮箱后重试。' });
    }
    const codeOk = verifyCode(email, email_code);
    if (!codeOk) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '验证码无效或已过期。' });
    }
  }

  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username must be 3-32 characters.' });
  }
  // 限制字符集，防止控制字符/HTML 标记进入存储触发存储型 XSS
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username may only contain letters, digits, underscore, dot and dash.' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    // 与格式错误返回相同信息，避免枚举已有用户名
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '注册信息不可用，请更换用户名或邮箱后重试。' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const newId = db.findNextId('users');
  const emailVerified = config.email.enabled && email ? 1 : 0;
  const safeNickname = sanitizeText(nickname || username, 50) || username;
  db.prepare('INSERT INTO users (id, username, password_hash, nickname, role, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId, username, hash, safeNickname, 'user', email || '', emailVerified);
  const accessToken = generateAccessToken(newId);
  const refreshToken = generateRefreshToken(newId);

  setRefreshCookie(res, refreshToken);

  res.status(201).json({
    access_token: accessToken,
    user: { id: newId, username, nickname: safeNickname, role: 'user', rating: 1500, preferred_language: '' }
  });
});

router.post('/refresh', refreshRateLimit, (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'No refresh token provided.' });
  }
  try {
    const payload = jwt.verify(refreshToken, config.jwt.refreshSecret, { algorithms: ['HS256'] });
    const user = db.prepare('SELECT id, banned, force_logout_at FROM users WHERE id = ?').get(payload.userId);
    if (!user) {
      return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'User not found.' });
    }
    if (user.banned) {
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(payload.userId);
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Account has been banned.' });
    }
    if (user.force_logout_at && payload.iat) {
      const forceTime = Math.floor(new Date(user.force_logout_at + 'Z').getTime() / 1000);
      if (payload.iat < forceTime) {
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(payload.userId);
        return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'You have been logged out.' });
      }
    }
    const tokens = db.prepare('SELECT * FROM refresh_tokens WHERE user_id = ? AND token_prefix = ? AND expires_at > datetime(\'now\')').all(payload.userId, refreshToken.slice(0, 24));
    let validToken = null;
    for (const t of tokens) {
      if (bcrypt.compareSync(refreshToken, t.token_hash)) {
        validToken = t;
        break;
      }
    }
    if (!validToken) {
      return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Invalid refresh token.' });
    }
    // 原子消费该 refresh token: 并发刷新时后到者 delete 影响 0 行，判定为已使用
    const del = db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(validToken.id);
    if (del.changes === 0) {
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(payload.userId);
      return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Refresh token already used, please login again.' });
    }
    const newAccessToken = generateAccessToken(payload.userId);
    const newRefreshToken = generateRefreshToken(payload.userId);

    setRefreshCookie(res, newRefreshToken);

    res.json({ access_token: newAccessToken });
  } catch {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Invalid or expired refresh token.' });
  }
});

router.post('/logout', (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, config.jwt.refreshSecret, { algorithms: ['HS256'] });
      // 仅删除当前使用的 refresh token，不影响其他登录会话
      const tokens = db.prepare('SELECT id, token_hash FROM refresh_tokens WHERE user_id = ?').all(payload.userId);
      for (const t of tokens) {
        if (bcrypt.compareSync(refreshToken, t.token_hash)) {
          db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(t.id);
          break;
        }
      }
    } catch {}
  }
  res.clearCookie('refresh_token');
  res.json({ message: 'Logged out successfully.' });
});

router.post('/change-password', requireAuth, changePasswordRateLimit, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Old and new password are required.' });
  }
  if (!isStrongPassword(new_password)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '密码至少 8 位，且须包含字母与数字或符号。' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Old password is incorrect.' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, req.user.id);
  // D-L2: 修改密码同时吊销旧 access token（否则最长 15 分钟仍有效）
  db.prepare("UPDATE users SET force_logout_at = datetime('now') WHERE id = ?").run(req.user.id);
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
  res.json({ message: 'Password changed successfully.' });
});

module.exports = router;

