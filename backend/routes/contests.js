const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  const { page = 1, limit = 50, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '';
  const params = [];
  if (search) {
    const fuzzy = '%' + search.replace(/\s+/g, '') + '%';
    where = 'WHERE REPLACE(c.title, \' \', \'\') LIKE ? OR REPLACE(c.description, \' \', \'\') LIKE ?';
    params.push(fuzzy, fuzzy);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM contests c ${where}`).get(...params).c;
  const contests = db.prepare(`
    SELECT c.*, u.username as creator_name,
      (SELECT COUNT(*) FROM contest_problems WHERE contest_id = c.id) as problem_count
    FROM contests c LEFT JOIN users u ON c.created_by = u.id
    ${where}
    ORDER BY c.id DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);
  res.json({ total, page: parseInt(page), limit: parseInt(limit), contests });
});

router.get('/:id', (req, res) => {
  const contest = db.prepare('SELECT c.*, u.username as creator_name FROM contests c LEFT JOIN users u ON c.created_by = u.id WHERE c.id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  let problems = [];
  if (req.user && ['teacher', 'admin', 'su'].includes(req.user.role)) {
    problems = db.prepare(`
      SELECT cp.sort_order, cp.alias, p.id, p.title, p.time_limit, p.memory_limit, p.is_public
      FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
      WHERE cp.contest_id = ? ORDER BY cp.sort_order
    `).all(contest.id);
  } else {
    problems = db.prepare(`
      SELECT cp.sort_order, cp.alias, p.id, p.title, p.time_limit, p.memory_limit
      FROM contest_problems cp JOIN problems p ON cp.problem_id = p.id
      WHERE cp.contest_id = ? ORDER BY cp.sort_order
    `).all(contest.id);
  }
  const participantCount = db.prepare('SELECT COUNT(*) as c FROM contest_participants WHERE contest_id = ?').get(contest.id).c;
  res.json({ ...contest, problems, participant_count: participantCount });
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, start_time, end_time, is_virtual } = req.body;
  if (!title || !start_time || !end_time) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title, start_time, and end_time are required.' });
  }
  const result = db.prepare('INSERT INTO contests (title, description, start_time, end_time, is_virtual, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(title, description || '', start_time, end_time, is_virtual ? 1 : 0, req.user.id);
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(contest);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }
  const { title, description, start_time, end_time, is_virtual } = req.body;
  const updates = [];
  const values = [];
  if (title !== undefined) { updates.push('title = ?'); values.push(title); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (start_time !== undefined) { updates.push('start_time = ?'); values.push(start_time); }
  if (end_time !== undefined) { updates.push('end_time = ?'); values.push(end_time); }
  if (is_virtual !== undefined) { updates.push('is_virtual = ?'); values.push(is_virtual ? 1 : 0); }

  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(contest.id);
  db.prepare(`UPDATE contests SET ${updates.join(', ')} WHERE id = ?`).run(...values);
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

router.get('/:id/leaderboard', (req, res) => {
  const contest = db.prepare('SELECT * FROM contests WHERE id = ?').get(req.params.id);
  if (!contest) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Contest not found.' });
  }

  const contestProblems = db.prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ?').all(contest.id);
  if (contestProblems.length === 0) return res.json({ leaderboard: [] });

  const problemIds = contestProblems.map(p => p.problem_id);
  const placeholders = problemIds.map(() => '?').join(',');

  const submissions = db.prepare(`
    SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username, u.nickname
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.problem_id IN (${placeholders})
      AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
  `).all(...problemIds);

  const userMap = {};
  for (const s of submissions) {
    if (!userMap[s.user_id]) {
      userMap[s.user_id] = { user_id: s.user_id, username: s.username, nickname: s.nickname, total_score: 0, total_time: 0, problems: {} };
    }
    const um = userMap[s.user_id];
    if (!um.problems[s.problem_id] || s.score > um.problems[s.problem_id].score ||
        (s.score === um.problems[s.problem_id].score && s.time_used < um.problems[s.problem_id].time_used)) {
      um.problems[s.problem_id] = { score: s.score, time_used: s.time_used, status: s.status };
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

  res.json({ leaderboard, problem_ids: problemIds });
});

// 比赛内公告
router.get('/:id/announcements', (req, res) => {
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

module.exports = router;
