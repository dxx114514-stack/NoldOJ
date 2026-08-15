const jwt = require('jsonwebtoken');
const config = require('../config/config');
const db = require('../database/db');

let io = null;

function initSocket(server) {
  const allowedOrigins = new Set(config.cors.origins);
  io = require('socket.io')(server, {
    cors: {
      // 仅允许配置的白名单源，禁止任意 Origin 凭据连接
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true
    }
  });

  // JWT 认证中间件
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      return next(new Error('No token provided'));
    }
    try {
      const payload = jwt.verify(token, config.jwt.accessSecret, { algorithms: ['HS256'] });
      const user = db.prepare('SELECT id, username, nickname, role, banned, force_logout_at FROM users WHERE id = ?').get(payload.userId);
      if (!user) {
        return next(new Error('User not found'));
      }
      // 封禁 / 强制登出用户不允许建立 WebSocket 连接（与 requireAuth 行为一致）
      if (user.banned) {
        return next(new Error('Account has been banned'));
      }
      if (user.force_logout_at && payload.iat) {
        const forceTime = Math.floor(new Date(user.force_logout_at + 'Z').getTime() / 1000);
        if (payload.iat < forceTime) {
          return next(new Error('You have been logged out'));
        }
      }
      socket.userId = user.id;
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // 用 userId 标记 socket，便于按用户推送
    socket.join(`user:${socket.userId}`);

    // 加入提交房间：客户端 emit('join_submission', {submission_id})
    // D-M9: 校验房间归属，仅本人/管理员可订阅该提交的实时状态，防窥探他人评测结果
    socket.on('join_submission', (data) => {
      if (!(data && data.submission_id)) return;
      const sub = db.prepare('SELECT user_id FROM submissions WHERE id = ?').get(data.submission_id);
      if (!sub) return;
      const isStaff = ['admin', 'su', 'teacher'].includes(socket.user.role);
      if (sub.user_id !== socket.userId && !isStaff) return;
      socket.join(`submission:${data.submission_id}`);
    });

    // 离开提交房间
    socket.on('leave_submission', (data) => {
      if (data && data.submission_id) {
        socket.leave(`submission:${data.submission_id}`);
      }
    });

    // 加入比赛排行榜房间
    socket.on('join_contest_ranking', (data) => {
      if (data && data.contest_id) {
        socket.join(`contest_ranking:${data.contest_id}`);
      }
    });

    socket.on('leave_contest_ranking', (data) => {
      if (data && data.contest_id) {
        socket.leave(`contest_ranking:${data.contest_id}`);
      }
    });

    socket.on('disconnect', () => {
      // socket.io 自动清理房间
    });
  });

  console.log('[Socket] Socket.io initialized');
  return io;
}

// 推送评测状态给提交者
function emitJudgeStatus(submissionId, userId, status) {
  if (!io) return;
  io.to(`submission:${submissionId}`).emit('judge_status', {
    type: 'judge_status',
    submission_id: submissionId,
    status: status
  });
  // 同时推给用户频道（确保用户在任何页面都能收到）
  io.to(`user:${userId}`).emit('judge_status', {
    type: 'judge_status',
    submission_id: submissionId,
    status: status
  });
}

// 推送比赛排行榜更新
function emitContestRanking(contestId, data) {
  if (!io) return;
  io.to(`contest_ranking:${contestId}`).emit('contest_ranking_update', {
    type: 'contest_ranking_update',
    contest_id: contestId,
    ...data
  });
}

// 广播新公告
function emitAnnouncement(announcement) {
  if (!io) return;
  io.emit('announcement', {
    type: 'announcement',
    data: announcement
  });
}

module.exports = { initSocket, emitJudgeStatus, emitContestRanking, emitAnnouncement };
