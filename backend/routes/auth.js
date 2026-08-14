const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const config = require('../config/config');
const { requireAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');
const { generateCode, sendVerificationEmail, saveCode, verifyCode } = require('../services/email');
const { generateCaptcha, verifyCaptcha } = require('../services/captcha');
const { generateAccessToken, generateRefreshToken } = require('../utils/tokens');
const { isStrongPassword } = require('../utils/validation');

const router = express.Router();
const registerRateLimit = createRateLimit({ windowMs: 3600000, max: 1 });
const loginRateLimit = createRateLimit({ windowMs: 60000, max: 10 });
const refreshRateLimit = createRateLimit({ windowMs: 60000, max: 30 });
const changePasswordRateLimit = createRateLimit({ windowMs: 60000, max: 5 });
// 验证码校验接口独立限流，防止 6 位验证码被暴力枚举
const verifyCodeRateLimit = createRateLimit({ windowMs: 60000, max: 10 });

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
  const { id, svg } = generateCaptcha();
  res.json({ id, svg });
});

const emailCodeRateLimit = createRateLimit({ windowMs: 60000, max: 3 });

router.post('/send-code', emailCodeRateLimit, async (req, res) => {
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

router.get('/email-enabled', (req, res) => {
  res.json({ enabled: config.email.enabled });
});

router.post('/login', loginRateLimit, requireCaptcha, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
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

router.post('/register', registerRateLimit, requireCaptcha, async (req, res) => {
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
  db.prepare('INSERT INTO users (id, username, password_hash, nickname, role, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId, username, hash, nickname || username, 'user', email || '', emailVerified);
  const accessToken = generateAccessToken(newId);
  const refreshToken = generateRefreshToken(newId);

  setRefreshCookie(res, refreshToken);

  res.status(201).json({
    access_token: accessToken,
    user: { id: newId, username, nickname: nickname || username, role: 'user', rating: 1500, preferred_language: '' }
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
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
  res.json({ message: 'Password changed successfully.' });
});

module.exports = router;
