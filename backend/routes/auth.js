const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const config = require('../config/config');
const { requireAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/ratelimit');

const router = express.Router();
const registerRateLimit = createRateLimit({ windowMs: 3600000, max: 1 });

async function verifyTurnstile(token, ip) {
  if (!config.turnstile.secretKey) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${config.turnstile.secretKey}&response=${token}&remoteip=${ip || ''}`
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error('Turnstile verify error:', e.message);
    return false;
  }
}

function generateAccessToken(userId) {
  return jwt.sign({ userId }, config.jwt.accessSecret, { expiresIn: config.jwt.accessExpiry });
}

function generateRefreshToken(userId) {
  const token = jwt.sign({ userId }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiry });
  const hash = bcrypt.hashSync(token, 4);
  const expiresAt = new Date(Date.now() + config.jwt.refreshExpiryMs).toISOString();
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(userId, hash, expiresAt);
  return token;
}

router.get('/turnstile-sitekey', (req, res) => {
  res.json({ siteKey: config.turnstile.siteKey || '' });
});

router.post('/login', async (req, res) => {
  const { username, password, cf_turnstile_token } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }

  const cfOk = await verifyTurnstile(cf_turnstile_token, req.ip);
  if (!cfOk) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '人机验证失败，请重试。' });
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

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: config.jwt.refreshExpiryMs
  });

  res.json({
    access_token: accessToken,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, rating: user.rating, preferred_language: user.preferred_language || '' }
  });
});

router.post('/register', registerRateLimit, async (req, res) => {
  const { username, password, nickname, cf_turnstile_token } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username and password are required.' });
  }

  const cfOk = await verifyTurnstile(cf_turnstile_token, req.ip);
  if (!cfOk) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '人机验证失败，请重试。' });
  }

  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username must be 3-32 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Password must be at least 6 characters.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Username already exists.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, ?)').run(username, hash, nickname || username, 'user');
  const accessToken = generateAccessToken(result.lastInsertRowid);
  const refreshToken = generateRefreshToken(result.lastInsertRowid);

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: config.jwt.refreshExpiryMs
  });

  res.status(201).json({
    access_token: accessToken,
    user: { id: result.lastInsertRowid, username, nickname: nickname || username, role: 'user', rating: 1500, preferred_language: '' }
  });
});

router.post('/refresh', (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'No refresh token provided.' });
  }
  try {
    const payload = jwt.verify(refreshToken, config.jwt.refreshSecret);
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
    const tokens = db.prepare('SELECT * FROM refresh_tokens WHERE user_id = ? AND expires_at > datetime(\'now\')').all(payload.userId);
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
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(validToken.id);
    const newAccessToken = generateAccessToken(payload.userId);
    const newRefreshToken = generateRefreshToken(payload.userId);

    res.cookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      maxAge: config.jwt.refreshExpiryMs
    });

    res.json({ access_token: newAccessToken });
  } catch {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Invalid or expired refresh token.' });
  }
});

router.post('/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.id);
  res.clearCookie('refresh_token');
  res.json({ message: 'Logged out successfully.' });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Old and new password are required.' });
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
