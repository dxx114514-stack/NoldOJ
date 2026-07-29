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
  const { page = 1, limit = 50, search = '', tag = '', category = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE p.is_public = 1';
  const params = [];
  
  if (search) {
    const fuzzy = '%' + search.replace(/\s+/g, '') + '%';
    where += ` AND (REPLACE(p.title, ' ', '') LIKE ? OR REPLACE(p.description, ' ', '') LIKE ? OR REPLACE(IFNULL(p.provider, ''), ' ', '') LIKE ?)`;
    params.push(fuzzy, fuzzy, fuzzy);
  }
  
  if (tag) {
    where += ' AND p.id IN (SELECT pt.problem_id FROM problem_tags pt JOIN tags t ON pt.tag_id = t.id WHERE t.name = ?)';
    params.push(tag);
  }

  if (category) {
    where += ' AND p.id IN (SELECT pc.problem_id FROM problem_categories pc JOIN categories c ON pc.category_id = c.id WHERE c.name = ?)';
    params.push(category);
  }
  
  const total = db.prepare(`SELECT COUNT(*) as c FROM problems p ${where}`).get(...params).c;
  const problems = db.prepare(`SELECT p.id, p.title, p.problem_type, p.time_limit, p.memory_limit, p.is_public, p.created_at FROM problems p ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);

  for (const problem of problems) {
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
  const { title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, sample_input, sample_output, subtask_mode } = req.body;
  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  const newId = db.findNextId('problems');
  db.prepare(`INSERT INTO problems (id, title, description, input_desc, output_desc, hint, time_limit, memory_limit, problem_type, compare_mode, real_number_tolerance, spj_code, allowed_languages, is_public, provider, created_by, sample_input, sample_output, subtask_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
    subtask_mode || 'simple'
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

  const fields = ['title', 'description', 'input_desc', 'output_desc', 'hint', 'time_limit', 'memory_limit', 'problem_type', 'compare_mode', 'real_number_tolerance', 'spj_code', 'allowed_languages', 'is_public', 'provider', 'sample_input', 'sample_output', 'subtask_mode'];
  const updates = [];
  const values = [];
  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      if (field === 'real_number_tolerance' || field === 'allowed_languages') {
        values.push(JSON.stringify(req.body[field]));
      } else if (field === 'is_public') {
        values.push(req.body[field] ? 1 : 0);
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
  const testCases = db.prepare('SELECT * FROM test_cases WHERE problem_id = ? ORDER BY sort_order, id').all(problem.id);
  const result = testCases.map(tc => ({
    id: tc.id,
    input_data: tc.input_data || '',
    output_data: tc.output_data || '',
    input_file: tc.input_file ? path.basename(tc.input_file) : '',
    output_file: tc.output_file ? path.basename(tc.output_file) : '',
    score: tc.score,
    sort_order: tc.sort_order
  }));
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
    db.prepare('INSERT INTO test_cases (problem_id, input_data, output_data, score, sort_order) VALUES (?, ?, ?, ?, ?)').run(
      problem.id, tc.input_data || '', tc.output_data || '', tc.score || 0, order
    );
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
  const { input_data, output_data, score, group_id, sort_order } = req.body;
  const updates = [];
  const values = [];
  if (input_data !== undefined) { updates.push('input_data = ?'); values.push(input_data); }
  if (output_data !== undefined) { updates.push('output_data = ?'); values.push(output_data); }
  if (score !== undefined) { updates.push('score = ?'); values.push(score); }
  if (group_id !== undefined) { updates.push('group_id = ?'); values.push(group_id || null); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
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

module.exports = router;
