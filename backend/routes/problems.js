const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const uploadDir = path.join(__dirname, '../../data/uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 200 * 1024 * 1024 } });

function sanitizeProblem(p) {
  if (!p) return null;
  const result = { ...p };
  delete result.spj_code;
  delete result.scoring_script;
  return result;
}

router.get('/', (req, res) => {
  const { page = 1, limit = 50, search = '', tag = '', tags = '', category = '', difficulty = '', sort = '', order = 'desc' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE p.is_public = 1';
  const params = [];

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
    SELECT p.id, p.title, p.problem_type, p.time_limit, p.memory_limit, p.is_public, p.difficulty, p.created_at,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id) as sub_count,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.status = 'accepted') as ac_count,
      CASE WHEN (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id) > 0
        THEN (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.status = 'accepted') * 1.0 / (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id)
        ELSE 0 END as ac_rate
    FROM problems p ${where} ${orderClause} LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  for (const problem of problems) {
    const ac = problem.ac_count || 0;
    const sub = problem.sub_count || 0;
    problem.accept_rate = sub > 0 ? Math.round((ac / sub) * 1000) / 10 : 0;
    const tags = db.prepare(`
      SELECT t.id, t.name, t.color FROM tags t
      JOIN problem_tags pt ON t.id = pt.tag_id
      WHERE pt.problem_id = ?
    `).all(problem.id);
    problem.tags = tags;

    const cats = db.prepare(`
      SELECT c.id, c.name, c.description FROM categories c
      JOIN problem_categories pc ON c.id = pc.category_id
      WHERE pc.problem_id = ?
    `).all(problem.id);
    problem.categories = cats;
  }

  res.json({ total, page: parseInt(page), limit: parseInt(limit), problems });
});

router.get('/:id', (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  if (!problem.is_public) {
    const inContest = db.prepare('SELECT cp.contest_id FROM contest_problems cp WHERE cp.problem_id = ?').get(problem.id);
    if (!inContest || !req.user || req.user.role === 'user') {
      return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Problem is not public.' });
    }
  }
  const result = sanitizeProblem(problem);
  result.test_cases_count = db.prepare('SELECT COUNT(*) as c FROM test_cases WHERE problem_id = ?').get(problem.id).c;
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
  res.json(result);
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, sample_input, sample_output, subtask_mode, difficulty } = req.body;
  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  const newId = db.findNextId('problems');
  db.prepare(`INSERT INTO problems (id, title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, created_by, sample_input, sample_output, subtask_mode, difficulty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
    sample_input || '',
    sample_output || '',
    subtask_mode || 'simple',
    difficulty !== undefined ? parseInt(difficulty) || 0 : 0
  );
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(newId);
  res.status(201).json(sanitizeProblem(problem));
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

  const fields = ['title', 'description', 'input_desc', 'output_desc', 'hint', 'time_limit', 'memory_limit', 'problem_type', 'compare_mode', 'real_number_tolerance', 'spj_code', 'allowed_languages', 'is_public', 'provider', 'sample_input', 'sample_output', 'subtask_mode', 'difficulty'];
  const updates = [];
  const values = [];
  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      if (field === 'real_number_tolerance' || field === 'allowed_languages') {
        values.push(JSON.stringify(req.body[field]));
      } else if (field === 'is_public') {
        values.push(req.body[field] ? 1 : 0);
      } else if (field === 'difficulty') {
        values.push(parseInt(req.body[field]) || 0);
      } else {
        values.push(req.body[field]);
      }
    }
  }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  updates.push("updated_at = datetime('now')");
  values.push(problem.id);
  db.prepare(`UPDATE problems SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM problems WHERE id = ?').get(problem.id);
  res.json(sanitizeProblem(updated));
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
  db.prepare('DELETE FROM problems WHERE id = ?').run(problem.id);
  res.json({ message: 'Problem deleted.' });
});

router.post('/:id/testdata', requireAuth, requireRole('teacher'), upload.array('files', 100), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No files uploaded.' });
  }

  const problemDir = path.join(__dirname, '../../problems', String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });

  const pairs = {};
  for (const file of req.files) {
    const match = file.originalname.match(/^(.+)\.(in|out)$/);
    if (!match) {
      fs.unlinkSync(file.path);
      continue;
    }
    const name = match[1];
    const ext = match[2];
    if (!pairs[name]) pairs[name] = {};
    const destPath = path.join(problemDir, file.originalname);
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

  const problemDir = path.join(__dirname, '../../problems', String(problem.id));
  fs.mkdirSync(problemDir, { recursive: true });

  try {
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();

    const rootScript = [];
    const subtasks = {};
    const rootTestCases = {};

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName;
      const parts = entryPath.split('/').filter(p => p);
      if (parts.length === 0) continue;
      // Zip Slip 防御: 拒绝包含 .. 或绝对路径的条目
      if (parts.some(p => p === '..') || path.isAbsolute(entryPath)) {
        continue;
      }

      const fileName = parts[parts.length - 1];
      const dirPath = parts.slice(0, -1).join('/');

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
    res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: `Failed to process ZIP: ${err.message}` });
  }
});

