const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { isStaff } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');
const { sanitizeLog } = require('../utils/securityHelpers');
const { createRateLimit } = require('../middleware/ratelimit');

// R9-3: 查重任务创建限流（每分钟最多 10 次），防并发堆积耗尽 CPU
const plagiarismRateLimit = createRateLimit({ windowMs: 60000, max: 10 });
// 10.3: AI 测试点生成是昂贵操作（8192 tokens / 90s），限流防资源耗尽
const aiTestdataRateLimit = createRateLimit({ windowMs: 60000, max: 5 });

const router = express.Router();
// R9-5: testdata 的 multer 临时文件不能落到公开匿名可读的 /uploads 目录
// （崩溃残留会匿名泄露测试数据/源码 ZIP），改用独立非公开临时目录，
// 由 server.js 启动时统一清理。
const tmpUploadDir = path.join(__dirname, '../../data/tmp-uploads');
fs.mkdirSync(tmpUploadDir, { recursive: true });
const upload = multer({ dest: tmpUploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

// 纵深防御: 断言文件路径必须位于 baseDir 之内（ZIP 导入写入前调用）
function assertInsideProblemDir(baseDir, filePath) {
  const base = path.resolve(baseDir) + path.sep;
  if (!path.resolve(filePath).startsWith(base)) {
    throw new Error(`ZIP entry escapes problem directory: ${filePath}`);
  }
}

// R12-1: 多样例读写 helpers ─────────────────────────────
// 规范化客户端传入的 samples 数组; 非法结构返回 null(调用方决定报错/忽略)
function normalizeSamples(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const input = typeof s.input === 'string' ? s.input : '';
    const output = typeof s.output === 'string' ? s.output : '';
    const note = typeof s.note === 'string' ? s.note.slice(0, 500) : '';
    if (input.length > 65536 || output.length > 65536) return null;
    out.push({ input, output, note });
  }
  return out;
}
function getSamples(problemId) {
  return db.prepare('SELECT input, output, note FROM problem_samples WHERE problem_id = ? ORDER BY sort_order, id').all(problemId);
}
// 全量替换某题样例; 并双写首条到旧 sample_input/sample_output 字段(兼容旧客户端/搜索)
function replaceSamples(problemId, samples) {
  db.prepare('DELETE FROM problem_samples WHERE problem_id = ?').run(problemId);
  const ins = db.prepare('INSERT INTO problem_samples (problem_id, input, output, note, sort_order) VALUES (?, ?, ?, ?, ?)');
  samples.forEach((s, i) => ins.run(problemId, s.input, s.output, s.note, i + 1));
  const first = samples[0] || { input: '', output: '' };
  db.prepare('UPDATE problems SET sample_input = ?, sample_output = ? WHERE id = ?').run(first.input, first.output, problemId);
}

// 公开脱敏视图: 移除 SPJ 脚本与评分脚本，防止泄露判题逻辑
function sanitizeProblem(p) {
  if (!p) return null;
  const result = { ...p };
  delete result.spj_code;
  delete result.scoring_script;
  return result;
}

// 题目可见性校验（隐藏题 / 非公开题），返回错误响应对象或 null
function problemVisibilityError(problem, req) {
  const isManager = !!(req.user && isStaff(req.user.role));
  if (problem.is_hidden && !isManager) {
    return { code: 6, reason: 'ERR_FORBIDDEN', message: 'Problem is not public.' };
  }
  if (!problem.is_public) {
    if (isManager || (req.user && req.user.id === problem.created_by)) return null;
    const contests = db.prepare(`
      SELECT c.id, c.start_time, c.end_time FROM contest_problems cp
      JOIN contests c ON c.id = cp.contest_id
      WHERE cp.problem_id = ?
    `).all(problem.id);
    const now = Date.now();
    const running = contests.some(c => {
      const s = new Date(c.start_time).getTime();
      const e = new Date(c.end_time).getTime();
      return !isNaN(s) && !isNaN(e) && s <= now && now <= e;
    });
    const participant = running && req.user ? db.prepare(`
      SELECT 1 FROM contest_participants WHERE contest_id IN (
        SELECT cp2.contest_id FROM contest_problems cp2 WHERE cp2.problem_id = ?
      ) AND user_id = ?
    `).get(problem.id, req.user.id) : null;
    if (!running || !req.user || !participant) {
      return { code: 6, reason: 'ERR_FORBIDDEN', message: 'Problem is not public.' };
    }
  }
  return null;
}

// 作者/管理视图: 保留 spj_code 与 scoring_script，用于题目编辑回显
// （fullProblem 恒等包装已移除，直接返回数据库对象）

router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 50, search = '', tag = '', tags = '', category = '', difficulty = '', sort = '', order = 'desc' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 50, 100);
  let where = 'WHERE p.is_public = 1';
  const params = [];
  // 隐藏题目仅对 teacher/admin/su 可见；管理角色可加 include_hidden=1 在列表中查看
  const isManager = !!(req.user && isStaff(req.user.role));
  if (!isManager) {
    where += ' AND p.is_hidden = 0';
  }

  if (search) {
    const fuzzy = '%' + search.replace(/\s+/g, '') + '%';
    where += ` AND (REPLACE(p.title, ' ', '') LIKE ? OR REPLACE(p.description, ' ', '') LIKE ? OR REPLACE(IFNULL(p.provider, ''), ' ', '') LIKE ?)`;
    params.push(fuzzy, fuzzy, fuzzy);
  }

  // 兼容单标签 tag 与多标签 tags（逗号分隔，OR 逻辑）
  const tagList = [];
  if (tag) tagList.push(tag);
  if (tags) tagList.push(...tags.split(',').map(s => s.trim()).filter(Boolean));
  if (tagList.length > 0) {
    const placeholders = tagList.map(() => '?').join(',');
    where += ` AND p.id IN (SELECT pt.problem_id FROM problem_tags pt JOIN tags t ON pt.tag_id = t.id WHERE t.name IN (${placeholders}))`;
    params.push(...tagList);
  }

  if (category) {
    where += ' AND p.id IN (SELECT pc.problem_id FROM problem_categories pc JOIN categories c ON pc.category_id = c.id WHERE c.name = ?)';
    params.push(category);
  }

  if (difficulty !== '' && difficulty !== null && difficulty !== undefined) {
    const d = parseInt(difficulty);
    if (!isNaN(d) && d >= 0 && d <= 5) {
      where += ' AND p.difficulty = ?';
      params.push(d);
    }
  }

  // 排序：默认按 id 升序；支持 created_at / accept_rate / submissions
  const ord = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let orderClause = 'ORDER BY p.id ASC';
  if (sort === 'created_at') {
    orderClause = `ORDER BY p.created_at ${ord}, p.id ${ord}`;
  } else if (sort === 'submissions') {
    orderClause = `ORDER BY sub_count ${ord}, p.id ${ord}`;
  } else if (sort === 'accept_rate') {
    orderClause = `ORDER BY ac_rate ${ord}, p.id ${ord}`;
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM problems p ${where}`).get(...params).c;
  const problems = db.prepare(`
    SELECT p.id, p.title, p.problem_type, p.time_limit, p.memory_limit, p.is_public, p.is_hidden, p.difficulty, p.created_at,
      COALESCE(agg.sub_count, 0) as sub_count,
      COALESCE(agg.ac_count, 0) as ac_count,
      CASE WHEN COALESCE(agg.sub_count, 0) > 0
        THEN COALESCE(agg.ac_count, 0) * 1.0 / agg.sub_count
        ELSE 0 END as ac_rate
    FROM problems p
    LEFT JOIN (
      SELECT problem_id,
        COUNT(*) as sub_count,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as ac_count
      FROM submissions
      GROUP BY problem_id
    ) agg ON agg.problem_id = p.id
    ${where} ${orderClause} LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);

  if (problems.length > 0) {
    const ids = problems.map(p => p.id);
    const qmarks = ids.map(() => '?').join(',');
    // 一次批量取标签
    const tagRows = db.prepare(`
      SELECT pt.problem_id, t.id, t.name, t.color FROM tags t
      JOIN problem_tags pt ON t.id = pt.tag_id
      WHERE pt.problem_id IN (${qmarks})
    `).all(...ids);
    const tagsByProblem = new Map();
    for (const r of tagRows) {
      const list = tagsByProblem.get(r.problem_id) || [];
      list.push({ id: r.id, name: r.name, color: r.color });
      tagsByProblem.set(r.problem_id, list);
    }
    // 一次批量取分类
    const catRows = db.prepare(`
      SELECT pc.problem_id, c.id, c.name, c.description FROM categories c
      JOIN problem_categories pc ON c.id = pc.category_id
      WHERE pc.problem_id IN (${qmarks})
    `).all(...ids);
    const catsByProblem = new Map();
    for (const r of catRows) {
      const list = catsByProblem.get(r.problem_id) || [];
      list.push({ id: r.id, name: r.name, description: r.description });
      catsByProblem.set(r.problem_id, list);
    }
    for (const problem of problems) {
      const ac = problem.ac_count || 0;
      const sub = problem.sub_count || 0;
      problem.accept_rate = sub > 0 ? Math.round((ac / sub) * 1000) / 10 : 0;
      problem.tags = tagsByProblem.get(problem.id) || [];
      problem.categories = catsByProblem.get(problem.id) || [];
    }
  }

  res.json({ total, page: pageNum, limit: limitNum, problems });
});

