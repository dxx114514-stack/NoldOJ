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

// 允许的扩展名白名单（移除 svg: SVG 可内嵌 <script>，触发存储型 XSS）
const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|pdf|zip|tar|gz|txt|md|csv|json|xml|cpp|c|py|java|js)$/i;

// 文件头 magic bytes 校验: 防止伪装扩展名
const MAGIC_BYTES = {
  jpg:  [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }],
  jpeg: [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }],
  png:  [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47] }],
  gif:  [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  webp: [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }],
  pdf:  [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }],
  zip:  [{ offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04] }, { offset: 0, bytes: [0x50, 0x4B, 0x05, 0x06] }, { offset: 0, bytes: [0x50, 0x4B, 0x07, 0x08] }],
  gz:   [{ offset: 0, bytes: [0x1F, 0x8B] }]
};

function verifyMagicBytes(filePath, ext) {
  const key = ext.replace(/^\./, '').toLowerCase();
  const rules = MAGIC_BYTES[key];
  if (!rules) return true; // 纯文本类无 magic bytes，跳过
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    for (const rule of rules) {
      const buf = Buffer.alloc(rule.bytes.length);
      fs.readSync(fd, buf, 0, rule.bytes.length, rule.offset);
      const ok = buf.every((b, i) => b === rule.bytes[i]);
      if (ok) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// 动态创建 multer 实例，根据用户限制
function createUploadMiddleware(maxFileSize) {
  return multer({
    storage,
    limits: { fileSize: maxFileSize },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_EXT.test(path.extname(file.originalname))) {
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
    if (ALLOWED_EXT.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed.'));
    }
  }
});

router.get('/', requireAuth, requireRole('teacher'), (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum - 1) * limitNum;
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
  `).all(...params, limitNum, offset);
  res.json({ total, page: pageNum, limit: limitNum, files });
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

  // magic bytes 校验: 防止伪装扩展名上传可执行文件
  const ext = path.extname(req.file.originalname);
  if (!verifyMagicBytes(req.file.path, ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ code: 1, reason: 'ERR_INVALID_ARGUMENT', message: '文件内容与扩展名不匹配，疑似伪装文件。' });
  }

  db.prepare('INSERT INTO uploaded_files (user_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size
  );
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, original_name: req.file.originalname, size: req.file.size });
});

// 路径安全校验: 防止路径遍历
function safePath(filename) {
  const resolved = path.resolve(uploadDir, filename);
  if (resolved !== uploadDir && !resolved.startsWith(uploadDir + path.sep)) return null;
  return resolved;
}

router.get('/:filename', requireAuth, (req, res) => {
  const filePath = safePath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'File not found.' });
  }
  // 强制下载，避免浏览器内联渲染（如 HTML/SVG 触发 XSS）；
  // filename 转义引号，防止响应头注入
  const downName = String(path.basename(req.params.filename)).replace(/["\\\r\n]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${downName}"`);
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
