// 试卷内编程题（program）功能集成测试：
// 进程内挂载 express 路由 + 独立临时库，覆盖 创建/校验/ZIP/详情下发/代码提交/
// 单次限制/交卷计分/判题回写/尝试次数/编辑 diff/隔离面。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('exam-program');

// 提高提交限流额度（默认 10/分钟，本文件会发起 9 次提交类请求）
const config = require('../config/config');
config.rateLimit.submissions.max = 200;

// 打桩判题入队：入队会在本进程内立即后台判题（沙箱），与断言竞争状态。
// 提交将停在 pending，用例手动推进为终态来模拟判题完成。
const judge = require('../services/judge');
judge.enqueueSubmission = () => {};

const db = require('../database/db');
const express = require('express');
const AdmZip = require('adm-zip');
const examRoutes = require('../routes/exams');
const submissionRoutes = require('../routes/submissions');
const problemRoutes = require('../routes/problems');
const statusRoutes = require('../routes/status');
const examProgram = require('../services/examProgram');
const { generateAccessToken } = require('../utils/tokens');

describe('Exam program questions', () => {
  let server;
  let base;
  let teacherId, studentId, adminId;
  let teacherTok, studentTok, adminTok;
  let examId, choiceQId, progQId, progProblemId;
  let zipExamId, zipProblemId;
  let normalProblemId;
  let subCode1, subCode2, normalSubId;
  let examSub1Id, examSub2Id;

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

  function programQuestion(fields = {}, problem = {}) {
    return {
      question_type: 'program',
      title: 'A+B 问题',
      score: 30,
      sort_order: 1,
      is_subjective: 0,
      ai_grading_prompt: '',
      ...fields,
      problem: {
        description: '输入两个整数，输出它们的和。',
        background: '',
        input_desc: '一行两个整数 a b',
        output_desc: '一行一个整数',
        hint: '',
        time_limit: 1000,
        memory_limit: 256,
        allowed_languages: ['cpp', 'python3'],
        testcases: [
          { input: '1 2', output: '3', score: 1, subtask: '' },
          { input: '2 3', output: '5', score: 1, subtask: '' },
          { input: '4 5', output: '9', score: 1, subtask: '' }
        ],
        ...problem
      }
    };
  }

  before(async () => {
    await db.initDB();

    teacherId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('ep_teacher', 'hash', 'EP Teacher', 'teacher')").run().lastInsertRowid;
    studentId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('ep_student', 'hash', 'EP Student', 'user')").run().lastInsertRowid;
    adminId = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('ep_admin', 'hash', 'EP Admin', 'admin')").run().lastInsertRowid;
    teacherTok = generateAccessToken(teacherId);
    studentTok = generateAccessToken(studentId);
    adminTok = generateAccessToken(adminId);

    normalProblemId = db.prepare(`
      INSERT INTO problems (title, description, difficulty, is_public, is_hidden, allowed_languages, created_by)
      VALUES ('普通公开题', '普通题描述', 1, 1, 0, '[]', ?)
    `).run(teacherId).lastInsertRowid;

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/exams', examRoutes);
    app.use('/api/v1/submissions', submissionRoutes);
    app.use('/api/v1/problems', problemRoutes);
    app.use('/api/v1/system', statusRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    try {
      const examIds = [examId, zipExamId].filter(Boolean);
      for (const id of examIds) {
        db.prepare('DELETE FROM submission_details WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)').run(id);
        db.prepare('DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id = ?)').run(id);
        db.prepare('DELETE FROM submissions WHERE exam_id = ?').run(id);
        db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(id);
        db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(id);
        for (const r of db.prepare('SELECT id FROM problems WHERE exam_id = ?').all(id)) {
          db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(r.id);
          db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(r.id);
        }
        db.prepare('DELETE FROM problems WHERE exam_id = ?').run(id);
        db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(id);
        db.prepare('DELETE FROM exams WHERE id = ?').run(id);
      }
      if (normalProblemId) {
        db.prepare('DELETE FROM submission_details WHERE submission_id IN (SELECT id FROM submissions WHERE problem_id = ?)').run(normalProblemId);
        db.prepare('DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE problem_id = ?)').run(normalProblemId);
        db.prepare('DELETE FROM submissions WHERE problem_id = ?').run(normalProblemId);
        db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(normalProblemId);
        db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(normalProblemId);
        db.prepare('DELETE FROM problems WHERE id = ?').run(normalProblemId);
      }
      db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(teacherId, studentId, adminId);
    } finally {
      if (server) server.close();
    }
  });

  it('创建试卷：编程题落独立号段、题库隔离字段就位', async () => {
    const r = await api('POST', '/api/v1/exams', teacherTok, {
      title: '程序题期末卷',
      description: '含编程题',
      time_limit: 60,
      pass_score: 40,
      max_attempts: 2,
      show_answer: false,
      is_public: true,
      is_hidden: false,
      allow_ai_grading: true,
      questions: [
        { question_type: 'choice', title: '1 + 1 = ?', options: ['1', '2', '3', '4'], correct_answer: 'B', score: 10, sort_order: 0, is_subjective: 0, ai_grading_prompt: '' },
        programQuestion()
      ]
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    examId = r.data.id;
    assert.equal(r.data.total_score, 40);

    const pq = db.prepare("SELECT * FROM exam_questions WHERE exam_id = ? AND question_type = 'program'").get(examId);
    assert.ok(pq, 'program 题应落库');
    progQId = pq.id;
    progProblemId = pq.problem_id;
    assert.ok(progProblemId >= db.EXAM_PROBLEM_ID_BASE, '试卷题应使用 EXAM_PROBLEM_ID_BASE 独立号段');

    const p = db.prepare('SELECT * FROM problems WHERE id = ?').get(progProblemId);
    assert.equal(p.exam_id, examId);
    assert.equal(p.is_public, 0, '不进题库列表');
    assert.equal(p.is_hidden, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM test_cases WHERE problem_id = ?').get(progProblemId).c, 3);

    choiceQId = db.prepare("SELECT id FROM exam_questions WHERE exam_id = ? AND question_type = 'choice'").get(examId).id;
  });

  it('创建校验：缺 problem / 无测试点 → 400 且不落库', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM exams').get().c;

    let r = await api('POST', '/api/v1/exams', teacherTok, {
      title: '坏卷1',
      questions: [{ question_type: 'program', title: 'x', score: 5, sort_order: 0 }]
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /缺少 problem 配置/);

    r = await api('POST', '/api/v1/exams', teacherTok, {
      title: '坏卷2',
      questions: [{ question_type: 'program', title: 'x', score: 5, sort_order: 0, problem: { description: 'd', testcases: [] } }]
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /至少需要 1 个测试点/);

    assert.equal(db.prepare('SELECT COUNT(*) c FROM exams').get().c, before, '校验失败不应创建试卷');
  });

  it('ZIP 上传：根目录配对 + 子目录 subtask 解析落库', async () => {
    const zip = new AdmZip();
    zip.addFile('1.in', Buffer.from('1 2'));
    zip.addFile('1.out', Buffer.from('3'));
    zip.addFile('s2/2.in', Buffer.from('7 8'));
    zip.addFile('s2/2.out', Buffer.from('15'));
    const b64 = zip.toBuffer().toString('base64');

    const r = await api('POST', '/api/v1/exams', teacherTok, {
      title: 'ZIP 数据卷',
      max_attempts: 1,
      is_public: true,
      questions: [programQuestion({ score: 10 }, { testcases: [], allowed_languages: [], testcase_zip_base64: b64 })]
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    zipExamId = r.data.id;
    zipProblemId = db.prepare('SELECT problem_id FROM exam_questions WHERE exam_id = ?').get(zipExamId).problem_id;

    const cases = db.prepare(`
      SELECT tc.id, g.subtask_id FROM test_cases tc
      LEFT JOIN test_groups g ON g.id = tc.group_id
      WHERE tc.problem_id = ?
    `).all(zipProblemId);
    assert.equal(cases.length, 2, 'ZIP 中两对 in/out 应解析为 2 个测试点');
    assert.ok(cases.some(c => c.subtask_id === 's2'), '子目录应生成 subtask 分组');
    assert.ok(cases.some(c => c.subtask_id === null || c.subtask_id === ''), '根目录测试点无 subtask');
  });

  it('详情下发：考生不泄露测试数据，教师 show_answers 可见', async () => {
    let r = await api('GET', `/api/v1/exams/${examId}`, studentTok);
    assert.equal(r.status, 200);
    const pq = r.data.questions.find(q => q.question_type === 'program');
    assert.equal(pq.program.problem_id, progProblemId);
    assert.deepEqual(pq.program.allowed_languages, ['cpp', 'python3']);
    assert.ok(pq.program.description.length > 0);
    assert.equal(pq.program.testcases, undefined, '考生不应看到测试数据');
    assert.equal(pq.program.problem, undefined, '考生不应看到题目全文配置');

    r = await api('GET', `/api/v1/exams/${examId}?show_answers=true`, teacherTok);
    assert.equal(r.status, 200);
    const tq = r.data.questions.find(q => q.question_type === 'program');
    assert.equal(tq.program.testcases.length, 3);
    assert.ok(tq.program.problem, '教师应能看到 problems 全文');
    assert.ok(tq.problem_id >= db.EXAM_PROBLEM_ID_BASE);
  });

  it('题库列表不包含试卷编程题，包含普通题', async () => {
    const r = await api('GET', '/api/v1/problems?page=1&limit=100', null);
    assert.equal(r.status, 200);
    const ids = r.data.problems.map(p => p.id);
    assert.ok(!ids.includes(progProblemId), '试卷编程题不应出现在题库');
    assert.ok(ids.includes(normalProblemId), '普通公开题应正常出现');
  });

  it('代码提交校验：语言/exam_id 匹配，exam_id 不可伪造', async () => {
    let r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: progProblemId, language: 'java', source_code: 'class Main{}', exam_id: examId
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /not allowed/);

    r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){}', exam_id: examId + 10000
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /不匹配/);

    r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: normalProblemId, language: 'cpp', source_code: 'int main(){}', exam_id: examId
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /仅用于试卷内编程题/);
  });

  it('考生提交代码：落 exam_id/exam_attempt=1，停在 pending', async () => {
    const r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){return 0;}', exam_id: examId
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    subCode1 = r.data.submission_id;

    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(subCode1);
    assert.equal(row.exam_id, examId);
    assert.equal(row.exam_attempt, 1);
    assert.equal(row.status, 'pending');

    assert.equal(examProgram.writeBackAfterJudge(subCode1), false, '判题未结束/无答题记录时不应回写');
  });

  it('交卷：程序题服务端兜底补全，判题中 → grading', async () => {
    const r = await api('POST', `/api/v1/exams/${examId}/submit`, studentTok, {
      answers: [{ question_id: choiceQId, answer: 'B' }]
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    examSub1Id = r.data.submission_id;
    assert.equal(r.data.status, 'grading');
    assert.equal(r.data.has_pending_program, true);
    assert.equal(r.data.has_subjective, false);
    assert.equal(r.data.total_score, 10, '客观题即时计分，程序题判题中 0 分');

    const progAns = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ? AND question_id = ?').get(examSub1Id, progQId);
    assert.ok(progAns, '程序题答题条目应由服务端补全');
    assert.equal(progAns.grading_status, 'pending');
    assert.equal(progAns.code_submission_id, subCode1);
    assert.equal(progAns.max_score, 30);
    assert.equal(progAns.score, 0);

    const choiceAns = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ? AND question_id = ?').get(examSub1Id, choiceQId);
    assert.equal(choiceAns.score, 10);
    assert.equal(choiceAns.grading_status, 'ai_graded');
  });

  it('判题完成回写：按比例折算并重算试卷总分', async () => {
    db.prepare("UPDATE submissions SET status = 'accepted', score = 2 WHERE id = ?").run(subCode1);
    assert.equal(examProgram.writeBackAfterJudge(subCode1), true);

    const progAns = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ? AND question_id = ?').get(examSub1Id, progQId);
    assert.equal(progAns.grading_status, 'ai_graded');
    assert.equal(progAns.score, 20, '30 分题 * 2/3 测试点得分 = 20');
    assert.equal(progAns.is_correct, 0);

    const examSub = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(examSub1Id);
    assert.equal(examSub.total_score, 30, '10（选择）+ 20（程序）');
    assert.equal(examSub.status, 'graded');
  });

  it('第二次尝试：attempt 递增、同尝试单次提交限制', async () => {
    let r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){return 1;}', exam_id: examId
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    subCode2 = r.data.submission_id;
    assert.equal(db.prepare('SELECT exam_attempt FROM submissions WHERE id = ?').get(subCode2).exam_attempt, 2);

    db.prepare("UPDATE submissions SET status = 'wrong_answer' WHERE id = ?").run(subCode2);

    r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){return 2;}', exam_id: examId
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'ERR_ALREADY_SUBMITTED');

    r = await api('GET', `/api/v1/exams/${examId}`, studentTok);
    const pq = r.data.questions.find(q => q.question_type === 'program');
    assert.equal(pq.program.attempt_no, 2);
    assert.equal(pq.program.my_submission.id, subCode2);
    assert.equal(pq.program.my_submission.status, 'wrong_answer');
  });

  it('第二次交卷：无判题中程序题 → 立即 graded', async () => {
    const r = await api('POST', `/api/v1/exams/${examId}/submit`, studentTok, {
      answers: [{ question_id: choiceQId, answer: 'B' }]
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    examSub2Id = r.data.submission_id;
    assert.equal(r.data.has_pending_program, false);
    assert.equal(r.data.status, 'graded');
    assert.equal(r.data.total_score, 10, '选择题 10 + 程序题 0（WA）');
    const examSub2 = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(examSub2Id);
    assert.equal(examSub2.status, 'graded');
    assert.equal(examSub2.max_score, 40);
  });

  it('尝试次数用尽：代码提交与交卷都被拦截', async () => {
    let r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: progProblemId, language: 'cpp', source_code: 'int main(){}', exam_id: examId
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'ERR_MAX_ATTEMPTS');

    r = await api('POST', `/api/v1/exams/${examId}/submit`, studentTok, {
      answers: [{ question_id: choiceQId, answer: 'B' }]
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.reason, 'ERR_MAX_ATTEMPTS');
  });

  it('编辑试卷：非本卷 problem_id 拒绝且不动库', async () => {
    const before = db.prepare('SELECT total_score FROM exams WHERE id = ?').get(examId).total_score;
    const r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, {
      questions: [programQuestion({ problem_id: zipProblemId, score: 40 })]
    });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /不属于该试卷/);
    assert.equal(db.prepare('SELECT total_score FROM exams WHERE id = ?').get(examId).total_score, before);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM test_cases WHERE problem_id = ?').get(progProblemId).c,
      3,
      '校验失败不应改动测试数据'
    );
  });

  it('编辑试卷：同 problem_id 更新题面/分值/测试点并刷新已判分', async () => {
    const r = await api('PUT', `/api/v1/exams/${examId}`, teacherTok, {
      questions: [
        { question_type: 'choice', title: '1 + 1 = ?', options: ['1', '2', '3', '4'], correct_answer: 'B', score: 10, sort_order: 0, is_subjective: 0, ai_grading_prompt: '' },
        programQuestion(
          { problem_id: progProblemId, score: 40, title: 'A+B 问题（改）' },
          {
            description: '输入两个整数，输出它们的和。（v2）',
            testcases: [
              { input: '1 2', output: '3', score: 1, subtask: '' },
              { input: '7 8', output: '15', score: 1, subtask: '' }
            ]
          }
        )
      ]
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total_score, 50);

    const p = db.prepare('SELECT * FROM problems WHERE id = ?').get(progProblemId);
    assert.equal(p.exam_id, examId, '原 problem 应原地更新而非重建');
    assert.match(p.description, /v2/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM test_cases WHERE problem_id = ?').get(progProblemId).c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM test_groups WHERE problem_id = ?').get(progProblemId).c, 0);

    const pq = db.prepare("SELECT score FROM exam_questions WHERE exam_id = ? AND question_type = 'program'").get(examId);
    assert.equal(pq.score, 40);

    const progAns = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ? AND question_id = ?').get(examSub1Id, progQId);
    assert.equal(progAns.max_score, 40, '题分变更应同步答题满分');
    assert.equal(progAns.score, 40, 'accepted 2/2 → 满折算 40 分');

    const examSub = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(examSub1Id);
    assert.equal(examSub.total_score, 40, '选择题被全量替换级联清理后仅剩程序题 40 分');
    assert.equal(examSub.status, 'graded');
  });

  it('隔离面：全站提交记录/统计不含试卷代码提交', async () => {
    const r = await api('POST', '/api/v1/submissions', studentTok, {
      problem_id: normalProblemId, language: 'cpp', source_code: 'int main(){return 0;}'
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    normalSubId = r.data.submission_id;

    const list = await api('GET', '/api/v1/submissions?page=1&limit=100', studentTok);
    assert.equal(list.status, 200);
    const ids = list.data.submissions.map(s => s.id);
    assert.ok(ids.includes(normalSubId), '普通提交应可见');
    assert.ok(!ids.includes(subCode1), '试卷代码提交不应进全站记录');
    assert.ok(!ids.includes(subCode2), '试卷代码提交不应进全站记录');

    const status = await api('GET', '/api/v1/system/status', adminTok);
    assert.equal(status.status, 200);
    const dbTotal = db.prepare('SELECT COUNT(*) c FROM submissions').get().c;
    assert.equal(dbTotal, 3, '库里 2 条试卷提交 + 1 条普通提交');
    assert.equal(status.data.counts.submissions, 1, '系统统计只计非试卷提交');
  });
});
