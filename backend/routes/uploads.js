const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const uploadDir = path.join(__dirname, '../../data/uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_STORAGE = 2 * 1024 * 1024 * 1024; // 2GB

// 动态创建 multer 实例，根据用户限制
function createUploadMiddleware(maxFileSize) {
  return multer({
    storage,
    limits: { fileSize: maxFileSize },
    fileFilter: (req, file, cb) => {
      const allowed = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|tar|gz|txt|md|csv|json|xml|cpp|c|py|java|js)$/i;
      if (allowed.test(path.extname(file.originalname))) {
        cb(null, true);
      } else {
        cb(new Error('File type not allowed.'));
      }
    }
  });
}

const upload = multer({
  storage,
  limits: { fileSize: DEFAULT_MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|tar|gz|txt|md|csv|json|xml|cpp|c|py|java|js)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed.'));
    }
  }
});

router.get('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '';
  let params = [];
  if (req.user.role === 'user') {
    where = 'WHERE f.user_id = ?';
    params = [req.user.id];
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM uploaded_files f ${where}`).get(...params).c;
  const files = db.prepare(`
    SELECT f.*, u.username
    FROM uploaded_files f LEFT JOIN users u ON f.user_id = u.id
    ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);
  res.json({ total, page: parseInt(page), limit: parseInt(limit), files });
});

router.post('/', requireAuth, requireRole('teacher'), upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: 'No file uploaded.' });
  }

  // 获取用户自定义限制
  const user = db.prepare('SELECT max_file_size, max_storage FROM users WHERE id = ?').get(req.user.id);
  const maxFileSize = (user?.max_file_size > 0) ? user.max_file_size : DEFAULT_MAX_FILE_SIZE;
  const maxStorage = (user?.max_storage > 0) ? user.max_storage : DEFAULT_MAX_STORAGE;

  // 检查单文件大小限制
  if (req.file.size > maxFileSize) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `单文件大小超过限制 (${(maxFileSize / 1024 / 1024).toFixed(1)}MB)。` });
  }

  // 检查用户总存储限制
  const userSize = db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM uploaded_files WHERE user_id = ?').get(req.user.id).total;
  if (userSize + req.file.size > maxStorage) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: `文件总大小超过限制 (${(maxStorage / 1024 / 1024 / 1024).toFixed(1)}GB)。` });
  }

  db.prepare('INSERT INTO uploaded_files (user_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size
  );
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, original_name: req.file.original_name, size: req.file.size });
});

router.get('/:filename', (req, res) => {
  const filePath = path.join(uploadDir, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'File not found.' });
  }
  res.sendFile(filePath);
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const file = db.prepare('SELECT * FROM uploaded_files WHERE id = ?').get(req.params.id);
  if (!file) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'File not found.' });
  }
  const filePath = path.join(uploadDir, file.filename);
  try { fs.unlinkSync(filePath); } catch {}
  db.prepare('DELETE FROM uploaded_files WHERE id = ?').run(file.id);
  res.json({ message: 'File deleted.' });
});

module.exports = router;
