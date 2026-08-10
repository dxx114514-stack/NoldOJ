const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  const tags = db.prepare('SELECT * FROM tags ORDER BY name').all();
  const countStmt = db.prepare('SELECT COUNT(*) as c FROM problem_tags WHERE tag_id = ?');
  for (const tag of tags) {
    tag.problem_count = countStmt.get(tag.id).c;
  }
  res.json(tags);
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Tag name is required.' });
  }
  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name.trim());
  if (existing) {
    return res.status(409).json({ code: 2, reason: 'ERR_CONFLICT', message: 'Tag already exists.' });
  }
  const result = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name.trim(), color || '#6366f1');
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(tag);
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Tag not found.' });
  }
  db.prepare('DELETE FROM problem_tags WHERE tag_id = ?').run(tag.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
  res.json({ message: 'Tag deleted.' });
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Tag not found.' });
  }
  const { name, color } = req.body;
  if (name !== undefined) {
    const existing = db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(name.trim(), tag.id);
    if (existing) {
      return res.status(409).json({ code: 2, reason: 'ERR_CONFLICT', message: 'Tag name already exists.' });
    }
  }
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
  if (color !== undefined) { updates.push('color = ?'); values.push(color); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(tag.id);
  db.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);
  res.json(updated);
});

router.post('/problem/:problemId', requireAuth, requireRole('teacher'), (req, res) => {
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.problemId);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  const { tag_ids } = req.body;
  if (!Array.isArray(tag_ids)) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'tag_ids array is required.' });
  }
  db.prepare('DELETE FROM problem_tags WHERE problem_id = ?').run(problem.id);
  const insert = db.prepare('INSERT INTO problem_tags (problem_id, tag_id) VALUES (?, ?)');
  for (const tagId of tag_ids) {
    const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
    if (tag) {
      insert.run(problem.id, tagId);
    }
  }
  res.json({ message: 'Tags updated.' });
});

router.get('/problem/:problemId', (req, res) => {
  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN problem_tags pt ON t.id = pt.tag_id
    WHERE pt.problem_id = ?
    ORDER BY t.name
  `).all(req.params.problemId);
  res.json(tags);
});

router.get('/:id', (req, res) => {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Tag not found.' });
  }
  res.json(tag);
});

module.exports = router;