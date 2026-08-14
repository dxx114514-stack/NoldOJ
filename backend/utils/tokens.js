// 共享 Token 签发逻辑（access/refresh），auth 与 users(sudo-login) 复用

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const config = require('../config/config');

function generateAccessToken(userId) {
  return jwt.sign({ userId }, config.jwt.accessSecret, { expiresIn: config.jwt.accessExpiry, algorithm: 'HS256' });
}

function generateRefreshToken(userId) {
  const token = jwt.sign({ userId }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiry, algorithm: 'HS256' });
  const hash = bcrypt.hashSync(token, 10);
  const prefix = token.slice(0, 24);
  const expiresAt = new Date(Date.now() + config.jwt.refreshExpiryMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, token_prefix, expires_at) VALUES (?, ?, ?, ?)').run(userId, hash, prefix, expiresAt);
  return token;
}

module.exports = { generateAccessToken, generateRefreshToken };