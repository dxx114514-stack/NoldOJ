const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
  for (const cat of categories) {
    const count = db.prepare('SELECT COUNT(*) as c FROM problem_categories WHERE category_id = ?').get(cat.id).c;
    cat.problem_count = count;
  }
  res.json(categories);
});

router.get('/:id', (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Category not found.' });
  }
  res.json(category);
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { name, description, sort_order } = req.body;
  if (!name) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Name is required.' });
  }
  const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
  if (existing) {
    return res.status(400).json({ code: 2, reason: 'ERR_DUPLICATE', message: 'Category name already exists.' });
  }
  const result = db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)').run(
    name, description || '', sort_order || 0
  );
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(category);
});

router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Category not found.' });
  }
  const { name, description, sort_order } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(category.id);
  db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(category.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Category not found.' });
  }
  db.prepare('DELETE FROM problem_categories WHERE category_id = ?').run(category.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
  res.json({ message: 'Category deleted.' });
});

router.post('/:id/problems/:pid', requireAuth, requireRole('teacher'), (req, res) => {
  const { id: categoryId, pid: problemId } = req.params;
  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!category) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Category not found.' });
  }
  const problem = db.prepare('SELECT id FROM problems WHERE id = ?').get(problemId);
  if (!problem) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Problem not found.' });
  }
  db.prepare('INSERT OR IGNORE INTO problem_categories (problem_id, category_id) VALUES (?, ?)').run(problemId, categoryId);
  res.json({ message: 'Problem added to category.' });
});

router.delete('/:id/problems/:pid', requireAuth, requireRole('teacher'), (req, res) => {
  const { id: categoryId, pid: problemId } = req.params;
  db.prepare('DELETE FROM problem_categories WHERE problem_id = ? AND category_id = ?').run(problemId, categoryId);
  res.json({ message: 'Problem removed from category.' });
});

module.exports = router;