router.get('/:id', optionalAuth, (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const isManager = !!(req.user && isStaff(req.user.role));
  // R9-2/R10-2: 隐藏题/非公开题可见性统一校验
  const verr = problemVisibilityError(problem, req);
  if (verr) {
    return res.status(403).json(verr);
  }
  // 管理角色或创建者返回完整视图（含 spj_code/scoring_script），其余走公开脱敏视图
  const isOwner = !!(req.user && req.user.id === problem.created_by);
  const result = (isManager || isOwner) ? problem : sanitizeProblem(problem);
  // D-I2: 测试点数量仅对管理角色/作者可见，不对普通用户暴露
  if (isManager || isOwner) {
    result.test_cases_count = db.prepare('SELECT COUNT(*) as c FROM test_cases WHERE problem_id = ?').get(problem.id).c;
  }
  const cats = db.prepare(`
    SELECT c.id, c.name, c.description FROM categories c
    JOIN problem_categories pc ON c.id = pc.category_id
    WHERE pc.problem_id = ?
  `).all(problem.id);
  result.categories = cats;
  const tags = db.prepare(`
    SELECT t.id, t.name, t.color FROM tags t
    JOIN problem_tags pt ON t.id = pt.tag_id
    WHERE pt.problem_id = ?
  `).all(problem.id);
  result.tags = tags;
  // R12-1: 多样例。新表为准; 兼容旧数据(表空但旧字段非空)构造单元素数组
  let samples = getSamples(problem.id);
  if (samples.length === 0 && ((problem.sample_input || '') !== '' || (problem.sample_output || '') !== '')) {
    samples = [{ input: problem.sample_input || '', output: problem.sample_output || '', note: '' }];
  }
  result.samples = samples;
  res.json(result);
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, sample_input, sample_output, subtask_mode, difficulty, is_hidden } = req.body;
  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  // D-M11: 拒绝超范围资源限制配置（与判题端硬上限一致）
  if (time_limit !== undefined && time_limit !== null && (!Number.isInteger(Number(time_limit)) || Number(time_limit) < 1 || Number(time_limit) > 10000)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'time_limit 必须在 1~10000 ms 之间。' });
  }
  if (memory_limit !== undefined && memory_limit !== null && (!Number.isInteger(Number(memory_limit)) || Number(memory_limit) < 1 || Number(memory_limit) > 1048576)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'memory_limit 必须在 1~1048576 KB 之间。' });
  }
  const newId = db.findNextId('problems');
  // R12-1: samples 数组存在时以首条双写旧字段, 全量入新表
  let samples = normalizeSamples(req.body.samples);
  if (samples === null && req.body.samples !== undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'samples 必须为 [{input,output,note}] 数组。' });
  }
  const first = samples && samples[0] ? samples[0] : null;
  db.prepare(`INSERT INTO problems (id, title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, created_by, sample_input, sample_output, subtask_mode, difficulty, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId,
    title,
    description || '',
    input_desc || '',
    output_desc || '',
    hint || '',
    time_limit || 1000,
    memory_limit || 256,
    problem_type || 'traditional',
    compare_mode || 'text_strict',
    JSON.stringify(real_number_tolerance || { absolute: 0.001, relative: 0.001 }),
    spj_code || '',
    JSON.stringify(allowed_languages || []),
    is_public !== undefined ? (is_public ? 1 : 0) : 1,
    provider || '',
    req.user.id,
    first ? first.input : (sample_input || ''),
    first ? first.output : (sample_output || ''),
    subtask_mode || 'simple',
    difficulty !== undefined ? parseInt(difficulty) || 0 : 0,
    is_hidden !== undefined ? (is_hidden ? 1 : 0) : 0
  );
  if (samples && samples.length > 0) replaceSamples(newId, samples);
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(newId);
  res.status(201).json(problem);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const inContest = db.prepare('SELECT id FROM contest_problems WHERE problem_id = ?').get(problem.id);
  if (inContest) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot edit a problem that is part of a contest.' });
  }

  const fields = ['title', 'description', 'input_desc', 'output_desc', 'hint', 'time_limit', 'memory_limit', 'problem_type', 'compare_mode', 'real_number_tolerance', 'spj_code', 'allowed_languages', 'is_public', 'provider', 'sample_input', 'sample_output', 'subtask_mode', 'difficulty', 'is_hidden'];
  // 防御纵深：列名仅允许合法标识符，杜绝任何注入 SQL SET 子句的可能
  for (const field of fields) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `Invalid field: ${field}` });
    }
  }
  // D-M11: 更新时同样拒绝超范围资源限制
  const bodyTl = req.body.time_limit;
  const bodyMl = req.body.memory_limit;
  if (bodyTl !== undefined && bodyTl !== null && (!Number.isInteger(Number(bodyTl)) || Number(bodyTl) < 1 || Number(bodyTl) > 10000)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'time_limit 必须在 1~10000 ms 之间。' });
  }
  if (bodyMl !== undefined && bodyMl !== null && (!Number.isInteger(Number(bodyMl)) || Number(bodyMl) < 1 || Number(bodyMl) > 1048576)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'memory_limit 必须在 1~1048576 KB 之间。' });
  }
  const transformValue = (field, value) => {
    if (field === 'real_number_tolerance' || field === 'allowed_languages') return JSON.stringify(value);
    if (field === 'is_public' || field === 'is_hidden') return value ? 1 : 0;
    if (field === 'difficulty') return parseInt(value) || 0;
    return value;
  };
  const u = buildUpdates(fields.map(f => ({ key: f, value: req.body[f], transform: v => transformValue(f, v) })), { touchUpdatedAt: true });
  if (u.count === 0 && req.body.samples === undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  if (u.count > 0) {
    db.prepare(`UPDATE problems SET ${u.clause} WHERE id = ?`).run(...u.values, problem.id);
  }
  // R12-1: samples 数组存在即全量替换(含空数组=清空样例); 否则旧字段变化时同步回新表首条
  let samples = normalizeSamples(req.body.samples);
  if (samples === null && req.body.samples !== undefined) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'samples 必须为 [{input,output,note}] 数组。' });
  }
  if (samples !== null) {
    replaceSamples(problem.id, samples);
    // 同步旧字段到返回视图
    const first = samples[0] || { input: '', output: '' };
    db.prepare('UPDATE problems SET sample_input = ?, sample_output = ?, updated_at = datetime(\'now\') WHERE id = ?').run(first.input, first.output, problem.id);
  } else if (req.body.sample_input !== undefined || req.body.sample_output !== undefined) {
    const cur = db.prepare('SELECT sample_input, sample_output FROM problems WHERE id = ?').get(problem.id);
    replaceSamples(problem.id, [{ input: cur.sample_input || '', output: cur.sample_output || '', note: '' }]);
  }

  const updated = db.prepare('SELECT * FROM problems WHERE id = ?').get(problem.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const inContest = db.prepare('SELECT id FROM contest_problems WHERE problem_id = ?').get(problem.id);
  if (inContest) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Cannot delete a problem that is part of a contest.' });
  }
  db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(problem.id);
  db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(problem.id);
  db.prepare('DELETE FROM problem_samples WHERE problem_id = ?').run(problem.id);
  db.prepare('DELETE FROM problems WHERE id = ?').run(problem.id);
  // R11-?: 同步清理磁盘 testdata 目录，避免删题后残留孤儿目录
  const problemDir = path.join(config.problemsDir, String(problem.id));
  try {
    if (fs.existsSync(problemDir)) fs.rmSync(problemDir, { recursive: true, force: true });
  } catch (e) {
    console.error(`Failed to remove problem testdata dir for ${problem.id}:`, sanitizeLog(String(e.message || e)));
  }
  res.json({ message: 'Problem deleted.' });
});

// 题目重编号（admin/su）：将题目 id 改到指定的空位置。
// 需要同步所有引用 problem_id 的表 + 磁盘 testdata 目录，全在事务内完成。
// 使用 defer_foreign_keys 将外键校验推迟到 COMMIT（SQLite 3.23+，node:sqlite 自带新版）。
router.put('/:id/reindex', requireAuth, requireRole('admin'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const newId = Number(req.body.new_id);
  if (!Number.isInteger(newId) || newId < 1 || String(newId) !== String(req.body.new_id)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'new_id 必须是正整数。' });
  }
  if (newId === problem.id) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '目标编号与当前编号相同。' });
  }
  // 目标编号必须为空位置（不能被其它题目占用）
  const clash = db.prepare('SELECT id FROM problems WHERE id = ?').get(newId);
  if (clash) {
    return res.status(400).json({ code: 2, reason: 'ERR_INVALID_STATE', message: `编号 ${newId} 已被占用。` });
  }

  // 磁盘 testdata 目录迁移
  const oldDir = path.join(config.problemsDir, String(problem.id));
  const newDir = path.join(config.problemsDir, String(newId));
  if (fs.existsSync(newDir)) {
    return res.status(409).json({ code: 2, reason: 'ERR_INVALID_STATE', message: `目标目录 ${newId} 已存在，无法迁移测试数据。` });
  }

  try {
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');

    // 1) 磁盘目录改名（先于数据库提交，若失败回滚前还原）
    if (fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, newDir);
    }

    // 2) 引用 problem_id 的所有表同步更新
    const refTables = [
      'test_groups', 'test_cases', 'submissions', 'problem_set_items',
      'problem_set_progress', 'contest_problems', 'problem_solutions',
      'problem_tags', 'problem_categories', 'discussions', 'user_favorites',
      'problem_samples'
    ];
    for (const t of refTables) {
      db.prepare(`UPDATE ${t} SET problem_id = ? WHERE problem_id = ?`).run(newId, problem.id);
    }

    // 3) test_cases 中存绝对路径的 input_file/output_file 需重写旧目录前缀（相对路径不受影响）
    const oldPrefix = oldDir + path.sep;
    const newPrefix = newDir + path.sep;
    const tcRows = db.prepare('SELECT id, input_file, output_file FROM test_cases WHERE problem_id = ?').all(newId);
    const rewriteTc = db.prepare('UPDATE test_cases SET input_file = ?, output_file = ? WHERE id = ?');
    for (const tc of tcRows) {
      const inF = tc.input_file && path.isAbsolute(tc.input_file) && tc.input_file.startsWith(oldPrefix)
        ? newPrefix + tc.input_file.slice(oldPrefix.length) : tc.input_file;
      const outF = tc.output_file && path.isAbsolute(tc.output_file) && tc.output_file.startsWith(oldPrefix)
        ? newPrefix + tc.output_file.slice(oldPrefix.length) : tc.output_file;
      if (inF !== tc.input_file || outF !== tc.output_file) {
        rewriteTc.run(inF, outF, tc.id);
      }
    }

    // 4) 更新 problems 主键
    db.prepare('UPDATE problems SET id = ? WHERE id = ?').run(newId, problem.id);

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    // 回滚后还原磁盘目录
    if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
      try { fs.renameSync(newDir, oldDir); } catch {}
    }
    console.error('[problems] reindex failed:', sanitizeLog(String(err && err.message || err)));
    return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: '重编号失败，请重试。' });
  }

  const updated = db.prepare('SELECT * FROM problems WHERE id = ?').get(newId);
  res.json({ ...updated, old_id: problem.id });
});

router.post('/:id/testdata', requireAuth, requireRole('teacher'), upload.array('files', 100), (req, res) => {
  // 清理 multer 临时文件（含异常路径），避免磁盘残留
  const cleanupFiles = () => {
    if (!req.files) return;
    for (const f of req.files) {
      try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
    }
  };

  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    cleanupFiles();
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No files uploaded.' });
  }

  const problemDir = path.join(config.problemsDir, String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });

  try {
    // R9-25: 100×200MB 可写 ~20GB/请求，限制总大小
    const MAX_TESTDATA_TOTAL_BYTES = 200 * 1024 * 1024;
    let totalBytes = 0;
    for (const f of req.files) totalBytes += f.size || 0;
    if (totalBytes > MAX_TESTDATA_TOTAL_BYTES) {
      throw new Error(`Total testdata size exceeds ${MAX_TESTDATA_TOTAL_BYTES} bytes`);
    }

    const pairs = {};
    for (const file of req.files) {
      const match = file.originalname.match(/^(.+)\.(in|out)$/);
      if (!match) continue;
      // 文件名消毒: 只允许安全字符，且必须是纯文件名（防止 ../ 路径穿越）
      let name = path.basename(match[1]).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '');
      const ext = match[2];
      if (!name) name = 'case';
      if (!pairs[name]) pairs[name] = {};
      const destPath = path.join(problemDir, `${name}.${ext}`);
      fs.renameSync(file.path, destPath);
      pairs[name][ext] = destPath;
    }

    const insertTC = db.prepare('INSERT INTO test_cases (problem_id, input_file, output_file, sort_order) VALUES (?, ?, ?, ?)');
    let order = db.prepare('SELECT MAX(sort_order) as m FROM test_cases WHERE problem_id = ?').get(problem.id)?.m || 0;
    let count = 0;

    for (const [name, files] of Object.entries(pairs)) {
      order++;
      insertTC.run(problem.id, files.in || '', files.out || '', order);
      count++;
    }

    res.json({ message: `Uploaded ${count} test case(s).` });
  } finally {
    cleanupFiles();
  }
});

router.post('/:id/testdata-zip', requireAuth, requireRole('teacher'), upload.single('file'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  if (!req.file) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No file uploaded.' });
  }
  if (!req.file.originalname.endsWith('.zip')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'File must be a .zip file.' });
  }

  const problemDir = path.join(config.problemsDir, String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });

  try {
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    // Zip Bomb 防御: 限制条目数量与解压后总大小
    const MAX_ZIP_ENTRIES = 1000;
    const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500MB
    let totalBytes = 0;
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new Error(`ZIP contains too many entries (max ${MAX_ZIP_ENTRIES})`);
    }

    const rootScript = [];
    const subtasks = {};
    const rootTestCases = {};

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      totalBytes += entry.header.size;
      if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
        throw new Error(`ZIP total uncompressed size exceeds ${MAX_ZIP_TOTAL_BYTES} bytes`);
      }
      const entryPath = entry.entryName.replace(/\\/g, '/'); // 归一化反斜杠，防 Windows 风格路径穿越
      const parts = entryPath.split('/').filter(p => p);
      if (parts.length === 0) continue;
      // Zip Slip 防御: 拒绝含 .. / 空段 / 绝对路径 / 危险字符的条目
      if (path.isAbsolute(entryPath) || parts.some(p => p === '..' || p === '.')) {
        continue;
      }
      if (!parts.every(p => /^[\w.-]+$/.test(p))) {
        continue; // 仅允许安全文件名（子任务名/用例名最终拼入磁盘路径）
      }

      const fileName = parts[parts.length - 1];
      const dirPath = parts.slice(0, -1).join('/');
      // 仅允许文本类数据文件，防止 zip 内藏任意二进制/脚本被写入磁盘
      const extOk = /\.(in|out|ans|txt)$/i.test(fileName) || fileName.toLowerCase() === 'script.txt' || fileName.toLowerCase() === 'require.txt';
      if (!extOk) continue;

      if (parts.length === 1) {
        if (fileName.toLowerCase() === 'script.txt') {
          rootScript.push(entry.getData().toString('utf8'));
        } else {
          const match = fileName.match(/^(.+)\.(in|out|ans)$/);
          if (match) {
            const name = match[1];
            const ext = match[2] === 'ans' ? 'out' : match[2];
            if (!rootTestCases[name]) rootTestCases[name] = {};
            rootTestCases[name][ext] = entry.getData().toString('utf8');
          }
        }
      } else {
        const subtaskName = parts[0];
        if (!subtasks[subtaskName]) {
          subtasks[subtaskName] = { require: [], script: [], testCases: {} };
        }

        if (fileName.toLowerCase() === 'require.txt') {
          const content = entry.getData().toString('utf8');
          const deps = content.split(/[\s\n]+/).filter(s => s.trim());
          subtasks[subtaskName].require.push(...deps);
        } else if (fileName.toLowerCase() === 'script.txt') {
          subtasks[subtaskName].script.push(entry.getData().toString('utf8'));
        } else {
          const match = fileName.match(/^(.+)\.(in|out|ans)$/);
          if (match) {
            const name = match[1];
            const ext = match[2] === 'ans' ? 'out' : match[2];
            if (!subtasks[subtaskName].testCases[name]) subtasks[subtaskName].testCases[name] = {};
            subtasks[subtaskName].testCases[name][ext] = entry.getData().toString('utf8');
          }
        }
      }
    }

    db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(problem.id);
    db.prepare('DELETE FROM test_groups WHERE problem_id = ?').run(problem.id);

    let order = 0;
    let count = 0;

    if (rootScript.length > 0) {
      db.prepare("UPDATE problems SET scoring_script = ?, updated_at = datetime('now') WHERE id = ?").run(rootScript.join('\n'), problem.id);
    }

    for (const [subtaskName, subtaskData] of Object.entries(subtasks)) {
      const depIds = [];
      for (const depName of subtaskData.require) {
        const depGroup = db.prepare('SELECT id FROM test_groups WHERE problem_id = ? AND subtask_id = ?').get(problem.id, depName);
        if (depGroup) depIds.push(depGroup.id);
      }

      const groupResult = db.prepare('INSERT INTO test_groups (problem_id, subtask_id, score, aggregator, dependency, scoring_script) VALUES (?, ?, ?, ?, ?, ?)').run(
        problem.id,
        subtaskName,
        0,
        'sum',
        JSON.stringify(depIds),
        subtaskData.script.join('\n')
      );
      const groupId = groupResult.lastInsertRowid;

      for (const [name, files] of Object.entries(subtaskData.testCases)) {
        order++;
        const inputPath = path.join(problemDir, `${subtaskName}_${name}.in`);
        const outputPath = path.join(problemDir, `${subtaskName}_${name}.out`);
        assertInsideProblemDir(problemDir, inputPath);
        assertInsideProblemDir(problemDir, outputPath);
        if (files.in) fs.writeFileSync(inputPath, files.in);
        if (files.out) fs.writeFileSync(outputPath, files.out);
        db.prepare('INSERT INTO test_cases (problem_id, group_id, input_file, output_file, sort_order) VALUES (?, ?, ?, ?, ?)').run(
          problem.id, groupId, inputPath, outputPath, order
        );
        count++;
      }
    }

    for (const [name, files] of Object.entries(rootTestCases)) {
      order++;
      const inputPath = path.join(problemDir, `${name}.in`);
      const outputPath = path.join(problemDir, `${name}.out`);
      assertInsideProblemDir(problemDir, inputPath);
      assertInsideProblemDir(problemDir, outputPath);
      if (files.in) fs.writeFileSync(inputPath, files.in);
      if (files.out) fs.writeFileSync(outputPath, files.out);
      db.prepare('INSERT INTO test_cases (problem_id, input_file, output_file, sort_order) VALUES (?, ?, ?, ?)').run(
        problem.id, inputPath, outputPath, order
      );
      count++;
    }

    fs.unlinkSync(req.file.path);
    res.json({ message: `Imported ${count} test case(s) from ${Object.keys(subtasks).length} subtask(s).` });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('[problems] ZIP import failed:', sanitizeLog(String(err && err.message || err)));
    res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'ZIP 数据导入失败，请检查文件格式。' });
  }
});

router.get('/:id/testdata', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const testCases = db.prepare('SELECT tc.*, tg.subtask_id FROM test_cases tc LEFT JOIN test_groups tg ON tc.group_id = tg.id WHERE tc.problem_id = ? ORDER BY tc.sort_order, tc.id').all(problem.id);
  
  const problemDir = path.join(config.problemsDir, String(problem.id));
  
  function resolveFilePath(baseDir, storedPath) {
    if (!storedPath) return null;
    // 防路径穿越: 一律 norm 到 baseDir 之下；绝对路径或含 .. 的拒绝
    const resolved = path.resolve(baseDir, storedPath);
    const base = path.resolve(baseDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }

  const result = testCases.map(tc => {
    let inputData = tc.input_data || '';
    let outputData = tc.output_data || '';
    
    const inputPath = resolveFilePath(problemDir, tc.input_file);
    if (!inputData && inputPath && fs.existsSync(inputPath)) {
      try { inputData = fs.readFileSync(inputPath, 'utf8'); } catch {}
    }
    
    const outputPath = resolveFilePath(problemDir, tc.output_file);
    if (!outputData && outputPath && fs.existsSync(outputPath)) {
      try { outputData = fs.readFileSync(outputPath, 'utf8'); } catch {}
    }
    
    return {
      id: tc.id,
      group_id: tc.group_id || null,
      subtask_id: tc.subtask_id || '',
      input_data: inputData,
      output_data: outputData,
      input_file: tc.input_file ? path.basename(tc.input_file) : '',
      output_file: tc.output_file ? path.basename(tc.output_file) : '',
      score: tc.score,
      time_limit: tc.time_limit || null,
      memory_limit: tc.memory_limit || null,
      sort_order: tc.sort_order
    };
  });
  res.json(result);
});

router.post('/:id/testcases', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const { test_cases } = req.body;
  if (!Array.isArray(test_cases) || test_cases.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'test_cases array is required.' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM test_cases WHERE problem_id = ?').get(problem.id)?.m || 0;
  let order = maxOrder;
  let count = 0;

  for (const tc of test_cases) {
    order++;
    const tl = tc.time_limit ? parseInt(tc.time_limit) : null;
    const ml = tc.memory_limit ? parseInt(tc.memory_limit) : null;
    if (tc.group_id !== undefined && tc.group_id !== null && tc.group_id !== '') {
      db.prepare('INSERT INTO test_cases (problem_id, group_id, input_data, output_data, score, time_limit, memory_limit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        problem.id, tc.group_id, tc.input_data || '', tc.output_data || '', tc.score || 0, tl, ml, order
      );
    } else {
      db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, score, time_limit, memory_limit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        problem.id, tc.input_data || '', tc.output_data || '', tc.score || 0, tl, ml, order
      );
    }
    count++;
  }

  res.json({ message: `Added ${count} test case(s).` });
});

router.delete('/:id/testcases', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(problem.id);
  res.json({ message: 'All test cases deleted.' });
});

router.get('/:id/groups', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const groups = db.prepare('SELECT * FROM test_groups WHERE problem_id = ? ORDER BY id').all(problem.id);
  const result = groups.map(g => ({
    ...g,
    dependency: JSON.parse(g.dependency || '[]')
  }));
  res.json(result);
});

router.post('/:id/groups', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const { subtask_id, score, aggregator, dependency, scoring_script } = req.body;
  if (!subtask_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'subtask_id is required.' });
  }
  const result = db.prepare('INSERT INTO test_groups (problem_id, subtask_id, score, aggregator, dependency, scoring_script) VALUES (?, ?, ?, ?, ?, ?)').run(
    problem.id,
    subtask_id,
    score || 0,
    aggregator || 'sum',
    JSON.stringify(dependency || []),
    scoring_script || ''
  );
  const group = db.prepare('SELECT * FROM test_groups WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...group, dependency: JSON.parse(group.dependency || '[]') });
});

router.put('/:id/groups/:gid', requireAuth, requireRole('teacher'), (req, res) => {
  const group = db.prepare('SELECT * FROM test_groups WHERE id = ? AND problem_id = ?').get(req.params.gid, req.params.id);
  if (!group) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Group not found.' });
  }
  const { subtask_id, score, aggregator, dependency, scoring_script } = req.body;
  const u = buildUpdates([
    { key: 'subtask_id', value: subtask_id },
    { key: 'score', value: score },
    { key: 'aggregator', value: aggregator },
    { key: 'dependency', value: dependency, transform: v => JSON.stringify(v) },
    { key: 'scoring_script', value: scoring_script }
  ]);
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  db.prepare(`UPDATE test_groups SET ${u.clause} WHERE id = ?`).run(...u.values, group.id);
  const updated = db.prepare('SELECT * FROM test_groups WHERE id = ?').get(group.id);
  res.json({ ...updated, dependency: JSON.parse(updated.dependency || '[]') });
});

router.delete('/:id/groups/:gid', requireAuth, requireRole('teacher'), (req, res) => {
  const group = db.prepare('SELECT * FROM test_groups WHERE id = ? AND problem_id = ?').get(req.params.gid, req.params.id);
  if (!group) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Group not found.' });
  }
  db.prepare('UPDATE test_cases SET group_id = NULL WHERE group_id = ?').run(group.id);
  // 从所有分组 dependency JSON 中安全移除该分组 id（避免 REPLACE 字符串误伤 112/121 等）
  const deps = db.prepare('SELECT id, dependency FROM test_groups WHERE problem_id = ? AND dependency IS NOT NULL').all(req.params.id);
  const fixDep = db.prepare('UPDATE test_groups SET dependency = ? WHERE id = ?');
  for (const d of deps) {
    let arr = [];
    try { arr = JSON.parse(d.dependency || '[]'); } catch { arr = []; }
    if (Array.isArray(arr) && arr.includes(group.id)) {
      fixDep.run(JSON.stringify(arr.filter(id => id !== group.id)), d.id);
    }
  }
  db.prepare('DELETE FROM test_groups WHERE id = ?').run(group.id);
  res.json({ message: 'Group deleted.' });
});

router.put('/:id/scoring-script', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const { scoring_script } = req.body;
  db.prepare("UPDATE problems SET scoring_script = ?, updated_at = datetime('now') WHERE id = ?").run(scoring_script || '', problem.id);
  res.json({ message: 'Scoring script updated.' });
});

router.put('/:id/testcases/:tcid/group', requireAuth, requireRole('teacher'), (req, res) => {
  const tc = db.prepare('SELECT * FROM test_cases WHERE id = ? AND problem_id = ?').get(req.params.tcid, req.params.id);
  if (!tc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Test case not found.' });
  }
  const { group_id } = req.body;
  db.prepare('UPDATE test_cases SET group_id = ? WHERE id = ?').run(group_id || null, tc.id);
  res.json({ message: 'Test case updated.' });
});

router.put('/:id/testcases/:tcid', requireAuth, requireRole('teacher'), (req, res) => {
  const tc = db.prepare('SELECT * FROM test_cases WHERE id = ? AND problem_id = ?').get(req.params.tcid, req.params.id);
  if (!tc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Test case not found.' });
  }
  const { input_data, output_data, score, group_id, sort_order, time_limit, memory_limit } = req.body;
  const u = buildUpdates([
    { key: 'input_data', value: input_data },
    { key: 'output_data', value: output_data },
    { key: 'score', value: score },
    { key: 'group_id', value: group_id, transform: v => v || null },
    { key: 'sort_order', value: sort_order },
    { key: 'time_limit', value: time_limit, transform: v => v ? parseInt(v) : null },
    { key: 'memory_limit', value: memory_limit, transform: v => v ? parseInt(v) : null }
  ]);
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  db.prepare(`UPDATE test_cases SET ${u.clause} WHERE id = ?`).run(...u.values, tc.id);
  res.json({ message: 'Test case updated.' });
});

router.delete('/:id/testcases/:tcid', requireAuth, requireRole('teacher'), (req, res) => {
  const tc = db.prepare('SELECT * FROM test_cases WHERE id = ? AND problem_id = ?').get(req.params.tcid, req.params.id);
  if (!tc) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Test case not found.' });
  }
  db.prepare('DELETE FROM test_cases WHERE id = ?').run(tc.id);
  res.json({ message: 'Test case deleted.' });
});

router.put('/:id/batch-testcases', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }

  const { score, time_limit, memory_limit } = req.body;
  const notEmpty = v => v !== undefined && v !== null && v !== '';
  const u = buildUpdates([
    { key: 'score', value: notEmpty(score) ? score : undefined },
    { key: 'time_limit', value: notEmpty(time_limit) ? time_limit : undefined, transform: parseInt },
    { key: 'memory_limit', value: notEmpty(memory_limit) ? memory_limit : undefined, transform: parseInt }
  ]);

  if (u.count > 0) {
    db.prepare(`UPDATE test_cases SET ${u.clause} WHERE problem_id = ?`).run(...u.values, problem.id);
  }

  const parts = [];
  if (u.count > 0) {
    if (notEmpty(score)) parts.push('分数');
    if (notEmpty(time_limit)) parts.push('时间限制');
    if (notEmpty(memory_limit)) parts.push('内存限制');
  }
  res.json({ message: parts.length > 0 ? parts.join('、') + '已更新。' : '没有需要更新的内容。' });
});

router.get('/:id/solutions', optionalAuth, (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const solutions = db.prepare(`
    SELECT ps.id, ps.article_id, ps.sort_order, ps.show_after_contest, ps.created_at,
           a.title as article_title, a.content as article_content, a.is_published,
           u.username as author_name
    FROM problem_solutions ps
    LEFT JOIN articles a ON ps.article_id = a.id
    LEFT JOIN users u ON a.author_id = u.id
    WHERE ps.problem_id = ? ORDER BY ps.sort_order
  `).all(problem.id);
  const staff = !!req.user && isStaff(req.user.role);
  if (staff) {
    return res.json(solutions);
  }
  // 非教师只看已发布题解且隐藏未发布文章内容
  const visible = solutions
    .filter(s => s.is_published === 1)
    .map(s => ({ ...s, article_content: undefined }));
  res.json(visible);
});

router.post('/:id/solutions', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const { article_id, sort_order, show_after_contest } = req.body;
  if (!article_id) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'article_id is required.' });
  }
  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(article_id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  db.prepare('INSERT INTO problem_solutions (problem_id, article_id, sort_order, show_after_contest) VALUES (?, ?, ?, ?)').run(
    problem.id, article_id, sort_order || 0, show_after_contest ? 1 : 0
  );
  res.status(201).json({ message: 'Solution linked.' });
});

router.delete('/:id/solutions/:sid', requireAuth, requireRole('teacher'), (req, res) => {
  db.prepare('DELETE FROM problem_solutions WHERE id = ? AND problem_id = ?').run(req.params.sid, req.params.id);
  res.json({ message: 'Solution removed.' });
});

// 功能8：题目讨论列表
router.get('/:id/discussions', optionalAuth, (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const { page: pageNum, limit: sizeNum, offset } = parsePageLimit(page, size, 20, 50);
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  // R10-2: 隐藏题/非公开题不可见性校验，与 GET /:id 保持一致
  const verr = problemVisibilityError(problem, req);
  if (verr) {
    return res.status(403).json(verr);
  }
  const total = db.prepare('SELECT COUNT(*) as c FROM discussions WHERE problem_id = ?').get(req.params.id).c;
  const items = db.prepare(`
    SELECT d.id, d.title, d.is_official, d.pinned, d.locked, d.created_at, d.updated_at,
           u.username, u.nickname, u.role,
           (SELECT COUNT(*) FROM discussion_replies WHERE discussion_id = d.id) as reply_count
    FROM discussions d LEFT JOIN users u ON d.author_id = u.id
    WHERE d.problem_id = ?
    ORDER BY d.pinned DESC, d.is_official DESC, d.id DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, sizeNum, offset);
  res.json({ total, page: pageNum, size: sizeNum, discussions: items });
});

