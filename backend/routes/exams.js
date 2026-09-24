const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { sanitizeText } = require('../utils/securityHelpers');

const router = express.Router();

// 获取试卷列表
router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 20, 100);

  let where = '';
  const params = [];

  if (!req.user || !['teacher', 'admin', 'su'].includes(req.user.role)) {
    where = 'WHERE e.is_public = 1 AND e.is_hidden = 0';
  }

  if (search) {
    const cond = "REPLACE(e.title, ' ', '') LIKE ?";
    where = where ? `${where} AND (${cond})` : `WHERE (${cond})`;
    params.push('%' + search.replace(/\s+/g, '') + '%');
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM exams e ${where}`).get(...params).c;

  const exams = db.prepare(`
    SELECT e.*, u.username as creator_name,
      (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) as question_count,
      (SELECT COUNT(*) FROM exam_submissions WHERE exam_id = e.id) as submission_count
    FROM exams e LEFT JOIN users u ON e.creator_id = u.id
    ${where}
    ORDER BY e.id DESC LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, exams });
});

// 获取试卷详情
router.get('/:id', optionalAuth, (req, res) => {
  const exam = db.prepare(`
    SELECT e.*, u.username as creator_name
    FROM exams e LEFT JOIN users u ON e.creator_id = u.id
    WHERE e.id = ?
  `).get(req.params.id);

  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  if (exam.is_hidden && !(req.user && ['teacher', 'admin', 'su'].includes(req.user.role))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam not found.' });
  }

  // 获取题目（不含答案，除非是教师+且有查询参数 show_answers=true）
  const showAnswers = req.query.show_answers === 'true' && req.user && ['teacher', 'admin', 'su'].includes(req.user.role);

  let questions;
  if (showAnswers) {
    questions = db.prepare(`
      SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY sort_order
    `).all(exam.id);
  } else {
    questions = db.prepare(`
      SELECT id, exam_id, question_type, title, options, score, sort_order, is_subjective
      FROM exam_questions WHERE exam_id = ? ORDER BY sort_order
    `).all(exam.id);
  }

  // 如果已登录，获取用户提交记录
  let userSubmission = null;
  if (req.user) {
    userSubmission = db.prepare(`
      SELECT * FROM exam_submissions WHERE exam_id = ? AND user_id = ?
      ORDER BY submitted_at DESC LIMIT 1
    `).get(exam.id, req.user.id);
  }

  res.json({ ...exam, questions, user_submission: userSubmission });
});

