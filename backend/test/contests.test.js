const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database/db');

describe('Contests & Leaderboard Time-Filtering', () => {
  let contestId;
  let problemId;
  let userAId;
  let userBId;
  const startTimeStr = '2026-09-27 10:00:00';
  const endTimeStr   = '2026-09-27 15:00:00';
  const freezeAtStr  = '2026-09-27 14:00:00'; // 封榜时刻

  before(async () => {
    await db.initDB();
    // 准备测试用户
    db.prepare("DELETE FROM users WHERE username IN ('ct_user_a', 'ct_user_b')").run();
    userAId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('ct_user_a', 'h', 'Alice', 'user')").run().lastInsertRowid;
    userBId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('ct_user_b', 'h', 'Bob', 'user')").run().lastInsertRowid;

    // 准备测试题目
    const pRes = db.prepare("INSERT INTO problems (title, description, time_limit, memory_limit) VALUES ('Contest Problem 1', 'desc', 1000, 128)").run();
    problemId = pRes.lastInsertRowid;

    // 准备比赛 (10:00 到 15:00, 封榜 60 分钟即 14:00 封榜)
    const cRes = db.prepare(`
      INSERT INTO contests (title, description, start_time, end_time, freeze_minutes, is_hidden, created_by)
      VALUES ('测试算法对抗赛', '自动化测试比赛', ?, ?, 60, 0, ?)
    `).run(startTimeStr, endTimeStr, userAId);
    contestId = cRes.lastInsertRowid;

    // 关联题目与报名
    db.prepare("INSERT INTO contest_problems (contest_id, problem_id, sort_order) VALUES (?, ?, 1)").run(contestId, problemId);
    db.prepare("INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)").run(contestId, userAId);
    db.prepare("INSERT INTO contest_participants (contest_id, user_id) VALUES (?, ?)").run(contestId, userBId);
  });

  after(() => {
    // 清理数据
    db.prepare("DELETE FROM submissions WHERE problem_id = ?").run(problemId);
    db.prepare("DELETE FROM contest_participants WHERE contest_id = ?").run(contestId);
    db.prepare("DELETE FROM contest_problems WHERE contest_id = ?").run(contestId);
    db.prepare("DELETE FROM contests WHERE id = ?").run(contestId);
    db.prepare("DELETE FROM problems WHERE id = ?").run(problemId);
    db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(userAId, userBId);
  });

  it('比赛时间过滤：赛前提交不计入比赛榜单，赛中提交正常计入', () => {
    // User A 在比赛开始前（09:30:00）有一条历史 AC 提交
    const subPreId = db.findNextId('submissions');
    db.prepare(`
      INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, time_used, created_at)
      VALUES (?, ?, ?, 'cpp', 'int main(){}', 'accepted', 100, 15, '2026-09-27 09:30:00')
    `).run(subPreId, userAId, problemId);

    // User B 在比赛中（11:00:00）提交了 AC
    const subMidBId = db.findNextId('submissions');
    db.prepare(`
      INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, time_used, created_at)
      VALUES (?, ?, ?, 'cpp', 'int main(){}', 'accepted', 100, 25, '2026-09-27 11:00:00')
    `).run(subMidBId, userBId, problemId);

    // 查询未封榜状态下的排行榜（比赛起止时间范围内）
    const toSqliteUtc = (d) => {
      const date = new Date(d);
      return isNaN(date.getTime()) ? null : date.toISOString().replace('T', ' ').substring(0, 19);
    };

    let timeFilter = ' AND s.created_at >= ? AND s.created_at <= ?';
    const params = [problemId, startTimeStr, endTimeStr, contestId];

    const submissions = db.prepare(`
      SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username
      FROM submissions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.problem_id IN (?)
        AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
        ${timeFilter}
        AND s.user_id IN (SELECT user_id FROM contest_participants WHERE contest_id = ?)
    `).all(...params);

    // 应该只查到 User B 的提交，User A 赛前的提交被正确过滤排除了
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].user_id, userBId);
    assert.equal(submissions[0].score, 100);
  });

  it('封榜机制：封榜时刻（14:00）后的提交不计入封榜排行榜', () => {
    // User A 在封榜后（14:30:00）提交 AC
    const subPostId = db.findNextId('submissions');
    db.prepare(`
      INSERT INTO submissions (id, user_id, problem_id, language, source_code, status, score, time_used, created_at)
      VALUES (?, ?, ?, 'cpp', 'int main(){}', 'accepted', 100, 10, '2026-09-27 14:30:00')
    `).run(subPostId, userAId, problemId);

    // 处于冻结状态时，截止时间应为 freezeAtStr
    const timeFilter = ' AND s.created_at >= ? AND s.created_at <= ?';
    const params = [problemId, startTimeStr, freezeAtStr, contestId];

    const submissions = db.prepare(`
      SELECT s.user_id, s.problem_id, s.score, s.time_used, s.status, u.username
      FROM submissions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.problem_id IN (?)
        AND s.status IN ('accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'skipped')
        ${timeFilter}
        AND s.user_id IN (SELECT user_id FROM contest_participants WHERE contest_id = ?)
    `).all(...params);

    // 封榜排行榜仍只应包含 User B（11:00 的提交），User A 在 14:30 的提交被封锁未呈现
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].user_id, userBId);
  });
});
