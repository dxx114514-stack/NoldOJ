const jwt = require('jsonwebtoken');
const config = require('../config/config');
const db = require('../database/db');

const onlineUsers = new Map();

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Missing or invalid authorization header.' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    const user = db.prepare('SELECT id, username, nickname, role, banned, force_logout_at, submit_lock_exempt FROM users WHERE id = ?').get(payload.userId);
    if (!user) {
      return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'User not found.' });
    }
    if (user.banned) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Account has been banned.' });
    }
    if (user.force_logout_at && payload.iat) {
      const forceTime = Math.floor(new Date(user.force_logout_at + 'Z').getTime() / 1000);
      if (payload.iat < forceTime) {
        return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'You have been logged out.' });
      }
    }
    req.user = user;
    onlineUsers.set(user.id, { username: user.username, nickname: user.nickname, role: user.role, lastActive: Date.now() });
    next();
  } catch (err) {
    return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Invalid or expired token.' });
  }
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    const user = db.prepare('SELECT id, username, nickname, role, banned FROM users WHERE id = ?').get(payload.userId);
    if (user && user.banned) {
      req.user = null;
    } else {
      req.user = user || null;
      if (user) {
        onlineUsers.set(user.id, { username: user.username, nickname: user.nickname, role: user.role, lastActive: Date.now() });
      }
    }
  } catch {
    req.user = null;
  }
  next();
}

function getOnlineUsers(timeoutMs = 5 * 60 * 1000) {
  const now = Date.now();
  const result = [];
  for (const [id, info] of onlineUsers) {
    if (now - info.lastActive < timeoutMs) {
      result.push({ id, ...info, lastActive: info.lastActive });
    } else {
      onlineUsers.delete(id);
    }
  }
  return result;
}

function removeOnlineUser(userId) {
  onlineUsers.delete(userId);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 5, reason: 'ERR_UNAUTHORIZED', message: 'Authentication required.' });
    }
    const hierarchy = ['user', 'teacher', 'admin', 'su'];
    // 要求同时满足所有传入角色（取其中最低门槛），user 满足所有额外要求
    const levels = roles.map(r => hierarchy.indexOf(r)).filter(i => i >= 0);
    if (levels.length === 0) return next();
    const minLevel = Math.min(...levels);
    const userLevel = hierarchy.indexOf(req.user.role);
    if (userLevel < minLevel) {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Insufficient permissions.' });
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, getOnlineUsers, removeOnlineUser };