// 功能10：发起查重（admin/teacher，异步）
// POST /api/v1/problems/:id/plagiarism-check  返回 {task_id}
router.post('/:id/plagiarism-check', requireAuth, requireRole('teacher'), plagiarismRateLimit, (req, res) => {
  const problem = db.prepare('SELECT id FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const { createTask } = require('../services/plagiarism');
  const taskId = createTask(parseInt(req.params.id), req.user.id);
  res.status(202).json({ task_id: taskId, message: 'Plagiarism check started.' });
});

// 功能10：获取题目最近一次查重报告
// GET /api/v1/problems/:id/plagiarism-report
router.get('/:id/plagiarism-report', requireAuth, requireRole('teacher'), (req, res) => {
  const { getLatestTaskForProblem } = require('../services/plagiarism');
  const task = getLatestTaskForProblem(parseInt(req.params.id));
  if (!task) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'No plagiarism task found for this problem.' });
  }
  res.json(task);
});

// 功能12：AI 智能测试点生成器（teacher+）
// POST /api/v1/problems/:id/ai-testdata
// body: { samples: 3, edge_cases: 3 }  生成普通样例 + 边界测试点并写入 test_cases
router.post('/:id/ai-testdata', requireAuth, requireRole('teacher'), aiTestdataRateLimit, async (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
const { aiEnabled, aiChatJSON } = require('../services/aiClient');
const config = require('../config/config');
if (!aiEnabled(config.ai.testdata)) {
    return res.status(503).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 服务未启用，请先在 config/ai.txt 中启用。' });
  }
  const samples = Math.min(Math.max(parseInt(req.body.samples) || 3, 1), 10);
  const edgeCases = Math.min(Math.max(parseInt(req.body.edge_cases) || 3, 0), 10);

  const prompt = `你是一位出题专家。请根据下面的题目信息，生成用于在线判题（OJ）的测试点。
题目信息：
- 标题: ${problem.title}
- 描述: ${problem.description}
- 输入格式: ${problem.input_desc}
- 输出格式: ${problem.output_desc}
- 数据范围/提示: ${problem.hint}

要求：
1. 生成 ${samples} 组普通样例（覆盖常规输入）和 ${edgeCases} 组边界测试点（如最小/最大数据、空输入、重复元素、极端情况、可能导致整数溢出的边界等）。
2. 每个测试点包含 input 与 expected_output 两个字段，使用与题目描述一致的输入输出格式。
3. 输入与输出都用纯文本，多行用 \\n 分隔。
4. 只输出一个 JSON 对象，不要包含任何其他文字：
{"test_cases": [{"name": "case1", "input": "...", "expected_output": "..."}]}`;

  try {
    const result = await aiChatJSON(prompt, `请为这道题生成测试点。`, { cfg: config.ai.testdata, numPredict: 8192, timeoutMs: 90000 });
    const cases = Array.isArray(result.test_cases) ? result.test_cases : [];
    if (cases.length === 0) {
      return res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 未返回有效测试点，请重试。' });
    }
    const problemDir = path.join(config.problemsDir, String(problem.id));
    fs.mkdirSync(problemDir, { recursive: true });
    const insertTC = db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, sort_order) VALUES (?, ?, ?, ?)');
    let order = db.prepare('SELECT MAX(sort_order) as m FROM test_cases WHERE problem_id = ?').get(problem.id)?.m || 0;
    let count = 0;
    const saved = [];
    for (const tc of cases) {
      const name = String(tc.name || `ai_${count + 1}`).replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
      const input = String(tc.input ?? '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trimEnd() + '\n';
      const output = String(tc.expected_output ?? '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trimEnd() + '\n';
      order++;
      insertTC.run(problem.id, input, output, order);
      // 同时写入磁盘文件（与 ZIP 导入一致，便于人工查看/复用）
      try {
        fs.writeFileSync(path.join(problemDir, `${name}.in`), input, 'utf8');
        fs.writeFileSync(path.join(problemDir, `${name}.out`), output, 'utf8');
      } catch {}
      count++;
      saved.push(name);
    }
    res.json({ message: `AI 生成 ${count} 个测试点并已保存。`, count, cases: saved });
  } catch (err) {
    console.error(`AI testdata error for problem ${problem.id}:`, sanitizeLog(String(err.message || err)));
    res.status(502).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'AI 测试点生成失败，请检查 AI 服务是否可用。' });
  }
});

