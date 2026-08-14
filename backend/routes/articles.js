const express = require('express');
const db = require('../database/db');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const { parsePageLimit } = require('../utils/pagination');
const { isStaff, isAdminOrSu } = require('../utils/roles');
const { buildUpdates } = require('../utils/db');

const router = express.Router();

router.get('/', optionalAuth, (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const { page: pageNum, limit: limitNum, offset } = parsePageLimit(page, limit, 20, 100);
  let where = '';
  let params = [];
  if (!req.user || !isStaff(req.user.role)) {
    where = 'WHERE a.is_published = 1 AND a.is_hidden = 0';
  }
  if (search) {
    const fuzzy = '%' + search.replace(/\s+/g, '') + '%';
    where += where ? ' AND ' : 'WHERE ';
    where += '(REPLACE(a.title, \' \', \'\') LIKE ? OR REPLACE(IFNULL(a.provider, \'\'), \' \', \'\') LIKE ?)';
    params.push(fuzzy, fuzzy);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM articles a ${where}`).get(...params).c;
  const articles = db.prepare(`
    SELECT a.id, a.title, a.author_id, a.provider, a.is_published, a.is_hidden, a.created_at, a.updated_at,
           u.username, u.nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, articles });
});

router.get('/:id', optionalAuth, (req, res) => {
  const article = db.prepare(`
    SELECT a.*, u.username, u.nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  const staff = !!req.user && isStaff(req.user.role);
  // 隐藏文章: 仅作者或管理角色可见
  if (article.is_hidden && !(staff || (req.user && req.user.id === article.author_id))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Article not found.' });
  }
  if (!article.is_published && (!req.user || (req.user.id !== article.author_id && !staff))) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Article is not published.' });
  }
  res.json(article);
});

router.post('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { title, content, provider, is_published, is_hidden } = req.body;
  if (!title) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'Title is required.' });
  }
  const result = db.prepare('INSERT INTO articles (title, content, author_id, provider, is_published, is_hidden) VALUES (?, ?, ?, ?, ?, ?)').run(
    title, content || '', req.user.id, provider || '', is_published ? 1 : 0, is_hidden ? 1 : 0
  );
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(article);
});

router.put('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  if (req.user.id !== article.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot edit other users\' articles.' });
  }
  const { title, content, provider, is_published, is_hidden } = req.body;
  const u = buildUpdates([
    { key: 'title', value: title },
    { key: 'content', value: content },
    { key: 'provider', value: provider },
    { key: 'is_published', value: is_published, transform: v => v ? 1 : 0 },
    { key: 'is_hidden', value: is_hidden, transform: v => v ? 1 : 0 }
  ], { touchUpdatedAt: true });
  if (u.count === 0) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No fields to update.' });
  }
  db.prepare(`UPDATE articles SET ${u.clause} WHERE id = ?`).run(...u.values, article.id);
  const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(article.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, requireRole('teacher'), (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Article not found.' });
  }
  if (req.user.id !== article.author_id && !isAdminOrSu(req.user.role)) {
    return res.status(403).json({ code: 6, reason: 'ERR_FORBIDDEN', message: 'Cannot delete other users\' articles.' });
  }
  db.prepare('DELETE FROM problem_solutions WHERE article_id = ?').run(article.id);
  db.prepare('DELETE FROM articles WHERE id = ?').run(article.id);
  res.json({ message: 'Article deleted.' });
});

module.exports = router;