router.get('/:id/testdata', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const testCases = db.prepare('SELECT tc.*, tg.subtask_id FROM test_cases tc LEFT JOIN test_groups tg ON tc.group_id = tg.id WHERE tc.problem_id = ? ORDER BY tc.sort_order, tc.id').all(problem.id);
  
  const problemDir = path.join(__dirname, '../../problems', String(problem.id));
  
  function resolveFilePath(baseDir, storedPath) {
    if (!storedPath) return null;
    return path.isAbsolute(storedPath) ? storedPath : path.join(baseDir, storedPath);
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
  const updates = [];
  const values = [];
  if (subtask_id !== undefined) { updates.push('subtask_id = ?'); values.push(subtask_id); }
  if (score !== undefined) { updates.push('score = ?'); values.push(score); }
  if (aggregator !== undefined) { updates.push('aggregator = ?'); values.push(aggregator); }
  if (dependency !== undefined) { updates.push('dependency = ?'); values.push(JSON.stringify(dependency)); }
  if (scoring_script !== undefined) { updates.push('scoring_script = ?'); values.push(scoring_script); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(group.id);
  db.prepare(`UPDATE test_groups SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM test_groups WHERE id = ?').get(group.id);
  res.json({ ...updated, dependency: JSON.parse(updated.dependency || '[]') });
});

router.delete('/:id/groups/:gid', requireAuth, requireRole('teacher'), (req, res) => {
  const group = db.prepare('SELECT * FROM test_groups WHERE id = ? AND problem_id = ?').get(req.params.gid, req.params.id);
  if (!group) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Group not found.' });
  }
  db.prepare('UPDATE test_cases SET group_id = NULL WHERE group_id = ?').run(group.id);
  db.prepare('UPDATE test_groups SET dependency = REPLACE(dependency, ?, ?)').run(String(group.id), '');
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
  const updates = [];
  const values = [];
  if (input_data !== undefined) { updates.push('input_data = ?'); values.push(input_data); }
  if (output_data !== undefined) { updates.push('output_data = ?'); values.push(output_data); }
  if (score !== undefined) { updates.push('score = ?'); values.push(score); }
  if (group_id !== undefined) { updates.push('group_id = ?'); values.push(group_id || null); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (time_limit !== undefined) { updates.push('time_limit = ?'); values.push(time_limit ? parseInt(time_limit) : null); }
  if (memory_limit !== undefined) { updates.push('memory_limit = ?'); values.push(memory_limit ? parseInt(memory_limit) : null); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(tc.id);
  db.prepare(`UPDATE test_cases SET ${updates.join(', ')} WHERE id = ?`).run(...values);
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
  const updates = [];
  const values = [];

  if (score !== undefined && score !== null && score !== '') {
    updates.push('score = ?');
    values.push(score);
  }
  if (time_limit !== undefined && time_limit !== null && time_limit !== '') {
    updates.push('time_limit = ?');
    values.push(parseInt(time_limit));
  }
  if (memory_limit !== undefined && memory_limit !== null && memory_limit !== '') {
    updates.push('memory_limit = ?');
    values.push(parseInt(memory_limit));
  }

  if (updates.length > 0) {
    values.push(problem.id);
    db.prepare(`UPDATE test_cases SET ${updates.join(', ')} WHERE problem_id = ?`).run(...values);
  }

  const parts = [];
  if (updates.length > 0) {
    if (score !== undefined && score !== null && score !== '') parts.push('分数');
    if (time_limit !== undefined && time_limit !== null && time_limit !== '') parts.push('时间限制');
    if (memory_limit !== undefined && memory_limit !== null && memory_limit !== '') parts.push('内存限制');
  }
  res.json({ message: parts.length > 0 ? parts.join('、') + '已更新。' : '没有需要更新的内容。' });
});

router.get('/:id/solutions', (req, res) => {
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
  res.json(solutions);
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
router.get('/:id/discussions', (req, res) => {
  const { page = 1, size = 20 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const sizeNum = Math.min(50, Math.max(1, parseInt(size) || 20));
  const offset = (pageNum - 1) * sizeNum;
  const problem = db.prepare('SELECT id FROM problems WHERE id = ?').get(req.params.id);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
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
router.post('/:id/plagiarism-check', requireAuth, requireRole('teacher'), (req, res) => {
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

module.exports = router;
