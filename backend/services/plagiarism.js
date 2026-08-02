// 功能10：代码查重服务
// 简单版算法：token 序列 + Jaccard 相似度（不做 AST）
//
// 算法要点（按需求）：
// 1. 提取代码 token 序列（去注释、去空白，变量名保留）
// 2. Jaccard 相似度：|A∩B| / |A∪B|
// 3. 阈值：≥0.85 "高度相似"（high），≥0.7 "疑似相似"（medium）
// 4. 只比较同一题、不同用户的提交
// 5. 同一用户多次提交不比较（取最新一次）
// 6. 短代码（<50 token）跳过
// 7. 不要搞 AST，token + Jaccard 够用

const db = require('../database/db');

// 阈值常量
const HIGH_THRESHOLD = 0.85;
const MEDIUM_THRESHOLD = 0.7;
// 短代码阈值（少于该数量 token 直接跳过）
const MIN_TOKEN_COUNT = 50;

// 语言 → 注释风格映射
function stripComments(code, language) {
  let s = String(code || '');
  if (language === 'python3' || language === 'python') {
    // Python：去除三引号字符串（粗略当作字符串/文档注释）与 # 行注释
    s = s.replace(/"""[\s\S]*?"""/g, ' ');
    s = s.replace(/'''[\s\S]*?'''/g, ' ');
    s = s.replace(/#[^\n]*/g, ' ');
    return s;
  }
  // C / C++ / Java / JavaScript：去除块注释和行注释
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/\/\/[^\n]*/g, ' ');
  return s;
}

// 提取 token 序列：标识符 / 数字 / 单字符运算符
// 变量名保留（不归一化），符合需求"变量名保留"
function tokenize(code, language) {
  const cleaned = stripComments(code, language);
  // 匹配：标识符（含下划线）、数字（含小数）、单个非空白非字母数字字符
  const matches = cleaned.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g);
  return matches || [];
}