// 功能14：导出题目（JSON/ZIP，teacher+）
// GET /api/v1/problems/:id/export?format=json|zip
// 返回完整题目数据（含测试点/标签/分组），zip 模式附带 .in/.out 文件供重新导入
router.get('/:id/export', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const format = (req.query.format || 'zip').toLowerCase();

  const testCases = db.prepare('SELECT * FROM test_cases WHERE problem_id = ? ORDER BY sort_order, id').all(problem.id);
  const testGroups = db.prepare('SELECT * FROM test_groups WHERE problem_id = ? ORDER BY id').all(problem.id);
  const tags = db.prepare(`
    SELECT t.name FROM tags t
    JOIN problem_tags pt ON pt.tag_id = t.id
    WHERE pt.problem_id = ? ORDER BY t.name
  `).all(problem.id).map(r => r.name);
  const categories = db.prepare(`
    SELECT c.name FROM categories c
    JOIN problem_categories pc ON pc.category_id = c.id
    WHERE pc.problem_id = ? ORDER BY c.name
  `).all(problem.id).map(r => r.name);

  const bundle = {
    version: 1,
    exported_at: new Date().toISOString(),
    problem: {
      title: problem.title,
      description: problem.description,
      input_desc: problem.input_desc,
      output_desc: problem.output_desc,
      hint: problem.hint,
      time_limit: problem.time_limit,
      memory_limit: problem.memory_limit,
      problem_type: problem.problem_type,
      compare_mode: problem.compare_mode,
      real_number_tolerance: problem.real_number_tolerance ? JSON.parse(problem.real_number_tolerance) : { absolute: 0.001, relative: 0.001 },
      spj_code: problem.spj_code,
      scoring_script: problem.scoring_script,
      allowed_languages: problem.allowed_languages ? JSON.parse(problem.allowed_languages) : [],
      is_public: !!problem.is_public,
      is_hidden: !!problem.is_hidden,
      provider: problem.provider,
      sample_input: problem.sample_input,
      sample_output: problem.sample_output,
      samples: getSamples(problem.id),
      subtask_mode: problem.subtask_mode,
      difficulty: problem.difficulty
    },
    tags,
    categories,
    test_groups: testGroups,
    test_cases: testCases.map(tc => ({
      name: `case_${tc.sort_order || tc.id}`,
      input_data: tc.input_data,
      output_data: tc.output_data,
      input_file: tc.input_file && !path.isAbsolute(tc.input_file) ? tc.input_file : '',
      output_file: tc.output_file && !path.isAbsolute(tc.output_file) ? tc.output_file : '',
      score: tc.score,
      time_limit: tc.time_limit,
      memory_limit: tc.memory_limit,
      sort_order: tc.sort_order,
      group_id: tc.group_id
    }))
  };

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="problem_${problem.id}.json"`);
    return res.json(bundle);
  }

  // ZIP 模式：problem.json + 每个测试点写入磁盘文件后打包
  const problemDir = path.join(config.problemsDir, String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile('problem.json', Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
  for (const tc of testCases) {
    const name = `case_${tc.sort_order || tc.id}`;
    const input = tc.input_data || (tc.input_file && safeReadFile(problemDir, tc.input_file)) || '';
    const output = tc.output_data || (tc.output_file && safeReadFile(problemDir, tc.output_file)) || '';
    zip.addFile(`testdata/${name}.in`, Buffer.from(input, 'utf8'));
    zip.addFile(`testdata/${name}.out`, Buffer.from(output, 'utf8'));
  }
  if (testGroups.length > 0) {
    zip.addFile('test_groups.json', Buffer.from(JSON.stringify(testGroups, null, 2), 'utf8'));
  }
  const buf = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="problem_${problem.id}.zip"`);
  res.send(buf);
});

