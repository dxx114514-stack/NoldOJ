const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { isStaff } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { createRateLimit } = require('../middleware/ratelimit');

// R9-3: 一键查重限流（每分钟最多 5 次）
const plagiarismRateLimit = createRateLimit({ windowMs: 60000, max: 5 });

const router = express.Router();

// 公开比赛列表保持匿名可访问；挂 optionalAuth 以便识别登录用户角色
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = '';
  const params = [];
  const fuzzy = search ? '%' + search.replace(/\s+/g, '') + '%' : null;
  // 隐藏比赛仅对 teacher/admin/su 可见
  if (!req.user || !isStaff(req.user.role)) {
    where = 'WHERE c.is_hidden = 0';
  }
  if (search) {
    const cond = "REPLACE(c.title, ' ', '') LIKE ? OR REPLACE(c.description, ' ', '') LIKE ?";
    where = where ? `${where} AND (${cond})` : `WHERE (${cond})`;
    params.push(fuzzy, fuzzy);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM contests c ${where}`).get(...params).c;
  const contests = db.prepare(`
    SELECT c.*, u.username as creator_name,
      (SELECT COUNT(*) FROM contest_problems WHERE contest_id = c.id) as problem_count
    FROM contests c LEFT JOIN users u ON c.created_by = u.id
    ${where}
    ORDER BY c.id DESC LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, contests });
});

router.get('/:id', optionalAuth, (req, res) => {
  const contest = db.prepare('SELECT c.*, u.username as creator_name FROM contests c LEFT JOIN users u ON c.created_by = u.id WHERE c.id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  // 隐藏比赛仅对管理角色可见
  if (contest.is_hidden && !(req.user && isStaff(req.user.role))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Contest not found.' });
  }
  const staff = !!req.user && isStaff(req.user.role);
  let problems = [];
  const hiddenFilter = staff ? '' : ' AND p.is_hidden = 0';
  if (staff) {
    problems = db.prepare(`
      SELECT cp.sort_order, cp.alias, p.id, p.title, p.time_limit, p.memory_limit, p.is_public
      FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
      WHERE cp.contest_id = ? ORDER BY cp.sort_order
    `).all(contest.id);
  } else {
    // 未开始前不泄露题目列表（防止提前预习题目）
    const now = Date.now();
    const started = !contest.start_time || new Date(contest.start_time).getTime() <= now;
    if (!started) {
      problems = [];
    } else {
      problems = db.prepare(`
      SELECT cp.sort_order, cp.alias, p.id, p.title, p.time_limit, p.memory_limit
      FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
      WHERE cp.contest_id = ?${hiddenFilter} ORDER BY cp.sort_order
    `).all(contest.id);
    }
  }
  const participantCount = db.prepare('SELECT COUNT(*) as c FROM contest_participants WHERE contest_id = ?').get(contest.id).c;
  res.json({ ...contest, problems, participant_count: participantCount });
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden } = req.body;
  if (!title || !start_time || !end_time) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title, start_time, and end_time are required.' });
  }
  const fm = Math.max(0, parseInt(freeze_minutes) || 0);
  const result = db.prepare('INSERT INTO contests (title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(title, description || '', start_time, end_time, is_virtual ? 1 : 0, fm, is_hidden ? 1 : 0, req.user.id);
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(contest);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const { title, description, start_time, end_time, is_virtual, freeze_minutes, is_hidden } = req.body;
  const u = buildUpdates([
    { key: 'title', value: title },
    { key: 'description', value: description },
    { key: 'start_time', value: start_time },
    { key: 'end_time', value: end_time },
    { key: 'is_virtual', value: is_virtual, transform: v => v ? 1 : 0 },
    { key: 'freeze_minutes', value: freeze_minutes, transform: v => Math.max(0, parseInt(v) || 0) },
    { key: 'is_hidden', value: is_hidden, transform: v => v ? 1 : 0 }
  ]);

  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  db.prepare(`UPDATE contests SET ${u.clause} WHERE id = ?`).run(...u.values, contest.id);
  const updated = db.prepare('SELECT * FROM contests WHERE id = ?').get(contest.id);
  res.json(updated);
});

router.post('/:id/problems', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const { problem_id, alias } = req.body;
  if (!problem_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'problem_id is required.' });
  }
  const problem = db.prepare('SELECT id FROM problems WHERE id = ?').get(problem_id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const existing = db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contest.id, problem_id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Problem already in contest.' });
  }
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM contest_problems WHERE contest_id = ?').get(contest.id)?.m || 0;
  db.prepare('INSERT INTO contest_problems (contest_id, problem_id, sort_order, alias) VALUES (?, ?, ?, ?)').run(contest.id, problem_id, maxOrder + 1, alias || '');
  res.status(201).json({ message: 'Problem added to contest.' });
});

