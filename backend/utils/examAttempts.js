// 考试作答时限（exams.time_limit，分钟）的服务端强制。
//
// 背景缺陷：原先 time_limit 只在前端 exam.html 里做倒计时，且每次 loadExam 都把
// timeLeft 重置为满额时长，考生刷新页面即可无限续时；后端 POST /:id/submit 与
// POST /submissions 完全没有校验已用时长。
//
// 方案：每次 attempt 第一次进入考试即落一行 exam_attempts（起始时刻），
// 之后无论刷新多少次都不重置；交卷/提交编程题时用它判定是否超时。
const db = require('../database/db');
const { fromSqliteUtc } = require('./examWindow');

const STAFF_ROLES = ['teacher', 'admin', 'su'];

function isStaffUser(user) {
  return !!(user && STAFF_ROLES.includes(user.role));
}

function getAttemptRow(examId, userId, attempt) {
  return db.prepare(
    'SELECT started_at FROM exam_attempts WHERE exam_id = ? AND user_id = ? AND attempt = ?'
  ).get(examId, userId, attempt);
}

// 返回该次作答的起始时刻（ISO8601）；不存在则先按"现在"创建（刷新不重置）
function startAttempt(examId, userId, attempt) {
  db.prepare(
    "INSERT OR IGNORE INTO exam_attempts (exam_id, user_id, attempt, started_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(examId, userId, attempt);
  const row = getAttemptRow(examId, userId, attempt);
  const d = row ? fromSqliteUtc(row.started_at) : null;
  return d ? d.toISOString() : new Date().toISOString();
}

function attemptStartedAtMs(examId, userId, attempt) {
  const row = getAttemptRow(examId, userId, attempt);
  if (!row) return null;
  const d = fromSqliteUtc(row.started_at);
  return d ? d.getTime() : null;
}

// 剩余作答秒数；无 time_limit 时返回 null（不限时）
function remainingSeconds(exam, startedAtMs, nowMs = Date.now()) {
  if (!exam.time_limit || exam.time_limit <= 0) return null;
  if (startedAtMs === null || startedAtMs === undefined) return null;
  return Math.max(0, Math.ceil(exam.time_limit * 60 - (nowMs - startedAtMs) / 1000));
}

// 交卷宽限期：倒计时归零由前端自动提交，网络往返需要时间；
// 同时浏览器崩溃后重新打开页面仍能把已作答内容交上去。
// 取值必须小——它直接等于"超过时限后仍可继续操作"的窗口。
const SUBMIT_GRACE_MS = 2 * 60 * 1000;

// 超时门禁：返回 403 文案或 null。教师/管理员放行；尚未记录起始时刻时不拦截
// （由 startAttempt 在进入考试页时创建）。
function checkExamTimeLimit(exam, user, attempt, opts = {}) {
  const graceMs = opts.graceMs || 0;
  const nowMs = opts.nowMs || Date.now();
  if (!exam.time_limit || exam.time_limit <= 0) return null;
  if (isStaffUser(user)) return null;
  const startedAtMs = attemptStartedAtMs(exam.id, user.id, attempt);
  if (startedAtMs === null) return null;
  if (nowMs > startedAtMs + exam.time_limit * 60000 + graceMs) {
    return '考试时间已到，无法再作答。';
  }
  return null;
}

module.exports = {
  startAttempt,
  attemptStartedAtMs,
  remainingSeconds,
  checkExamTimeLimit,
  SUBMIT_GRACE_MS
};
