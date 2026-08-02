const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const config = require('../config/config');
const { initDB } = require('../database/db');
const db = require('../database/db');

function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS.INFO;

function log(level, tag, ...args) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const prefix = `[${ts()}] [${level}] [${tag}]`;
  console.log(prefix, ...args);
}

function logStartup(tag, msg) { log('INFO', tag, msg); }
function logInfo(tag, msg) { log('INFO', tag, msg); }
function logWarn(tag, msg) { log('WARN', tag, msg); }
function logError(tag, msg) { log('ERROR', tag, msg); }

async function main() {
  logStartup('BOOT', '==========================================');
  logStartup('BOOT', '  WinOJ Server Starting');
  logStartup('BOOT', '==========================================');
  logStartup('BOOT', `Platform: ${os.platform()} ${os.arch()}`);
  logStartup('BOOT', `Node.js: ${process.version}`);
  logStartup('BOOT', `CPU: ${os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} cores)`);
  logStartup('BOOT', `Memory: ${(os.totalmem() / 1024 / 1024).toFixed(0)} MB total`);
  logStartup('BOOT', `Workdir: ${process.cwd()}`);

  logInfo('DB', 'Initializing database...');
  await initDB();
  logInfo('DB', 'Database initialized.');

  const app = express();

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const reqId = Math.random().toString(36).slice(2, 8);
    res.on('finish', () => {
      const diff = Number(process.hrtime.bigint() - start) / 1e6;
      const color = res.statusCode < 300 ? 32 : res.statusCode < 400 ? 33 : res.statusCode < 500 ? 31 : 35;
      const line = `[${reqId}] ${req.method.padEnd(6)} ${req.originalUrl.padEnd(40)} ${String(res.statusCode).padStart(3)} ${diff.toFixed(1)}ms`;
      log('INFO', 'REQ', `\x1b[${color}m${line}\x1b[0m`);
    });
    res.locals.reqId = reqId;
    next();
  });

  // 安全 HTTP 头
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                     "https://cdn.tailwindcss.com",
                     "https://cdnjs.cloudflare.com"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'",
                    "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:', "https://cdnjs.cloudflare.com"],
        objectSrc: ["'none'"],
        frameSrc: ["https://player.bilibili.com"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
  }));

  // CORS 白名单: 仅允许配置的源携带凭据访问
  const allowedOrigins = new Set(config.cors.origins);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '../../frontend')));
  app.use('/uploads', express.static(path.join(__dirname, '../../data/uploads')));

  const authRoutes = require('../routes/auth');
  const problemRoutes = require('../routes/problems');
  const submissionRoutes = require('../routes/submissions');
  const ideRoutes = require('../routes/ide');
  const userRoutes = require('../routes/users');
  const languageRoutes = require('../routes/languages');
  const contestRoutes = require('../routes/contests');
  const articleRoutes = require('../routes/articles');
  const uploadRoutes = require('../routes/uploads');
  const tagRoutes = require('../routes/tags');
  const categoryRoutes = require('../routes/categories');

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/problems', problemRoutes);
  app.use('/api/v1/submissions', submissionRoutes);
  app.use('/api/v1/ide', ideRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/languages', languageRoutes);
  app.use('/api/v1/contests', contestRoutes);
  app.use('/api/v1/articles', articleRoutes);
  app.use('/api/v1/uploads', uploadRoutes);
  app.use('/api/v1/tags', tagRoutes);
  app.use('/api/v1/categories', categoryRoutes);

  const routeList = [
    ['/api/v1/auth', '认证'],
    ['/api/v1/problems', '题目'],
    ['/api/v1/submissions', '提交'],
    ['/api/v1/ide', 'IDE'],
    ['/api/v1/users', '用户'],
    ['/api/v1/languages', '语言'],
    ['/api/v1/contests', '比赛'],
    ['/api/v1/articles', '文章'],
    ['/api/v1/uploads', '上传'],
    ['/api/v1/tags', '标签'],
    ['/api/v1/categories', '分类'],
  ];
  logInfo('ROUTER', `Registered ${routeList.length} route groups:`);
  for (const [path, name] of routeList) {
    logInfo('ROUTER', `  ${path}  (${name})`);
  }

  app.get('/api/v1/stats', (req, res) => {
    const problems = db.prepare('SELECT COUNT(*) as c FROM problems WHERE is_public = 1').get().c;
    const submissions = db.prepare('SELECT COUNT(*) as c FROM submissions').get().c;
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const languages = db.prepare('SELECT COUNT(*) as c FROM languages WHERE is_enabled = 1').get().c;
    logInfo('STATS', `Problems: ${problems}, Submissions: ${submissions}, Users: ${users}, Languages: ${languages}`);
    res.json({ problems, submissions, users, languages });
  });

  app.get('/api/v1/jobs', (req, res) => res.redirect('/api/v1/submissions'));
  app.get('/api/v1/jobs/:id', (req, res) => res.redirect(`/api/v1/submissions/${req.params.id}`));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'API endpoint not found.' });
    }
    res.sendFile(path.join(__dirname, '../../frontend/pages/index.html'));
  });

  app.use((err, req, res, next) => {
    const reqId = res.locals.reqId || 'unknown';
    logError('ERROR', `[${reqId}] ${req.method} ${req.originalUrl} => ${err.message}`);
    logError('ERROR', err.stack || err);
    res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Internal server error.' });
  });

  logInfo('CONFIG', `Port: ${config.port}`);
  logInfo('CONFIG', `DB: ${config.database.path}`);
  logInfo('CONFIG', `AI Review: ${config.security.enabled ? 'ON' : 'OFF'} (${config.security.model} @ ${config.security.url})`);
  logInfo('CONFIG', `Email: ${config.email.enabled ? 'ON' : 'OFF'} (${config.email.from})`);
  logInfo('CONFIG', `Captcha: ${config.captcha.enabled ? 'ON' : 'OFF'}`);
  logInfo('CONFIG', `JWT Access TTL: ${config.jwt.accessExpiry}, Refresh TTL: ${config.jwt.refreshExpiry}`);
  logInfo('CONFIG', `Sandbox Temp: ${config.sandbox.tempDir}`);

  const server = http.createServer(app);
  server.listen(config.port, () => {
    logStartup('READY', `==========================================`);
    logStartup('READY', `  WinOJ Server is READY`);
    logStartup('READY', `  URL: http://localhost:${config.port}`);
    logStartup('READY', `  Admin: admin / admin123`);
    logStartup('READY', `==========================================`);
  });

  setInterval(() => {
    const mem = process.memoryUsage();
    log('DEBUG', 'MEM', `RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
  }, 60 * 1000);

  process.on('SIGINT', () => {
    logWarn('SHUTDOWN', 'Received SIGINT, shutting down...');
    server.close(() => {
      logInfo('SHUTDOWN', 'Server closed.');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    logWarn('SHUTDOWN', 'Received SIGTERM, shutting down...');
    server.close(() => {
      logInfo('SHUTDOWN', 'Server closed.');
      process.exit(0);
    });
  });

  process.on('uncaughtException', (err) => {
    logError('FATAL', `Uncaught exception: ${err.message}`);
    logError('FATAL', err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    logError('FATAL', `Unhandled rejection: ${reason}`);
  });
}

main().catch(err => {
  console.error(`[${ts()}] [ERROR] [BOOT] Failed to start server:`, err);
  process.exit(1);
});