// Jaccard 相似度：|A∩B| / |A∪B|（基于 token 集合）
function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA || !tokensB || tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersect = 0;
  // 取较小集合遍历，效率更高
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const t of smaller) if (larger.has(t)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// 等级判定
function levelOf(similarity) {
  if (similarity >= HIGH_THRESHOLD) return 'high';
  if (similarity >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

// 获取某题目所有参与查重的提交（每个用户取最新一次有效提交）
// 跳过：未评测完成、空代码、虚拟比赛提交
function getLatestSubmissionsPerUser(problemId) {
  const rows = db.prepare(`
    SELECT s.id, s.user_id, s.language, s.source_code, s.created_at, u.username, u.nickname
    FROM submissions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.problem_id = ?
      AND s.virtual_contest_id IS NULL
      AND s.status IN ('accepted','wrong_answer','time_limit_exceeded','memory_limit_exceeded','runtime_error')
      AND s.source_code IS NOT NULL
      AND length(s.source_code) > 0
    ORDER BY s.user_id ASC, s.id DESC
  `).all(problemId);
  // 每个用户只保留最新一次（按 id DESC 已排序，去重取首条）
  const seen = new Set();
  const result = [];
  for (const r of rows) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    result.push(r);
  }
  return result;
}

// 异步执行一次查重任务（不阻塞响应）
function runTask(taskId, problemId) {
  // 标记为运行中
  db.prepare("UPDATE plagiarism_tasks SET status = 'running' WHERE id = ?").run(taskId);

  try {
    const subs = getLatestSubmissionsPerUser(problemId);
    // 预处理：tokenize 并跳过短代码
    const valid = [];
    for (const s of subs) {
      const tokens = tokenize(s.source_code, s.language);
      if (tokens.length < MIN_TOKEN_COUNT) continue;
      valid.push({ ...s, tokens });
    }

    const totalPairs = valid.length < 2 ? 0 : (valid.length * (valid.length - 1)) / 2;
    db.prepare('UPDATE plagiarism_tasks SET total_pairs = ?, checked_pairs = 0 WHERE id = ?')
      .run(totalPairs, taskId);

    // 删除该题目旧的 pairs（仅保留本次结果，避免堆积）
    // 注意：plagiarism_pairs 通过 task_id 关联，旧 task 的 pairs 仍保留作历史
    const insPair = db.prepare(`
      INSERT INTO plagiarism_pairs (task_id, user_a, user_b, sub_a_id, sub_b_id, similarity, level)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let checked = 0;
    let found = 0;
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = valid[i], b = valid[j];
        // 同一用户多次提交不比较（已按 user 去重，此处再次保险）
        if (a.user_id === b.user_id) { checked++; continue; }
        const sim = jaccardSimilarity(a.tokens, b.tokens);
        if (sim >= MEDIUM_THRESHOLD) {
          insPair.run(taskId, a.user_id, b.user_id, a.id, b.id, Number(sim.toFixed(4)), levelOf(sim));
          found++;
        }
        checked++;
        // 每 50 对刷新一次进度
        if (checked % 50 === 0) {
          db.prepare('UPDATE plagiarism_tasks SET checked_pairs = ? WHERE id = ?').run(checked, taskId);
        }
      }
    }
    db.prepare("UPDATE plagiarism_tasks SET status = 'done', checked_pairs = ?, finished_at = datetime('now') WHERE id = ?")
      .run(checked, taskId);
    console.log(`[Plagiarism] Task #${taskId} done. submissions=${valid.length}, pairs_checked=${checked}, found=${found}`);
  } catch (err) {
    console.error(`[Plagiarism] Task #${taskId} failed:`, err.message);
    db.prepare("UPDATE plagiarism_tasks SET status = 'failed', finished_at = datetime('now') WHERE id = ?").run(taskId);
  }
}

// 创建并异步启动查重任务
function createTask(problemId, createdByUserId) {
  const result = db.prepare(`
    INSERT INTO plagiarism_tasks (problem_id, status, total_pairs, checked_pairs, created_by)
    VALUES (?, 'pending', 0, 0, ?)
  `).run(problemId, createdByUserId);
  const taskId = result.lastInsertRowid;
  // 异步触发（不阻塞请求响应）
  setImmediate(() => runTask(Number(taskId), problemId));
  return Number(taskId);
}

// 获取任务进度与结果
function getTask(taskId) {
  const task = db.prepare('SELECT * FROM plagiarism_tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const pairs = db.prepare(`
    SELECT pp.*, ua.username as user_a_name, ua.nickname as user_a_nick,
           ub.username as user_b_name, ub.nickname as user_b_nick
    FROM plagiarism_pairs pp
    LEFT JOIN users ua ON pp.user_a = ua.id
    LEFT JOIN users ub ON pp.user_b = ub.id
    WHERE pp.task_id = ?
    ORDER BY pp.similarity DESC, pp.id ASC
  `).all(taskId);
  return { ...task, pairs };
}

// 获取题目最近一次任务
function getLatestTaskForProblem(problemId) {
  const task = db.prepare(`
    SELECT * FROM plagiarism_tasks WHERE problem_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(problemId);
  if (!task) return null;
  return getTask(task.id);
}

// 获取单个 pair 详情（含两份代码与高亮 token 集合）
function getPairDetail(pairId) {
  const pair = db.prepare(`
    SELECT pp.*, ua.username as user_a_name, ua.nickname as user_a_nick,
           ub.username as user_b_name, ub.nickname as user_b_nick,
           sa.source_code as code_a, sa.language as lang_a, sa.problem_id,
           sb.source_code as code_b, sb.language as lang_b
    FROM plagiarism_pairs pp
    LEFT JOIN users ua ON pp.user_a = ua.id
    LEFT JOIN users ub ON pp.user_b = ub.id
    LEFT JOIN submissions sa ON pp.sub_a_id = sa.id
    LEFT JOIN submissions sb ON pp.sub_b_id = sb.id
    WHERE pp.id = ?
  `).get(pairId);
  if (!pair) return null;
  // 计算两个提交的 token 并求交集，用于前端高亮显示
  const tokensA = tokenize(pair.code_a || '', pair.lang_a);
  const tokensB = tokenize(pair.code_b || '', pair.lang_b);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const shared = new Set();
  for (const t of setA) if (setB.has(t)) shared.add(t);
  return { ...pair, tokens_a: tokensA, tokens_b: tokensB, shared_tokens: Array.from(shared) };
}

module.exports = {
  tokenize,
  jaccardSimilarity,
  levelOf,
  createTask,
  getTask,
  getLatestTaskForProblem,
  getPairDetail,
  getLatestSubmissionsPerUser,
  HIGH_THRESHOLD,
  MEDIUM_THRESHOLD,
  MIN_TOKEN_COUNT
};