router.delete('/:id/problems/:pid', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const existing = db.prepare('SELECT id FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contest.id, req.params.pid);
  if (!existing) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not in contest.' });
  }
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ? AND problem_id = ?').run(contest.id, req.params.pid);
  res.json({ message: 'Problem removed from contest.' });
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contest.id);
  db.prepare('DELETE FROM contest_participants WHERE contest_id = ?').run(contest.id);
  db.prepare('DELETE FROM contests WHERE id = ?').run(contest.id);
  res.json({ message: 'Contest deleted.' });
});

router.post('/:id/invite', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'user_id is required.' });
  }
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(user_id);
  if (!user) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'User not found.' });
  }
  const existing = db.prepare('SELECT id FROM contest_participants WHERE contest_id = ? AND user_id = ?').get(contest.id, user_id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'User already in contest.' });
  }
  db.prepare('INSERT INTO contest_participants (contest_id, user_id, invited_by) VALUES (?, ?, ?)').run(contest.id, user_id, req.user.id);
  res.status(201).json({ message: `${user.username} has been invited.` });
});

router.post('/:id/join', requireAuth, (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const existing = db.prepare('SELECT id FROM contest_participants WHERE contest_id = ? AND user_id = ?').get(contest.id, req.user.id);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Already joined this contest.' });
  }
  db.prepare('INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)').run(contest.id, req.user.id);
  res.json({ message: 'Joined contest.' });
});

router.get('/:id/participants', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const participants = db.prepare(`
    SELECT cp.user_id, u.username, u.nickname, u.role, cp.joined_at, inv.username as invited_by_name
    FROM contest_participants cp
    LEFT JOIN users u ON cp.user_id = u.id
    LEFT JOIN users inv ON cp.invited_by = inv.id
    WHERE cp.contest_id = ? ORDER BY cp.joined_at
  `).all(contest.id);
  res.json({ total: participants.length, participants });
});

router.delete('/:id/participants/:uid', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  db.prepare('DELETE FROM contest_participants WHERE contest_id = ? AND user_id = ?').run(contest.id, req.params.uid);
  res.json({ message: 'Participant removed.' });
});

router.get('/:id/leaderboard', optionalAuth, (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }

  // 判断冻结状态: freeze_minutes>0 且当前时间已过冻结时刻 且 未手动解冻
  let frozen = false;
  let freezeAt = null;
  if (contest.freeze_minutes > 0 && !contest.unfrozen) {
    const startMs = new Date(contest.start_time).getTime();
    const endMs = new Date(contest.end_time).getTime();
    const durMin = (endMs - startMs) / 60000;
    if (contest.freeze_minutes < durMin) {
      freezeAt = new Date(endMs - contest.freeze_minutes * 60000);
      if (Date.now() >= freezeAt.getTime()) {
        frozen = true;
      }
    }
  }

  // 仅参赛者可查看完整排行榜；教师/管理员/站长放行；非参赛者只返回冻结状态，不泄露排名
  const staff = !!req.user && isStaff(req.user.role);
  const participant = req.user
    ? db.prepare('SELECT id FROM contest_participants WHERE contest_id = ? AND user_id = ?').get(contest.id, req.user.id)
    : null;
  const frozenState = { leaderboard: [], problem_ids: [], frozen, freeze_at: freezeAt ? freezeAt.toISOString() : null };
  if (!staff && !participant) {
    return res.json(frozenState);
  }
  const contestProblems = db.prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ?').all(contest.id);
  if (contestProblems.length === 0) return res.json(frozenState);

  const problemIds = contestProblems.map(p => p.problem_id);
  const placeholders = problemIds.map(() => '?').join(',');

  // 冻结期间只统计冻结时刻之前的提交
  let timeFilter = '';
  const params = [...problemIds];
  if (frozen) {
    timeFilter = 'AND s.created_at <= ?';
    params.push(freezeAt.toISOString().replace('T', ' ').substring(0, 19));
  }
  // 榜单仅统计已报名参赛的用户
  timeFilter += ' AND s.user_id IN (SELECT user_id FROM contest_participants WHERE contest_id = ?)';
  params.push(contest.id);

  const submissions = db.prepare(`
    SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username, u.nickname
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.problem_id IN (${placeholders})
      AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
      ${timeFilter}
  `).all(...params);

  const userMap = {};
  for (const s of submissions) {
    if (!userMap[s.user_id]) {
      userMap[s.user_id] = { user_id: s.user_id, username: s.username, nickname: s.nickname, total_score: 0, total_time: 0, problems: {} };
    }
    const um = userMap[s.user_id];
    const cur = um.problems[s.problem_id];
    if (!cur) {
      um.problems[s.problem_id] = { score: s.score, time_used: s.time_used, status: s.status };
    } else {
      const curAc = cur.status === 'accepted';
      const newAc = s.status === 'accepted';
      // AC 优先 → 同 AC 比分数 → 同分数比用时，防止 AC 被同分更快的 WA 顶成 0 分
      if ((newAc && !curAc) ||
          (newAc === curAc && (s.score > cur.score || (s.score === cur.score && s.time_used < cur.time_used)))) {
        um.problems[s.problem_id] = { score: s.score, time_used: s.time_used, status: s.status };
      }
    }
  }

  const leaderboard = Object.values(userMap).map(u => {
    let totalScore = 0;
    let totalTime = 0;
    for (const pid of problemIds) {
      const p = u.problems[pid];
      if (p && p.status === 'accepted') {
        totalScore += p.score;
        totalTime += p.time_used;
      }
    }
    return { user_id: u.user_id, username: u.username, nickname: u.nickname, total_score: totalScore, total_time: totalTime, problems: u.problems };
  });

  leaderboard.sort((a, b) => b.total_score - a.total_score || a.total_time - b.total_time);

  for (let i = 0; i < leaderboard.length; i++) {
    leaderboard[i].rank = i + 1;
  }

  res.json({ leaderboard, problem_ids: problemIds, frozen, freeze_at: freezeAt ? freezeAt.toISOString() : null });
});

