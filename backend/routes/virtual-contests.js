const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// 工具：判断是否已结束
function isContestEnded(contest) {
  return new Date(contest.end_time).getTime() < Date.now();
}

// 工具：把 Date 转成 "YYYY-MM-DD HH:MM:SS" 本地时间字符串（与原比赛存储方式一致）
function formatLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 发起虚拟参加 (登录用户)
// 挂在 contests 路由下: POST /api/v1/contests/:id/virtual-start
function virtualStart(req, res) {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  if (!isContestEnded(contest)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '比赛尚未结束，无法虚拟参加。' });
  }
  // 同一用户同一比赛只能虚拟参加一次
  const existing = db.prepare('SELECT id FROM virtual_contests WHERE contest_id = ? AND user_id = ?').get(contest.id, req.user.id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '你已经虚拟参加过此比赛。', virtual_contest_id: existing.id });
  }
  const durationMs = new Date(contest.end_time).getTime() - new Date(contest.start_time).getTime();
  const now = new Date();
  const startTimeStr = formatLocal(now);
  const endTimeStr = formatLocal(new Date(now.getTime() + durationMs));
  const result = db.prepare(
    'INSERT INTO virtual_contests (contest_id, user_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)'
  ).run(contest.id, req.user.id, startTimeStr, endTimeStr, 'running');
  const vc = db.prepare('SELECT * FROM virtual_contests WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(vc);
}

// 虚拟比赛详情（题目+剩余时间+提交）
// ownership 校验并入 SQL，未授权与不存在统一返回 404，防 ID 枚举
router.get('/:id', requireAuth, async (req, res) => {
  const vc = db.prepare(`
    SELECT vc.* FROM virtual_contests vc
    WHERE vc.id = ? AND (vc.user_id = ? OR EXISTS(
      SELECT 1 FROM users u WHERE u.id = ? AND u.role IN ('admin', 'su')
    ))
  `).get(req.params.id, req.user.id, req.user.id);
  if (!vc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Virtual contest not found.' });
  }
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(vc.contest_id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Original contest not found.' });
  }
  // 题目列表
  const problems = db.prepare(`
    SELECT cp.problem_id, cp.alias, p.title, p.time_limit, p.memory_limit
    FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
    WHERE cp.contest_id = ?
    ORDER BY cp.alias
  `).all(contest.id);
  // 我在本次虚拟比赛的提交
  const submissions = db.prepare(`
    SELECT s.id, s.problem_id, s.status, s.score, s.time_used, s.created_at
    FROM submissions s
    WHERE s.virtual_contest_id = ?
    ORDER BY s.id DESC
  `).all(vc.id);

  // 状态仅在内存中推导，不写入数据库（避免 GET 触发状态变更）
  const status = new Date(vc.end_time).getTime() < Date.now() ? 'finished' : vc.status;

  res.json({
    ...vc,
    status,
    contest,
    problems,
    submissions,
    remaining_ms: Math.max(0, new Date(vc.end_time).getTime() - Date.now())
  });
});

// 虚拟比赛排行榜（只返回自己）
router.get('/:id/ranking', requireAuth, (req, res) => {
  const vc = db.prepare('SELECT * FROM virtual_contests WHERE id = ?').get(req.params.id);
  if (!vc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Virtual contest not found.' });
  }
  if (vc.user_id !== req.user.id && !['admin','su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: '无权访问他人虚拟比赛。' });
  }
  const contestProblems = db.prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ?').all(vc.contest_id);
  const problemIds = contestProblems.map(p => p.problem_id);
  if (problemIds.length === 0) return res.json({ leaderboard: [], problem_ids: [] });

  const placeholders = problemIds.map(() => '?').join(',');
  const submissions = db.prepare(`
    SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username, u.nickname
    FROM submissions s LEFT JOIN users u ON s.user_id = u.id
    WHERE s.virtual_contest_id = ? AND s.problem_id IN (${placeholders})
      AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
  `).all(vc.id, ...problemIds);

  // 构造单个用户的排行榜数据
  let totalScore = 0, totalTime = 0;
  const problemsMap = {};
  for (const s of submissions) {
    if (!problemsMap[s.problem_id] || s.score > problemsMap[s.problem_id].score) {
      problemsMap[s.problem_id] = { score: s.score, time_used: s.time_used, status: s.status };
    }
  }
  for (const pid of problemIds) {
    const p = problemsMap[pid];
    if (p && p.status === 'accepted') {
      totalScore += p.score;
      totalTime += p.time_used;
    }
  }
  const user = db.prepare('SELECT username, nickname FROM users WHERE id = ?').get(vc.user_id);
  const leaderboard = [{
    user_id: vc.user_id,
    username: user.username,
    nickname: user.nickname,
    total_score: totalScore,
    total_time: totalTime,
    problems: problemsMap,
    rank: 1
  }];
  res.json({ leaderboard, problem_ids: problemIds });
});

// 我的虚拟比赛列表 (挂在 /my 路由下)
function myVirtualContests(req, res) {
  const items = db.prepare(`
    SELECT vc.id, vc.contest_id, vc.start_time, vc.end_time, vc.status, vc.created_at,
           c.title as contest_title
    FROM virtual_contests vc LEFT JOIN contests c ON vc.contest_id = c.id
    WHERE vc.user_id = ?
    ORDER BY vc.id DESC
  `).all(req.user.id);
  // 状态仅在内存中推导，不落库
  const updated = items.map(it => {
    const status = new Date(it.end_time).getTime() < Date.now() ? 'finished' : it.status;
    return { ...it, status };
  });
  res.json({ virtual_contests: updated });
}

module.exports = { router, virtualStart, myVirtualContests };
