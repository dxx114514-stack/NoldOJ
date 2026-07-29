const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '';
  let params = [];
  if (!req.user || !['teacher', 'admin', 'su'].includes(req.user.role)) {
    where = 'WHERE a.is_published = 1';
  }
  if (search) {
    const fuzzy = '%' + search.replace(/\s+/g, '') + '%';
    where += where ? ' AND ' : 'WHERE ';
    where += '(REPLACE(a.title, \' \', \'\') LIKE ? OR REPLACE(IFNULL(a.provider, \'\'), \' \', \'\') LIKE ?)';
    params.push(fuzzy, fuzzy);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM articles a ${where}`).get(...params).c;
  const articles = db.prepare(`
    SELECT a.id, a.title, a.author_id, a.provider, a.is_published, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);
  res.json({ total, page: parseInt(page), limit: parseInt(limit), articles });
});

router.get('/:id', (req, res) => {
  const article = db.prepare(`
    SELECT a.*, u.username, u.nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  if (!article.is_published && (!req.user || (req.user.id !== article.author_id && !['teacher', 'admin', 'su'].includes(req.user.role)))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Article is not published.' });
  }
  res.json(article);
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, content, provider, is_published } = req.body;
  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  const result = db.prepare('INSERT INTO articles (title, content, author_id, provider, is_published) VALUES (?, ?, ?, ?, ?)').run(
    title, content || '', req.user.id, provider || '', is_published ? 1 : 0
  );
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(article);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  if (req.user.id !== article.author_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit other users\' articles.' });
  }
  const { title, content, provider, is_published } = req.body;
  const updates = [];
  const values = [];
  if (title !== undefined) { updates.push('title = ?'); values.push(title); }
  if (content !== undefined) { updates.push('content = ?'); values.push(content); }
  if (provider !== undefined) { updates.push('provider = ?'); values.push(provider); }
  if (is_published !== undefined) { updates.push('is_published = ?'); values.push(is_published ? 1 : 0); }
  if (updates.length === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  updates.push("updated_at = datetime('now')");
  values.push(article.id);
  db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(article.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  if (req.user.id !== article.author_id && !['admin', 'su'].includes(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete other users\' articles.' });
  }
  db.prepare('DELETE FROM problem_solutions WHERE article_id = ?').run(article.id);
  db.prepare('DELETE FROM articles WHERE id = ?').run(article.id);
  res.json({ message: 'Article deleted.' });
});

module.exports = router;