// 手动解冻排行榜 (admin)
router.post('/:id/unfreeze', requireAuth, requireRole('admin'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  // D-L17: 统一为 UTC ISO 8601（带 Z），与 freeze_at/toISOString 一致，避免前端 new Date() 本地时区解析偏差
  db.prepare("UPDATE contests SET unfrozen = 1, unfrozen_at = ? WHERE id = ?").run(new Date().toISOString(), contest.id);
  const updated = db.prepare('SELECT * FROM contests WHERE id = ?').get(contest.id);
  // 解冻后广播给该比赛房间
  try {
    const { emitContestRanking } = require('../services/socket');
    if (emitContestRanking) emitContestRanking(contest.id, { type: 'unfrozen' });
  } catch {}
  res.json(updated);
});

// 比赛内公告
router.get('/:id/announcements', optionalAuth, (req, res) => {
  const contest = db.prepare('SELECT id FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const items = db.prepare(`
    SELECT a.id, a.title, a.content, a.pinned, a.author_id, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.type = 'contest' AND a.contest_id = ?
    ORDER BY a.pinned DESC, a.id DESC
  `).all(req.params.id);
  res.json({ announcements: items });
});

// 功能9：发起虚拟参加
router.post('/:id/virtual-start', requireAuth, (req, res) => {
  const { virtualStart } = require('../routes/virtual-contests');
  virtualStart(req, res);
});

// 功能10：比赛一键全部查重（admin/teacher，异步）
// POST /api/v1/contests/:id/plagiarism-check  对比赛所有题目依次发起查重
router.post('/:id/plagiarism-check', requireAuth, requireRole('teacher'), plagiarismRateLimit, (req, res) => {
  const contest = db.prepare('SELECT id FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const problems = db.prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ?').all(req.params.id);
  const { createTask } = require('../services/plagiarism');
  const tasks = [];
  for (const p of problems) {
    const taskId = createTask(p.problem_id, req.user.id);
    tasks.push({ problem_id: p.problem_id, task_id: taskId });
  }
  res.status(202).json({ tasks, total: tasks.length, message: 'Plagiarism checks started for all contest problems.' });
});

// 功能8：比赛讨论列表
router.get('/:id/discussions', optionalAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const contest = db.prepare('SELECT id FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const total = db.prepare('SELECT COUNT(*) as c FROM discussions WHERE contest_id = ?').get(req.params.id).c;
  const items = db.prepare(`
    SELECT d.id, d.title, d.is_official, d.pinned, d.locked, d.created_at,
           u.username, u.nickname, u.role,
           (SELECT COUNT(*) FROM discussion_replies WHERE discussion_id = d.id) as reply_count
    FROM discussions d LEFT JOIN users u ON d.author_id = u.id
    WHERE d.contest_id = ?
    ORDER BY d.pinned DESC, d.is_official DESC, d.id DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, discussions: items });
});

module.exports = router;
