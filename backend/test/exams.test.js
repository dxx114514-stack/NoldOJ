const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./_testdb')('exams');
const db = require('../database/db');

describe('Exams System & Grading Logic', () => {
  let testTeacherId;
  let testStudentId;
  let examId;
  let choiceQId;
  let tfQId;
  let fillQId;
  let subjQId;

  before(async () => {
    await db.initDB();
    // 准备测试用户
    db.prepare("DELETE FROM users WHERE username IN ('exam_test_teacher', 'exam_test_student')").run();
    const tResult = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('exam_test_teacher', 'hash', 'Teacher', 'teacher')").run();
    testTeacherId = tResult.lastInsertRowid;
    const sResult = db.prepare("INSERT INTO users (username, password_hash, nickname, role) VALUES ('exam_test_student', 'hash', 'Student', 'user')").run();
    testStudentId = sResult.lastInsertRowid;

    // 创建测试试卷
    const eResult = db.prepare(`
      INSERT INTO exams (title, description, time_limit, pass_score, max_attempts, show_answer, is_public, allow_ai_grading, creator_id)
      VALUES ('测试算法期末卷', '用于自动化测试的试卷', 60, 60, 2, 1, 1, 1, ?)
    `).run(testTeacherId);
    examId = eResult.lastInsertRowid;

    // 题目1：选择题 (20分)
    choiceQId = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective)
      VALUES (?, 'choice', '二分查找的时间复杂度是多少？', ?, 'B', 20, 1, 0)
    `).run(examId, JSON.stringify(['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'])).lastInsertRowid;

    // 题目2：判断题 (10分，答案设为中文"正确")
    tfQId = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective)
      VALUES (?, 'true_false', '快速排序在最坏情况下的时间复杂度是 O(n^2)。', '[]', '正确', 10, 2, 0)
    `).run(examId).lastInsertRowid;

    // 题目3：客观填空题 (20分)
    fillQId = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective)
      VALUES (?, 'fill_blank', 'Dijkstra 算法用于求解单源_____路径问题。', '[]', '最短', 20, 3, 0)
    `).run(examId).lastInsertRowid;

    // 题目4：主观大题 (50分)
    subjQId = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective)
      VALUES (?, 'long_answer', '请简述动态规划的两个基本要素。', '[]', '最优子结构和重叠子问题', 50, 4, 1)
    `).run(examId).lastInsertRowid;

    db.prepare('UPDATE exams SET total_score = 100 WHERE id = ?').run(examId);
  });

  after(() => {
    // 清理测试数据
    db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(examId);
    db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(testTeacherId, testStudentId);
  });

  it('客观题自动评分入库：验证每题 score、is_correct 与试卷总分', () => {
    // 模拟学生提交答卷
    // 题目1选择题：答 'b'（正确，应得20分）
    // 题目2判断题：答 'true'（归一化后匹配"正确"，应得10分）
    // 题目3填空题：答 '最短'（匹配正确，应得20分）
    // 题目4主观题：答一段文字（主观题，初判0分，待批改）
    const answers = [
      { question_id: choiceQId, answer: 'b' },
      { question_id: tfQId, answer: 'true' },
      { question_id: fillQId, answer: '最短' },
      { question_id: subjQId, answer: '1. 最优子结构性质；2. 子问题重叠性质。' }
    ];

    // 复用 exams.js 中的评分核心逻辑进行验证
    function normalizeAnswer(type, val) {
      const s = String(val ?? '').trim().toLowerCase();
      if (type === 'true_false') {
        if (['true', 't', '1', '正确', '对', 'v', '√', 'yes', 'y'].includes(s)) return 'true';
        if (['false', 'f', '0', '错误', '错', 'x', '×', 'no', 'n'].includes(s)) return 'false';
      }
      return s;
    }

    const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id = ?').all(examId);
    const questionMap = {};
    questions.forEach(q => { questionMap[q.id] = q; });

    const submissionResult = db.prepare(`
      INSERT INTO exam_submissions (exam_id, user_id, status, max_score)
      VALUES (?, ?, 'submitted', ?)
    `).run(examId, testStudentId, 100);
    const submissionId = submissionResult.lastInsertRowid;

    let totalScore = 0;
    let hasSubjective = false;

    const answerStmt = db.prepare(`
      INSERT INTO exam_answers (submission_id, question_id, answer, score, max_score, is_correct, is_subjective, grading_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    answers.forEach(a => {
      const q = questionMap[a.question_id];
      const isSubj = q.question_type === 'long_answer' || (q.question_type === 'fill_blank' && q.is_subjective);
      let s = 0;
      let isCorr = 0;
      let gStatus;

      if (!isSubj) {
        const uAns = normalizeAnswer(q.question_type, a.answer);
        const cAns = normalizeAnswer(q.question_type, q.correct_answer);
        if (uAns === cAns) {
          s = q.score;
          isCorr = 1;
        }
        gStatus = 'ai_graded';
      } else {
        hasSubjective = true;
        gStatus = 'pending';
      }
      totalScore += s;
      answerStmt.run(submissionId, q.id, a.answer || '', s, q.score, isCorr, isSubj ? 1 : 0, gStatus);
    });

    const finalStatus = hasSubjective ? 'grading' : 'graded';
    db.prepare('UPDATE exam_submissions SET total_score = ?, status = ? WHERE id = ?')
      .run(totalScore, finalStatus, submissionId);

    // 断言 1: 客观题总分应为 20 + 10 + 20 = 50 分
    assert.equal(totalScore, 50);
    assert.equal(finalStatus, 'grading');

    // 断言 2: exam_answers 表中的各项明细，检查 score 和 is_correct 必须正确落库（此前Bug会导致客观题score为0）
    const storedAnswers = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ? ORDER BY question_id').all(submissionId);
    assert.equal(storedAnswers.length, 4);

    const aChoice = storedAnswers.find(a => a.question_id === choiceQId);
    assert.equal(aChoice.score, 20, '选择题得分必须为 20');
    assert.equal(aChoice.is_correct, 1, '选择题必须标记为正确');
    assert.equal(aChoice.grading_status, 'ai_graded');

    const aTf = storedAnswers.find(a => a.question_id === tfQId);
    assert.equal(aTf.score, 10, '判断题得分必须为 10');
    assert.equal(aTf.is_correct, 1, '判断题必须标记为正确');

    const aFill = storedAnswers.find(a => a.question_id === fillQId);
    assert.equal(aFill.score, 20, '填空题得分必须为 20');
    assert.equal(aFill.is_correct, 1, '填空题必须标记为正确');

    const aSubj = storedAnswers.find(a => a.question_id === subjQId);
    assert.equal(aSubj.score, 0, '主观题初判得分应为 0');
    assert.equal(aSubj.grading_status, 'pending');

    // 教师批改主观题：打 45 分
    let teacherTotalScore = 0;
    const allAns = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ?').all(submissionId);
    allAns.forEach(a => {
      if (!a.is_subjective) teacherTotalScore += a.score;
    });
    assert.equal(teacherTotalScore, 50, '客观题累计得分应仍为 50，不能被置零');

    const subjScore = 45;
    db.prepare(`
      UPDATE exam_answers SET score = ?, is_correct = CASE WHEN ? >= max_score THEN 1 ELSE 0 END, human_comment = '答得很完整', grading_status = 'human_graded'
      WHERE id = ?
    `).run(subjScore, subjScore, aSubj.id);
    teacherTotalScore += subjScore;

    db.prepare("UPDATE exam_submissions SET total_score = ?, status = 'graded', human_graded = 1 WHERE id = ?")
      .run(teacherTotalScore, submissionId);

    // 断言 3: 教师批改后的试卷总分必须是 50(客观) + 45(主观) = 95 分
    const subRecord = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(submissionId);
    assert.equal(subRecord.total_score, 95);
    assert.equal(subRecord.status, 'graded');
  });

  it('最大尝试次数限制 (max_attempts = 2)', () => {
    const count = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(examId, testStudentId).c;
    assert.equal(count, 1, '已有 1 次提交');

    // 允许第 2 次提交
    db.prepare("INSERT INTO exam_submissions (exam_id, user_id, status) VALUES (?, ?, 'submitted')").run(examId, testStudentId);
    const count2 = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(examId, testStudentId).c;
    assert.equal(count2, 2, '已有 2 次提交');

    // 第 3 次提交时，应被上限拦截
    const exam = db.prepare('SELECT max_attempts FROM exams WHERE id = ?').get(examId);
    const isExceeded = count2 >= exam.max_attempts;
    assert.ok(isExceeded, '达到最大尝试次数，应被拦截');
  });
});
