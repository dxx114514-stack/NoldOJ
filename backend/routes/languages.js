const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  // 公开接口只暴露非敏感字段，不泄露 compile_cmd/run_cmd
  const languages = db.prepare('SELECT id, name, display_name, extension, is_enabled FROM languages ORDER BY id').all();
  res.json(languages);
});

router.post('/', requireAuth, requireRole('su'), (req, res) => {
  const { name, display_name, compile_cmd, run_cmd, extension } = req.body;
  if (!name || !display_name || !run_cmd || !extension) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'name, display_name, run_cmd, and extension are required.' });
  }
  const existing = db.prepare('SELECT id FROM languages WHERE name = ?').get(name);
  if (existing) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Language already exists.' });
  }
  const result = db.prepare('INSERT INTO languages (name, display_name, compile_cmd, run_cmd, extension) VALUES (?, ?, ?, ?, ?)').run(name, display_name, compile_cmd || '', run_cmd, extension);
  const lang = db.prepare('SELECT * FROM languages WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(lang);
});

router.put('/:id', requireAuth, requireRole('su'), (req, res) => {
  const lang = db.prepare('SELECT * FROM languages WHERE id = ?').get(req.params.id);
  if (!lang) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Language not found.' });
  }
  const { name, display_name, compile_cmd, run_cmd, extension, is_enabled } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
  if (compile_cmd !== undefined) { updates.push('compile_cmd = ?'); values.push(compile_cmd); }
  if (run_cmd !== undefined) { updates.push('run_cmd = ?'); values.push(run_cmd); }
  if (extension !== undefined) { updates.push('extension = ?'); values.push(extension); }
  if (is_enabled !== undefined) { updates.push('is_enabled = ?'); values.push(is_enabled ? 1 : 0); }

  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  values.push(lang.id);
  db.prepare(`UPDATE languages SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM languages WHERE id = ?').get(lang.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('su'), (req, res) => {
  const lang = db.prepare('SELECT * FROM languages WHERE id = ?').get(req.params.id);
  if (!lang) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Language not found.' });
  }
  db.prepare('DELETE FROM languages WHERE id = ?').run(lang.id);
  res.json({ message: 'Language deleted.' });
});

module.exports = router;
