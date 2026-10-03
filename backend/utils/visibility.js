// 题目可见性校验（隐藏题 / 非公开题），返回错误响应对象或 null。
// 原先只存在于 routes/problems.js，导致提交接口（POST /submissions）绕过校验：
// 比赛题（is_public=0）与隐藏题只要猜到 id 就能在开赛前提交并回读测试数据。
// 现统一放在 utils 下，由 problems.js 与 submissions.js 共用。
const db = require('../database/db');
const { isStaff } = require('./roles');

function problemVisibilityError(problem, req) {
  const isManager = !!(req.user && isStaff(req.user.role));
  if (problem.is_hidden && !isManager) {
    return { code: 6, reason: 'ERR_FORBIDDEN', message: 'Problem is not public.' };
  }
  if (!problem.is_public) {
    if (isManager || (req.user && req.user.id === problem.created_by)) return null;
    const contests = db.prepare(`
      SELECT c.id, c.start_time, c.end_time FROM contest_problems cp
      JOIN contests c ON c.id = cp.contest_id
      WHERE cp.problem_id = ?
    `).all(problem.id);
    const now = Date.now();
    const running = contests.some(c => {
      const s = new Date(c.start_time).getTime();
      const e = new Date(c.end_time).getTime();
      return !isNaN(s) && !isNaN(e) && s <= now && now <= e;
    });
    const participant = running && req.user ? db.prepare(`
      SELECT 1 FROM contest_participants WHERE contest_id IN (
        SELECT cp2.contest_id FROM contest_problems cp2 WHERE cp2.problem_id = ?
      ) AND user_id = ?
    `).get(problem.id, req.user.id) : null;
    if (!running || !req.user || !participant) {
      return { code: 6, reason: 'ERR_FORBIDDEN', message: 'Problem is not public.' };
    }
  }
  return null;
}

module.exports = { problemVisibilityError };
