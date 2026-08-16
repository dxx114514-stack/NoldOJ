const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { sanitizeLog } = require('../utils/securityHelpers');

const router = express.Router();

// 冷却：内存 Map，user_id|problem_id -> 最近请求时间戳
const cooldown = new Map();
const COOLDOWN_MS = 60 * 1000; // 每分钟最多请求一次
// R9-8: 惰性 TTL——Map 无界增长是内存泄漏，达到阈值时清理所有已过期条目
const COOLDOWN_MAX = 10000;
function pruneCooldown() {
  if (cooldown.size < COOLDOWN_MAX) return;
  const now = Date.now();
  for (const [k, ts] of cooldown) {
    if (now - ts > COOLDOWN_MS) cooldown.delete(k);
  }
}

// 计算用户对该题已提交但未 AC 的次数（用于门槛）
function failedAttempts(userId, problemId) {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM submissions
    WHERE user_id = ? AND problem_id = ?
      AND status IN ('wrong_answer','time_limit_exceeded','memory_limit_exceeded','runtime_error','compile_error')
  `).get(userId, problemId);
  return row?.c || 0;
}

// 取用户最近一次提交（供 AI 参考）
function lastSubmission(userId, problemId) {
  return db.prepare(`
    SELECT source_code, language FROM submissions
    WHERE user_id = ? AND problem_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(userId, problemId);
}

const HINT_PROMPT = `你是一位温和的算法教练。请根据题目和用户代码，给出下一步的思路提示。

=== 重要规则 ===
1. 只给思路与方向，绝不直接给出可提交的完整题解代码。
2. 提示要具体：指出代码中可能导致 WA/TLE 的部分、更优的算法方向、需要检查的边界条件。
3. 若用户代码接近正确，只提示最关键的一处问题；若代码方向错误，则提示更合适的算法思路。
4. 语气鼓励，简洁，中文输出，300 字以内。`;

// 功能13：AI 代码思路提示（user+，需先失败多次）
// POST /api/v1/problems/:id/hint   body: {}
router.post('/:id/hint', requireAuth, async (req, res) => {
  const problemId = parseInt(req.params.id);
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(problemId);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }

  // 门槛：至少 2 次未 AC 的提交才能要提示
  const fails = failedAttempts(req.user.id, problemId);
  if (fails < 2) {
    return res.status(403).json({
      code: 6, reason: 'ERR_FORBIDDEN',
      message: `需要先尝试失败至少 2 次（当前 ${fails} 次）才能获取思路提示。`
    });
  }

  // 冷却
  const key = `${req.user.id}|${problemId}`;
  const now = Date.now();
  const last = cooldown.get(key) || 0;
  const waitSec = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
  if (waitSec > 0) {
    return res.status(429).json({ code: 4, reason: 'ERR_RATE_LIMITED', message: `提示获取太频繁，请 ${waitSec} 秒后再试。` });
  }
  pruneCooldown(); // R9-8: 保持有界

  const { aiEnabled, aiChat } = require('../services/aiClient');
  if (!aiEnabled()) {
    return res.status(503).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 服务未启用，请先在 config/ai.txt 中启用。' });
  }

  const sub = lastSubmission(req.user.id, problemId);
  const userMsg = `题目标题: ${problem.title}
题目描述:
${problem.description}

输入格式:
${problem.input_desc}

输出格式:
${problem.output_desc}

数据范围/提示:
${problem.hint}

我的代码 (${sub?.language || 'unknown'}):
${(sub?.source_code || '').slice(0, 6000)}

请给出下一步思路提示。`;

  try {
    cooldown.set(key, now);
    const hint = await aiChat(HINT_PROMPT, userMsg, { numPredict: 1500, timeoutMs: 90000 });
    res.json({ hint: hint.trim() });
  } catch (err) {
    console.error(`AI hint error for problem ${problemId}:`, sanitizeLog(String(err.message || err)));
    res.status(502).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 提示生成失败，请检查 AI 服务是否可用。' });
  }
});

module.exports = router;