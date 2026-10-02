// 试卷时间窗与排行榜（exam leaderboard）集成测试：
// 进程内挂载 express 路由 + 独立临时库，覆盖 时间窗校验/开考前后门禁/
// 排行榜完成门槛与总开关/排名与最佳尝试/手动封解榜/自动封榜与结束自动解封。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('exam-leaderboard');

const config = require('../config/config');
config.rateLimit.submissions.max = 200;

const judge = require('../services/judge');
judge.enqueueSubmission = () => {};

const db = require('../database/db');
const express = require('express');
const examRoutes = require('../routes/exams');
const submissionRoutes = require('../routes/submissions');
const { generateAccessToken } = require('../utils/tokens');

describe('Exam leaderboard & time window', () => {
  let server;
  let base;
  let teacherId, stu1Id, stu2Id, stu3Id, stu4Id, stu5Id;
  let teacherTok, stu1Tok, stu4Tok;
  let examId, progProblemId, choiceQId;
  let stu1CodeId;

  async function api(method, p, token, body) {
    const res = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }

  function iso(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString();
  }

  function insertExamSub(userId, score, submittedAt) {
    return db.prepare(`
      INSERT INTO exam_submissions (exam_id, user_id, status, total_score, max_score, submitted_at)
      VALUES (?, ?, 'graded', ?, 100, ?)
    `).run(examId, userId, score, submittedAt).lastInsertRowid;
  }

  before(async () => {
    await db.initDB();

    teacherId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('elb_teacher', 'hash', 'ELB Teacher', 'teacher')").run().lastInsertRowid;
    stu1Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('elb_stu1', 'hash', 'Stu One', 'user')").run().lastInsertRowid;
    stu2Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('elb_stu2', 'hash', 'Stu Two', 'user')").run().lastInsertRowid;
    stu3Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('elb_stu3', 'hash', '', 'user')").run().lastInsertRowid;
    stu4Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('elb_stu4', 'hash', 'Stu Four', 'user')").run().lastInsertRowid;
    stu5Id = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('elb_stu5', 'hash', 'Stu Five', 'user')").run().lastInsertRowid;
    teacherTok = generateAccessToken(teacherId);
    stu1Tok = generateAccessToken(stu1Id);
    stu4Tok = generateAccessToken(stu4Id);

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/exams', examRoutes);
    app.use('/api/v1/submissions', submissionRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    try {
      if (examId) {
        db.prepare('DELETE FROM submission_details WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)').run(examId);
        db.prepare('DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)').run(examId);
        db.prepare('DELETE FROM submissions WHERE exam_id = ?').run(examId);
        db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(examId);
        db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(examId);
        db.prepare('DELETE FROM problems WHERE exam_id = ?').run(examId);
        db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
        db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
      }
      db.prepare('DELETE FROM users WHERE id IN (?, ?, ?, ?, ?, ?)').run(teacherId, stu1Id, stu2Id, stu3Id, stu4Id, stu5Id);
    } finally {
      if (server) server.close();
    }
  });

  it('创建试卷：时间窗与排行榜设置落库；单边时间/顺序颠倒 → 400', async () => {
    // 只给开考时间 → 400
    let r = await api('POST', '/api/v1/exams', teacherTok, {
      title: '时间窗卷',
      start_time: iso(3600000)
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /同时设置或同时留空/);

    // 结束早于开考 → 400
    r = await api('POST', '/api/v1/exams', teacherTok, {
      title: '时间窗卷',
      start_time: iso(7200000),
      end_time: iso(3600000)
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /必须晚于/);

    // 正常创建（未来窗口）
    r = await api('POST', '/api/v1/exams', teacherTok, {
      title: '排行榜测试卷',
      description: '窗口 + 封榜',
      time_limit: 0,
      max_attempts: 0,
      is_public: true,
      start_time: iso(3600000),
      end_time: iso(7200000),
      freeze_minutes: 10,
      leaderboard_enabled: true,
      leaderboard_view_incomplete: false,
      questions: [
        { question_type: 'choice', title: '1 + 1 = ?', options: ['1', '2'], correct_answer: 'B', score: 10, sort_order: 0, is_subjective: 0, ai_grading_prompt: '' },
        {
          question_type: 'program', title: 'A+B', score: 30, sort_order: 1, is_subjective: 0,
          problem: {
            description: '求和', background: '', input_desc: 'a b', output_desc: 'sum', hint: '',
            time_limit: 1000, memory_limit: 256, allowed_languages: ['cpp'],
            testcases: [{ input: '1 2', output: '3', score: 1, subtask: '' }]
          }
        }
      ]
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    examId = r.data.id;
    assert.match(r.data.start_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'start_time 应归一化为 ISO8601 UTC');
    assert.equal(r.data.freeze_minutes, 10);
    assert.equal(r.data.leaderboard_enabled, 1);
    assert.equal(r.data.leaderboard_view_incomplete, 0);
    assert.equal(r.data.manual_frozen, 0);
    assert.equal(r.data.unfrozen, 0);

    choiceQId = db.prepare("SELECT id FROM exam_questions WHERE exam_id = ? AND question_type = 'choice'").get(examId).id;
    progProblemId = db.prepare("SELECT problem_id FROM exam_questions WHERE exam_id = ? AND question_type = 'program'").get(examId).problem_id;

    // PUT 非法窗口：不动库
    const before = db.prepare('SELECT start_time, end_time FROM exams WHERE id = ?').get(examId);
    r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { end_time: before.start_time, start_time: before.end_time });
    assert.equal(r.status, 400);
    const afterRow = db.prepare('SELECT start_time, end_time FROM exams WHERE id = ?').get(examId);
    assert.deepEqual(afterRow, before, '校验失败不应改动时间窗');
  });

  it('开考前：考生详情/交卷/代码提交 403，教师可预览', async () => {
    let r = await api('GET', `/api/v1/exams/${examId}`, stu1Tok);
    assert.equal(r.status, 403);
    assert.match(r.data.message, /尚未开始/);

    r = await api('POST', `/api/v1/exams/${examId}/submit`, stu1Tok, { answers: [] });
    assert.equal(r.status, 403);
    assert.match(r.data.message, /尚未开始/);

    r = await api('POST', '/api/v1/submissions', stu1Tok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){}', exam_id: examId
    });
    assert.equal(r.status, 403);
    assert.match(r.data.message, /尚未开始/);

    r = await api('GET', `/api/v1/exams/${examId}?show_answers=true`, teacherTok);
    assert.equal(r.status, 200, '教师开考前可预览');
  });

  it('进行中：考生可提交代码并交卷', async () => {
    let r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, {
      start_time: iso(-60000),
      end_time: iso(3600000)
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));

    r = await api('GET', `/api/v1/exams/${examId}`, stu1Tok);
    assert.equal(r.status, 200, '进行中详情可访问');

    r = await api('POST', '/api/v1/submissions', stu1Tok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){return 0;}', exam_id: examId
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    stu1CodeId = r.data.submission_id;
    db.prepare("UPDATE submissions SET status = 'accepted', score = 1 WHERE id = ?").run(stu1CodeId);

    r = await api('POST', `/api/v1/exams/${examId}/submit`, stu1Tok, { answers: [] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok(db.prepare('SELECT 1 as x FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(examId, stu1Id), 'stu1 已完成（有交卷记录）');
  });

  it('排行榜门禁：默认仅完成者可看；总开关与未完成放开', async () => {
    // stu4 未完成 → 403
    let r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu4Tok);
    assert.equal(r.status, 403);
    assert.match(r.data.message, /完成考试后/);

    // 匿名 → 403
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, null);
    assert.equal(r.status, 403);

    // stu1 已完成 → 200；教师 → 200
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.status, 200);
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, teacherTok);
    assert.equal(r.status, 200);

    // 放开未完成：stu4 与匿名均可看
    r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { leaderboard_view_incomplete: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.leaderboard_view_incomplete, 1);
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu4Tok);
    assert.equal(r.status, 200);
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, null);
    assert.equal(r.status, 200);

    // 收回：未完成再次 403
    await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { leaderboard_view_incomplete: false });

    // 总开关关闭 → 404
    r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { leaderboard_enabled: false });
    assert.equal(r.status, 200);
    assert.equal(r.data.leaderboard_enabled, 0);
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.status, 404);

    // 重新启用
    r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { leaderboard_enabled: true });
    assert.equal(r.data.leaderboard_enabled, 1);
  });

  it('排名：分数降序、同分先交卷靠前、每人取最佳尝试、教师不入榜', async () => {
    insertExamSub(stu1Id, 85, '2000-01-01 12:00:00');
    insertExamSub(stu2Id, 90, '2000-01-01 11:00:00');
    insertExamSub(stu3Id, 90, '2000-01-01 09:00:00');
    insertExamSub(stu5Id, 95, '2999-01-01 00:00:00');
    insertExamSub(teacherId, 100, '2000-01-01 08:00:00');

    const r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const list = r.data.leaderboard;
    assert.deepEqual(list.map(x => [x.rank, x.username, x.total_score]), [
      [1, 'elb_stu5', 95],
      [2, 'elb_stu3', 90],
      [3, 'elb_stu2', 90],
      [4, 'elb_stu1', 85]
    ], '分数降序、同分先交卷者靠前、教师行被过滤');
    assert.equal(list.find(x => x.username === 'elb_stu3').nickname, '', 'nickname 为空时回落空串');

    const mine = r.data.my;
    assert.ok(mine, '应返回我的名次');
    assert.equal(mine.rank, 4);
    assert.equal(mine.total_score, 85);
    assert.equal(mine.attempts, 2, 'stu1 共 2 次交卷记录（窗口测试 1 次 + 插入 1 次）');

    const lim = await api('GET', `/api/v1/exams/${examId}/leaderboard?limit=2`, stu1Tok);
    assert.equal(lim.data.leaderboard.length, 2);
    assert.equal(lim.data.leaderboard[0].username, 'elb_stu5');
  });

  it('手动封榜：封榜后 2999 交卷不入榜；解榜恢复实时', async () => {
    let r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { manual_frozen: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.manual_frozen, 1);
    assert.equal(r.data.unfrozen, 0, '封榜动作应清除手动解榜标记');
    assert.ok(r.data.manual_frozen_at, '应写入封榜快照锚点');

    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.data.frozen, true);
    assert.equal(r.data.freeze_source, 'manual');
    const names = r.data.leaderboard.map(x => x.username);
    assert.ok(!names.includes('elb_stu5'), '封榜时刻后的交卷不应入榜');
    assert.ok(names.includes('elb_stu3'), '封榜时刻前的交卷应保留');
    assert.ok(names.includes('elb_stu1'));

    // 解榜：manual_frozen=0 + unfrozen=1（榜单实时公开）
    r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { manual_frozen: false, unfrozen: true });
    assert.equal(r.data.manual_frozen, 0);
    assert.equal(r.data.unfrozen, 1);
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.data.frozen, false);
    assert.ok(r.data.leaderboard.some(x => x.username === 'elb_stu5'), '解榜后 2999 交卷恢复上榜');
  });

  it('自动封榜：进入结束前 N 分钟窗口冻结；结束后自动解封', async () => {
    const start = iso(-600000);
    const end = iso(300000);
    let r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, {
      start_time: start,
      end_time: end,
      freeze_minutes: 10,
      unfrozen: false
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));

    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.data.frozen, true, '当前时刻已进入结束前 10 分钟窗口');
    assert.equal(r.data.freeze_source, 'auto');
    assert.equal(Date.parse(r.data.freeze_at), Date.parse(end) - 10 * 60000, '冻结锚点 = 结束 - N 分钟');
    const names = r.data.leaderboard.map(x => x.username);
    assert.ok(names.includes('elb_stu3'), '窗口前交卷入榜');
    assert.ok(!names.includes('elb_stu5'), '窗口后交卷不入榜');

    // 结束后 → 自动解封（全量公开）
    r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, { end_time: iso(-60000) });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/v1/exams/${examId}/leaderboard`, stu1Tok);
    assert.equal(r.data.frozen, false, '结束后自动解封');
    assert.equal(r.data.freeze_at, null);
    assert.ok(r.data.leaderboard.some(x => x.username === 'elb_stu5'));
  });

  it('结束后：考生详情可看（结果页），交卷与代码提交 403', async () => {
    let r = await api('GET', `/api/v1/exams/${examId}`, stu1Tok);
    assert.equal(r.status, 200, '结束后仍可查看详情/结果');

    r = await api('POST', `/api/v1/exams/${examId}/submit`, stu1Tok, { answers: [{ question_id: choiceQId, answer: 'B' }] });
    assert.equal(r.status, 403);
    assert.match(r.data.message, /已结束/);

    r = await api('POST', '/api/v1/submissions', stu1Tok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){return 1;}', exam_id: examId
    });
    assert.equal(r.status, 403);
    assert.match(r.data.message, /已结束/);

    // 教师不受窗口限制
    r = await api('GET', `/api/v1/exams/${examId}`, teacherTok);
    assert.equal(r.status, 200);
  });
});
