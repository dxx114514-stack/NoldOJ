const jwt = require('jsonwebtoken');
const config = require('../config/config');
const db = require('../database/db');

let io = null;

function initSocket(server) {
  io = require('socket.io')(server, {
    cors: {
      origin: true,
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
      const payload = jwt.verify(token, config.jwt.accessSecret);
      const user = db.prepare('SELECT id, username, nickname, role FROM users WHERE id = ?').get(payload.userId);
      if (!user) {
        return next(new Error('User not found'));
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
    socket.on('join_submission', (data) => {
      if (data && data.submission_id) {
        socket.join(`submission:${data.submission_id}`);
      }
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

function getIO() {
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

module.exports = { initSocket, getIO, emitJudgeStatus, emitContestRanking, emitAnnouncement };