// 创建试卷
router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading, questions } = req.body;

  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'title is required.' });
  }

  const result = db.prepare(`
    INSERT INTO exams (title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading, creator_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sanitizeText(title).trim(),
    sanitizeText(description || ''),
    time_limit || 0,
    pass_score || 0,
    max_attempts || 1,
    show_answer ? 1 : 0,
    is_public !== false ? 1 : 0,
    is_hidden ? 1 : 0,
    allow_ai_grading !== false ? 1 : 0,
    req.user.id
  );

  const examId = result.lastInsertRowid;

  // 创建题目
  if (Array.isArray(questions) && questions.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective, ai_grading_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalScore = 0;
    questions.forEach((q, i) => {
      stmt.run(
        examId,
        q.question_type,
        sanitizeText(q.title),
        JSON.stringify(q.options || []),
        q.correct_answer || '',
        q.score || 0,
        q.sort_order || i,
        q.is_subjective ? 1 : 0,
        q.ai_grading_prompt || ''
      );
      totalScore += q.score || 0;
    });

    // 更新总分
    db.prepare('UPDATE exams SET total_score = ? WHERE id = ?').run(totalScore, examId);
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  res.status(201).json(exam);
});

// 更新试卷
router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  const { title, description, time_limit, pass_score, max_attempts, show_answer, is_public, is_hidden, allow_ai_grading, questions } = req.body;

  db.prepare(`
    UPDATE exams SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      time_limit = COALESCE(?, time_limit),
      pass_score = COALESCE(?, pass_score),
      max_attempts = COALESCE(?, max_attempts),
      show_answer = COALESCE(?, show_answer),
      is_public = COALESCE(?, is_public),
      is_hidden = COALESCE(?, is_hidden),
      allow_ai_grading = COALESCE(?, allow_ai_grading),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    title !== undefined ? sanitizeText(title).trim() : null,
    description !== undefined ? sanitizeText(description) : null,
    time_limit !== undefined ? time_limit : null,
    pass_score !== undefined ? pass_score : null,
    max_attempts !== undefined ? max_attempts : null,
    show_answer !== undefined ? (show_answer ? 1 : 0) : null,
    is_public !== undefined ? (is_public ? 1 : 0) : null,
    is_hidden !== undefined ? (is_hidden ? 1 : 0) : null,
    allow_ai_grading !== undefined ? (allow_ai_grading ? 1 : 0) : null,
    req.params.id
  );

  // 如果提供了题目，全量替换
  if (Array.isArray(questions)) {
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(req.params.id);

    const stmt = db.prepare(`
      INSERT INTO exam_questions (exam_id, question_type, title, options, correct_answer, score, sort_order, is_subjective, ai_grading_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalScore = 0;
    questions.forEach((q, i) => {
      stmt.run(
        req.params.id,
        q.question_type,
        sanitizeText(q.title),
        JSON.stringify(q.options || []),
        q.correct_answer || '',
        q.score || 0,
        q.sort_order || i,
        q.is_subjective ? 1 : 0,
        q.ai_grading_prompt || ''
      );
      totalScore += q.score || 0;
    });

    db.prepare('UPDATE exams SET total_score = ? WHERE id = ?').run(totalScore, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// 删除试卷
router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  db.prepare('DELETE FROM exam_answers WHERE submission_id IN (SELECT id FROM exam_submissions WHERE exam_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM exam_submissions WHERE exam_id = ?').run(req.params.id);
  db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(req.params.id);
  db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);

  res.json({ message: 'Exam deleted.' });
});

// 提交试卷
router.post('/:id/submit', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Exam not found.' });
  }

  if (!exam.is_public) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Exam is not public.' });
  }

  // 检查尝试次数
  if (exam.max_attempts > 0) {
    const attemptCount = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ? AND user_id = ?').get(exam.id, req.user.id).c;
    if (attemptCount >= exam.max_attempts) {
      return res.status(400).json({ code: 1, reason: 'ERR_MAX_ATTEMPTS', message: '已达到最大尝试次数。' });
    }
  }

  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers is required.' });
  }

  // 获取题目
  const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id = ?').all(exam.id);
  const questionMap = {};
  questions.forEach(q => { questionMap[q.id] = q; });

  // 创建提交记录
  const submissionResult = db.prepare(`
    INSERT INTO exam_submissions (exam_id, user_id, status, max_score)
    VALUES (?, ?, 'submitted', ?)
  `).run(exam.id, req.user.id, exam.total_score);

  const submissionId = submissionResult.lastInsertRowid;

  // 处理每道题的答案
  let totalScore = 0;
  let hasSubjective = false;
  let allObjective = true;

  const answerStmt = db.prepare(`
    INSERT INTO exam_answers (submission_id, question_id, answer, max_score, is_subjective, grading_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  answers.forEach(a => {
    const question = questionMap[a.question_id];
    if (!question) return;

    const isSubjective = question.question_type === 'long_answer' ||
                         (question.question_type === 'fill_blank' && question.is_subjective);

    let score = 0;
    let isCorrect = 0;
    let gradingStatus = 'pending';

    if (!isSubjective) {
      // 客观题自动评分
      allObjective = false;
      const userAnswer = String(a.answer || '').trim().toLowerCase();
      const correctAnswer = String(question.correct_answer || '').trim().toLowerCase();

      if (question.question_type === 'choice' || question.question_type === 'true_false') {
        if (userAnswer === correctAnswer) {
          score = question.score;
          isCorrect = 1;
        }
      } else if (question.question_type === 'fill_blank') {
        // 客观填空题：精确匹配
        if (userAnswer === correctAnswer) {
          score = question.score;
          isCorrect = 1;
        }
      }
      gradingStatus = 'ai_graded';
    } else {
      // 主观题：等待评分
      hasSubjective = true;
      gradingStatus = 'pending';
    }

    totalScore += score;
    answerStmt.run(submissionId, question.id, a.answer || '', question.score, isSubjective ? 1 : 0, gradingStatus);
  });

  // 更新提交状态
  const finalStatus = hasSubjective ? 'grading' : 'graded';
  db.prepare('UPDATE exam_submissions SET total_score = ?, status = ?, ai_graded = ? WHERE id = ?')
    .run(totalScore, finalStatus, !hasSubjective ? 1 : 0, submissionId);

  res.status(201).json({
    submission_id: submissionId,
    status: finalStatus,
    total_score: totalScore,
    max_score: exam.total_score,
    has_subjective: hasSubjective
  });
});

// 获取提交详情
router.get('/:id/submission/:sid', requireAuth, (req, res) => {
  const submission = db.prepare(`
    SELECT es.*, e.title as exam_title, e.show_answer, e.total_score as exam_total_score
    FROM exam_submissions es
    JOIN exams e ON e.id = es.exam_id
    WHERE es.id = ? AND es.user_id = ?
  `).get(req.params.sid, req.user.id);

  if (!submission) {
    // 检查是否是教师+查看他人提交
    if (req.user && ['teacher', 'admin', 'su'].includes(req.user.role)) {
      const sub = db.prepare('SELECT * FROM exam_submissions WHERE id = ?').get(req.params.sid);
      if (!sub) {
        return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
      }
      // 教师可以查看任何提交
      const answers = db.prepare(`
        SELECT ea.*, eq.title as question_title, eq.question_type, eq.options, eq.correct_answer, eq.is_subjective
        FROM exam_answers ea
        JOIN exam_questions eq ON eq.id = ea.question_id
        WHERE ea.submission_id = ?
        ORDER BY eq.sort_order
      `).all(req.params.sid);

      return res.json({ ...sub, answers });
    }
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  const answers = db.prepare(`
    SELECT ea.*, eq.title as question_title, eq.question_type, eq.options, eq.correct_answer, eq.is_subjective
    FROM exam_answers ea
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE ea.submission_id = ?
    ORDER BY eq.sort_order
  `).all(req.params.sid);

  // 如果不显示答案，隐藏正确答案
  if (!submission.show_answer) {
    answers.forEach(a => {
      delete a.correct_answer;
    });
  }

  res.json({ ...submission, answers });
});

// 获取某试卷的所有提交（教师用）
router.get('/:id/submissions', requireAuth, requireRole('teacher'), (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);

  const total = db.prepare('SELECT COUNT(*) as c FROM exam_submissions WHERE exam_id = ?').get(req.params.id).c;

  const submissions = db.prepare(`
    SELECT es.*, u.username, u.nickname
    FROM exam_submissions es
    JOIN users u ON u.id = es.user_id
    WHERE es.exam_id = ?
    ORDER BY es.submitted_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limitNum, offset);

  res.json({ total, page: pageNum, limit: limitNum, submissions });
});

// 批改试卷（教师或 AI）
router.post('/:id/grade/:sid', requireAuth, requireRole('teacher'), (req, res) => {
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE id = ? AND exam_id = ?').get(req.params.sid, req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'answers array is required.' });
  }

  let totalScore = 0;
  const updateStmt = db.prepare(`
    UPDATE exam_answers SET score = ?, human_comment = ?, grading_status = 'human_graded', graded_at = datetime('now')
    WHERE id = ?
  `);

  // 获取当前所有答案（包含客观题得分）
  const allAnswers = db.prepare('SELECT * FROM exam_answers WHERE submission_id = ?').all(req.params.sid);
  const answerMap = {};
  allAnswers.forEach(a => { answerMap[a.id] = a; });

  // 先计算客观题得分
  allAnswers.forEach(a => {
    if (!a.is_subjective) {
      totalScore += a.score;
    }
  });

  // 更新主观题得分
  answers.forEach(a => {
    const answer = answerMap[a.answer_id];
    if (!answer || !answer.is_subjective) return;

    updateStmt.run(a.score || 0, a.comment || '', a.answer_id);
    totalScore += a.score || 0;
  });

  // 更新提交记录
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = 'graded', human_graded = 1, graded_at = datetime('now'), graded_by = ?
    WHERE id = ?
  `).run(totalScore, req.user.id, req.params.sid);

  res.json({ total_score: totalScore, status: 'graded' });
});

// AI 批改试卷
router.post('/:id/ai-grade/:sid', requireAuth, requireRole('teacher'), async (req, res) => {
  const submission = db.prepare('SELECT * FROM exam_submissions WHERE id = ? AND exam_id = ?').get(req.params.sid, req.params.id);
  if (!submission) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Submission not found.' });
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam.allow_ai_grading) {
    return res.status(400).json({ code: 1, reason: 'ERR_AI_GRADING_DISABLED', message: '此试卷未启用 AI 评分。' });
  }

  // 检查 AI 是否启用
  const config = require('../config/config');
  if (!config.ai || !config.ai.enabled) {
    return res.status(503).json({ code: 5, reason: 'ERR_AI_UNAVAILABLE', message: 'AI 服务未启用。' });
  }

  // 获取待评分的主观题答案
  const pendingAnswers = db.prepare(`
    SELECT ea.*, eq.title as question_title, eq.question_type, eq.correct_answer, eq.ai_grading_prompt
    FROM exam_answers ea
    JOIN exam_questions eq ON eq.id = ea.question_id
    WHERE ea.submission_id = ? AND ea.is_subjective = 1 AND ea.grading_status = 'pending'
  `).all(req.params.sid);

  if (pendingAnswers.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_NO_PENDING', message: '没有待评分的主观题。' });
  }

  // 调用 AI 评分
  const { callAI } = require('../services/ai');

  for (const answer of pendingAnswers) {
    try {
      const prompt = answer.ai_grading_prompt ||
        `你是一位严格的老师。请根据参考答案评判学生的回答。

题目：${answer.question_title}
参考答案：${answer.correct_answer || '无'}
学生回答：${answer.answer}
满分：${answer.max_score}分

请给出评分（0-${answer.max_score}）和简短评语。
格式：{"score": 分数, "comment": "评语"}`;

      const aiResult = await callAI(prompt);
      let score = 0;
      let comment = '';

      try {
        // 尝试解析 JSON
        const parsed = JSON.parse(aiResult);
        score = Math.min(Math.max(0, parsed.score || 0), answer.max_score);
        comment = parsed.comment || '';
      } catch {
        // 如果解析失败，尝试从文本中提取分数
        const scoreMatch = aiResult.match(/(\d+)/);
        score = scoreMatch ? Math.min(parseInt(scoreMatch[1]), answer.max_score) : 0;
        comment = aiResult;
      }

      db.prepare(`
        UPDATE exam_answers SET score = ?, ai_comment = ?, grading_status = 'ai_graded', graded_at = datetime('now')
        WHERE id = ?
      `).run(score, comment, answer.id);
    } catch (err) {
      console.error('[AI Grading] Error:', err.message);
    }
  }

  // 更新提交状态
  const totalScore = db.prepare('SELECT SUM(score) as total FROM exam_answers WHERE submission_id = ?').get(req.params.sid).total || 0;
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = 'graded', ai_graded = 1, graded_at = datetime('now'), graded_by = ?
    WHERE id = ?
  `).run(totalScore, req.user.id, req.params.sid);

  res.json({ total_score: totalScore, status: 'graded' });
});

module.exports = router;