// 安全读取 problems 目录内的文件（防路径穿越）
function safeReadFile(baseDir, fileName) {
  try {
    const fp = path.resolve(baseDir, fileName);
    const base = path.resolve(baseDir) + path.sep;
    if (!fp.startsWith(base)) return '';
    return fs.readFileSync(fp, 'utf8');
  } catch { return ''; }
}

// 功能15：导入题目（JSON 或 ZIP，teacher+）
// POST /api/v1/problems/import  multipart file=problem.json|problem.zip
router.post('/import', requireAuth, requireRole('teacher'), upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No file uploaded.' });
  }
  const cleanup = () => { try { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {} };
  try {
    const fname = req.file.originalname.toLowerCase();
    let bundle;
    if (fname.endsWith('.zip')) {
      const zip = new AdmZip(req.file.path);
      // Zip Bomb 防御：限制条目数与解压总大小（与 testdata-zip 一致，D-M6）
      const entries = zip.getEntries();
      const MAX_IMPORT_ENTRIES = 2000;
      const MAX_IMPORT_TOTAL_BYTES = 200 * 1024 * 1024;
      let totalBytes = 0;
      for (const e of entries) {
        if (e.isDirectory) continue;
        totalBytes += e.header.size;
        if (entries.length > MAX_IMPORT_ENTRIES || totalBytes > MAX_IMPORT_TOTAL_BYTES) {
          cleanup();
          return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'ZIP 文件过大或条目过多。' });
        }
      }
      const entry = entries.find(e => !e.isDirectory && e.entryName.replace(/\\/g, '/').split('/').pop() === 'problem.json');
      if (!entry) {
        cleanup();
        return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'ZIP 中缺少 problem.json。' });
      }
      bundle = JSON.parse(entry.getData().toString('utf8'));
      if (bundle && bundle.problem) {
        // 从 ZIP 中读取 testdata/ 下的 .in/.out 文件覆盖/补充 inline 测试点
        const tcMap = new Map((bundle.test_cases || []).map(tc => [tc.name, tc]));
        for (const e of entries) {
          if (e.isDirectory) continue;
          const p = e.entryName.replace(/\\/g, '/');
          const m = p.match(/^testdata\/([^/]+)\.(in|out)$/);
          if (!m) continue;
          const name = m[1];
          const ext = m[2];
          const existing = tcMap.get(name) || {};
          if (ext === 'in') existing.input_data = e.getData().toString('utf8');
          else existing.output_data = e.getData().toString('utf8');
          tcMap.set(name, existing);
        }
        bundle.test_cases = Array.from(tcMap.values());
      }
    } else if (fname.endsWith('.json') || fname.endsWith('.json.gz')) {
      bundle = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    } else {
      cleanup();
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '仅支持 .zip 或 .json 文件。' });
    }

    if (!bundle || !bundle.problem || !bundle.problem.title) {
      cleanup();
      return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '文件内容缺少 problem.title。' });
    }
    const p = bundle.problem;
    const newId = db.findNextId('problems');
    db.prepare(`INSERT INTO problems (id, title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, scoring_script, allowed_languages, is_public, provider, created_by, sample_input, sample_output, subtask_mode, difficulty, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newId,
      p.title,
      p.description || '',
      p.input_desc || '',
      p.output_desc || '',
      p.hint || '',
      p.time_limit || 1000,
      p.memory_limit || 256,
      p.problem_type || 'traditional',
      p.compare_mode || 'text_strict',
      JSON.stringify(p.real_number_tolerance || { absolute: 0.001, relative: 0.001 }),
      p.spj_code || '',
      p.scoring_script || '',
      JSON.stringify(p.allowed_languages || []),
      p.is_public !== undefined ? (p.is_public ? 1 : 0) : 1,
      p.provider || '',
      req.user.id,
      p.sample_input || '',
      p.sample_output || '',
      p.subtask_mode || 'simple',
      p.difficulty !== undefined ? parseInt(p.difficulty) || 0 : 0,
      p.is_hidden !== undefined ? (p.is_hidden ? 1 : 0) : 0
    );

    // 写入分组（先建分组，便于 test_cases 的 group_id 重映射到新 id，D-M8）
    const groups = bundle.test_groups || [];
    const insertGroup = db.prepare('INSERT INTO test_groups (problem_id, subtask_id, score, aggregator, dependency, scoring_script) VALUES (?, ?, ?, ?, ?, ?)');
    const groupIdMap = {};
    for (const g of groups) {
      const r = insertGroup.run(newId, g.subtask_id || null, g.score || 0, g.aggregator || 'sum', g.dependency || '', g.scoring_script || '');
      groupIdMap[g.id] = r.lastInsertRowid;
    }

    // R12-1: 导入多样例(Array.isArray 校验; 旧格式无 samples 字段则跳过, 旧字段已随 INSERT 写入)
    const importSamples = normalizeSamples(p.samples);
    if (importSamples && importSamples.length > 0) replaceSamples(newId, importSamples);

    // 写入测试点
    const insertTC = db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, score, sort_order, group_id, time_limit, memory_limit, input_file, output_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // 文件引用消毒：仅允许纯文件名（无分隔符/..），避免穿越 problems 目录（D-H2/D-M8）
    const safeFileName = (f) => {
      if (!f || typeof f !== 'string') return '';
      const base = f.replace(/\\/g, '/').split('/').pop();
      return /^[\w.-]+$/.test(base) ? base : '';
    };
    const tcs = bundle.test_cases || [];
    tcs.forEach((tc, i) => {
      const mappedGroup = tc.group_id != null ? (groupIdMap[tc.group_id] || null) : null;
      insertTC.run(
        newId,
        tc.input_data || '',
        tc.output_data || '',
        tc.score || 0,
        tc.sort_order || (i + 1),
        mappedGroup,
        tc.time_limit || null,
        tc.memory_limit || null,
        (!tc.input_data && tc.input_file) ? safeFileName(tc.input_file) : '',
        (!tc.output_data && tc.output_file) ? safeFileName(tc.output_file) : ''
      );
    });

    // 标签与分类（存在则复用，不存在则创建）
    for (const name of bundle.tags || []) {
      if (!name) continue;
      let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      if (!tag) {
        tag = { id: db.findNextId('tags') };
        db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tag.id, name);
      }
      db.prepare('INSERT OR IGNORE INTO problem_tags (problem_id, tag_id) VALUES (?, ?)').run(newId, tag.id);
    }
    for (const name of bundle.categories || []) {
      if (!name) continue;
      let cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
      if (!cat) {
        cat = { id: db.findNextId('categories') };
        db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(cat.id, name);
      }
      db.prepare('INSERT OR IGNORE INTO problem_categories (problem_id, category_id) VALUES (?, ?)').run(newId, cat.id);
    }

    const created = db.prepare('SELECT * FROM problems WHERE id = ?').get(newId);
    cleanup();
    res.status(201).json({ message: `导入成功，新题目 ID: ${newId}`, problem: created });
  } catch (err) {
    console.error('Import problem error:', sanitizeLog(String(err.message || err)));
    cleanup();
    res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `导入失败: ${err.message}` });
  }
});

module.exports = router;
