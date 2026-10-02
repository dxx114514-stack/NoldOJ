// 试卷编程题共用模块：判题原生分 ↔ 试卷题分的折算，以及判题完成后的回填。
// 被 exams.js（提交试卷计分）与 judge.js（判题后回写）共同引用。
const db = require('../database/db');

// 终态判定：这些状态表示评测已结束（system_error 视为终态 0 分，可由教师重测）
const NON_TERMINAL = new Set(['pending', 'pending_review', 'running', 'compiling', 'judging', 'pending_rejudge']);

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

// 某题判题原生满分：无 scoring_script 时判题端最多产出 SUM(test_cases.score)
// （简单模式 = 全过总分；分组模式 = 各组全过时组内测试点分之和，理论上限相同）。
function problemMaxScore(problemId) {
  const row = db.prepare('SELECT COALESCE(SUM(score), 0) as m FROM test_cases WHERE problem_id = ?').get(problemId);
  return Number(row?.m) || 0;
}

// 满分为 0 时的兜底：按 AC 测试点数量比例折算
function acceptedRatio(submissionId) {
  const row = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as ok
    FROM submission_details WHERE submission_id = ?
  `).get(submissionId);
  const total = row?.total || 0;
  if (total <= 0) return 0;
  return (Number(row?.ok) || 0) / total;
}

// 将一次代码提交折算为试卷题得分。
// 返回 { pending: true } 表示判题未结束；否则返回 { score, graded: true, correct }。
function scoreFromSubmission(question, submission) {
  if (!submission) {
    // 未提交代码：终态 0 分（不阻塞试卷出分）
    return { score: 0, graded: true, correct: false };
  }
  if (NON_TERMINAL.has(submission.status)) {
    return { pending: true };
  }
  const max = problemMaxScore(submission.problem_id);
  let ratio;
  if (max > 0) {
    ratio = (Number(submission.score) || 0) / max;
  } else {
    ratio = acceptedRatio(submission.id);
  }
  const qMax = Number(question.score) || 0;
  const score = Math.max(0, Math.min(qMax, round2(qMax * ratio)));
  return { score, graded: true, correct: qMax > 0 && score >= qMax };
}

// 按当前 exam_answers 汇总重算 exam_submissions 的总分与状态
function recomputeExamSubmission(examSubmissionId) {
  const rows = db.prepare('SELECT score, grading_status FROM exam_answers WHERE submission_id = ?').all(examSubmissionId);
  let total = 0;
  let pending = false;
  for (const r of rows) {
    total += Number(r.score) || 0;
    if (r.grading_status === 'pending') pending = true;
  }
  const status = pending ? 'grading' : 'graded';
  db.prepare(`
    UPDATE exam_submissions SET total_score = ?, status = ?, ai_graded = ?, graded_at = CASE WHEN ? = 'graded' THEN datetime('now') ELSE graded_at END
    WHERE id = ?
  `).run(round2(total), status, pending ? 0 : 1, status, examSubmissionId);
  return { total_score: round2(total), status };
}

// 判题结束（终态）后回填：exam_answers.score ← 折算分，并重算试卷提交汇总。
// 通过 exam_answers.code_submission_id 定位；试卷/答题记录已被删除时静默返回 false。
function writeBackAfterJudge(codeSubmissionId) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(codeSubmissionId);
  if (!sub || !sub.exam_id) return false;
  if (NON_TERMINAL.has(sub.status)) return false;

  const ans = db.prepare('SELECT * FROM exam_answers WHERE code_submission_id = ?').get(codeSubmissionId);
  if (!ans) return false;
  const question = db.prepare('SELECT * FROM exam_questions WHERE id = ?').get(ans.question_id);
  if (!question) return false;

  const result = scoreFromSubmission(question, sub);
  if (result.pending) return false;

  db.prepare(`
    UPDATE exam_answers SET score = ?, is_correct = ?, grading_status = 'ai_graded', graded_at = datetime('now')
    WHERE id = ?
  `).run(result.score, result.correct ? 1 : 0, ans.id);

  recomputeExamSubmission(ans.submission_id);
  return true;
}

module.exports = {
  NON_TERMINAL,
  problemMaxScore,
  scoreFromSubmission,
  recomputeExamSubmission,
  writeBackAfterJudge
};
