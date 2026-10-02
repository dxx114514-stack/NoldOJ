// 试卷时间窗与封榜的纯函数（exams.js 与 submissions.js 共用；不含数据库依赖）
// 时间字段统一为 ISO8601（UTC）存储；null=不限

// 规范化为 ISO8601（UTC）；空值→null；非法值抛错（调用方转 400）
function normalizeExamTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = Date.parse(String(v));
  if (isNaN(ms)) throw new Error('时间格式非法（需 ISO8601）。');
  return new Date(ms).toISOString();
}

// 开考/结束须同时设置或同时留空，且结束晚于开考
function validateExamWindow(start, end) {
  if ((start === null) !== (end === null)) {
    throw new Error('开考时间与结束时间须同时设置或同时留空。');
  }
  if (start !== null && Date.parse(end) <= Date.parse(start)) {
    throw new Error('结束时间必须晚于开考时间。');
  }
}

// 窗口状态：null=未设时间窗；'not_started' | 'running' | 'ended'
function examWindowState(exam, nowMs = Date.now()) {
  if (!exam.start_time || !exam.end_time) return null;
  const s = Date.parse(exam.start_time);
  const e = Date.parse(exam.end_time);
  if (isNaN(s) || isNaN(e)) return null;
  if (nowMs < s) return 'not_started';
  if (nowMs > e) return 'ended';
  return 'running';
}

// SQLite datetime('now')（UTC 文本）转 Date（与 submitted_at 字符串比较/回显用）
function fromSqliteUtc(s) {
  const ms = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return isNaN(ms) ? null : new Date(ms);
}

function toSqliteUtc(v) {
  const d = v instanceof Date ? v : new Date(v);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// 封榜状态解析（优先级）：
// 1) 已过结束时间 → 自动解榜（结束后全量公开）
// 2) 手动封榜 → 冻结于 manual_frozen_at 时刻
// 3) 手动解榜（unfrozen）→ 抑制自动封榜窗口
// 4) freeze_minutes>0 且已进入结束前 N 分钟 → 冻结于 end - freeze_minutes
function resolveFreeze(exam, nowMs = Date.now()) {
  const endMs = exam.end_time ? Date.parse(exam.end_time) : NaN;
  if (!isNaN(endMs) && nowMs > endMs) return { frozen: false, freeze_at: null, source: null };
  if (exam.manual_frozen) {
    const at = exam.manual_frozen_at ? fromSqliteUtc(exam.manual_frozen_at) : null;
    return { frozen: true, freeze_at: (at || new Date(nowMs)).toISOString(), source: 'manual' };
  }
  if (exam.unfrozen) return { frozen: false, freeze_at: null, source: null };
  if (!isNaN(endMs) && (exam.freeze_minutes || 0) > 0) {
    const freezeAtMs = endMs - exam.freeze_minutes * 60000;
    if (nowMs >= freezeAtMs) {
      return { frozen: true, freeze_at: new Date(freezeAtMs).toISOString(), source: 'auto' };
    }
  }
  return { frozen: false, freeze_at: null, source: null };
}

// 时间窗门禁：开考前/结束后禁止作答（教师/管理员放行）；返回 403 文案或 null
function checkExamWindow(exam, user, nowMs = Date.now()) {
  const state = examWindowState(exam, nowMs);
  if (!state || state === 'running') return null;
  if (['teacher', 'admin', 'su'].includes(user.role)) return null;
  return state === 'not_started' ? '考试尚未开始。' : '考试已结束。';
}

module.exports = {
  normalizeExamTime,
  validateExamWindow,
  examWindowState,
  fromSqliteUtc,
  toSqliteUtc,
  resolveFreeze,
  checkExamWindow
};
