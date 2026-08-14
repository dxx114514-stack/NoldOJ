const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
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

// 日志脱敏逻辑集中到 utils/securityHelpers.js，各路由共享
const { sanitizeLog } = require('../utils/securityHelpers');

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

  // 反向代理（cloudflared 等本地隧道）情况下信任最近一跳，使 req.ip 取到真实客户端 IP
  // 仅信任 1 跳，避免伪造 X-Forwarded-For 劫持限流
  app.set('trust proxy', 1);

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

  // 安全 HTTP 头: 每请求生成唯一 nonce 供 CSP 使用, 摆脱 scriptSrc unsafe-inline
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (req, res) => `'nonce-${res.locals.cspNonce}'`,
          "https://cdn.tailwindcss.com",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net"
        ],
        // 仅允许非内联事件属性，脚本本身一律走 self/CDN + nonce
        styleSrc: ["'self'", "'unsafe-inline'",
                    "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:', "https://cdnjs.cloudflare.com"],
        objectSrc: ["'none'"],
        // 允许 https 嵌入（bilibili 视频 / @[url] 嵌入），禁止 http 明文 iframe/媒体
        frameSrc: ["'self'", "https:"],
        mediaSrc: ["'self'", "https:"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
  }));

  // CORS 白名单: 仅允许配置的源携带凭据访问
  const allowedOrigins = new Set(config.cors.origins);
  // 无 Origin 的写请求若携带凭据直接拒绝, 阻断 DNS rebinding / 无源 CSRF。
  // 同源浏览器导航与 curl 裸调 GET/HEAD/OPTIONS 不受影响。
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const hasCreds = !!(req.headers.cookie || /^Bearer\b/i.test(req.headers.authorization || ''));
    if (!origin && hasCreds && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({ code: 4, reason: 'ERR_FORBIDDEN', message: 'Origin header is required for credentialed requests.' });
    }
    next();
  });
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

  // 静态资源仅暴露安全子目录，避免整个前端目录被遍历
  const frontendRoot = path.join(__dirname, '../../frontend');
  const pagesRoot = path.join(frontendRoot, 'pages');
  app.use('/css', express.static(path.join(frontendRoot, 'css'), { dotfiles: 'deny' }));
  app.use('/js', express.static(path.join(frontendRoot, 'js'), { dotfiles: 'deny' }));
  app.use('/img', express.static(path.join(frontendRoot, 'img'), { dotfiles: 'deny' }));
  // HTML 页面经 nonce 注入中间件，使 CSP 无需 unsafe-inline 即可执行内联脚本；
  // 其余静态资源（css/js/img 外的）回退到 express.static。
  app.use((req, res, next) => {
    let rel = null;
    if (req.path === '/') rel = 'index.html';
    else if (req.path.endsWith('.html')) rel = req.path.replace(/^\/pages\//, '').replace(/^\//, '');
    if (!rel || /\.\.|\\/.test(rel)) return next();
    fs.readFile(path.join(pagesRoot, rel), 'utf8', (err, html) => {
      if (err) return next();
      const nonce = res.locals.cspNonce;
      // 仅给内联 <script>（无 src 属性）注入 nonce
      const out = html.replace(/<script(?![^>]*\bsrc\s*=)[^>]*>/gi, (tag) => {
        return tag.replace(/<script/i, `<script nonce="${nonce}"`);
      });
      res.type('html').send(out);
    });
  });
  app.use(express.static(pagesRoot, { dotfiles: 'deny' }));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(frontendRoot, 'favicon.svg')));

  // 安全公告文件 (RFC 9116)
  const securityContact = config.security?.contact || 'https://github.com'; 
  const securityTxt = `Contact: ${securityContact}\nPreferred-Languages: zh\nCanonical: /security.txt\n`;
  app.get('/security.txt', (req, res) => { res.type('text/plain'); res.send(securityTxt); });
  app.get('/.well-known/security.txt', (req, res) => { res.type('text/plain'); res.send(securityTxt); });

  // 健康检查端点: 前端旧逻辑直接 GET /output.txt 探测服务是否在线，
  // 除以明确 404 防止根目录同名文件被当作被测数据外，还提供专用探针。
  app.get('/api/v1/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get('/output.txt', (req, res) => res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'Use /api/v1/health instead.' }));

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
  const announcementRoutes = require('../routes/announcements');
  const problemSetRoutes = require('../routes/problem-sets');
  const discussionRoutes = require('../routes/discussions');
  const { router: virtualContestRoutes } = require('../routes/virtual-contests');
  const plagiarismRoutes = require('../routes/plagiarism');

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
  app.use('/api/v1/announcements', announcementRoutes);
  app.use('/api/v1/problem-sets', problemSetRoutes);
  app.use('/api/v1/discussions', discussionRoutes);
  app.use('/api/v1/virtual-contests', virtualContestRoutes);
  app.use('/api/v1/plagiarism', plagiarismRoutes);

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
    ['/api/v1/announcements', '公告'],
    ['/api/v1/problem-sets', '题单'],
    ['/api/v1/discussions', '讨论'],
    ['/api/v1/virtual-contests', '虚拟比赛'],
    ['/api/v1/plagiarism', '查重'],
  ];
  logInfo('ROUTER', `Registered ${routeList.length} route groups:`);
  for (const [path, name] of routeList) {
    logInfo('ROUTER', `  ${path}  (${name})`);
  }

  // /api/v1/stats 首页高频接口: 30s TTL 短时缓存
  let statsCache = null;
  let statsCacheAt = 0;
  app.get('/api/v1/stats', (req, res) => {
    const now = Date.now();
    if (statsCache && now - statsCacheAt < 30000) {
      return res.json(statsCache);
    }
    const problems = db.prepare('SELECT COUNT(*) as c FROM problems WHERE is_public = 1 AND is_hidden = 0').get().c;
    const submissions = db.prepare('SELECT COUNT(*) as c FROM submissions').get().c;
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const languages = db.prepare('SELECT COUNT(*) as c FROM languages WHERE is_enabled = 1').get().c;
    statsCache = { problems, submissions, users, languages };
    statsCacheAt = now;
    logInfo('STATS', `Problems: ${problems}, Submissions: ${submissions}, Users: ${users}, Languages: ${languages}`);
    res.json(statsCache);
  });

  app.get('/api/v1/jobs', (req, res) => res.redirect('/api/v1/submissions'));
  app.get('/api/v1/jobs/:id', (req, res) => res.redirect(`/api/v1/submissions/${req.params.id}`));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'API endpoint not found.' });
    }
    fs.readFile(path.join(pagesRoot, 'index.html'), 'utf8', (err, html) => {
      if (err) return res.status(404).send('Not found');
      const nonce = res.locals.cspNonce;
      const out = html.replace(/<script(?![^>]*\bsrc\s*=)[^>]*>/gi, (tag) => {
        return tag.replace(/<script/i, `<script nonce="${nonce}"`);
      });
      res.type('html').send(out);
    });
  });

  app.use((err, req, res, next) => {
    const reqId = res.locals.reqId || 'unknown';
    const msg = sanitizeLog(String(err.message || err));
    const stack = sanitizeLog(String(err.stack || err));
    logError('ERROR', `[${reqId}] ${req.method} ${sanitizeLog(req.originalUrl || '')} => ${msg}`);
    logError('ERROR', stack);
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
  // 初始化 Socket.io 实时推送
  const { initSocket } = require('../services/socket');
  initSocket(server);

  server.listen(config.port, () => {
    logStartup('READY', `==========================================`);
    logStartup('READY', `  WinOJ Server is READY`);
    logStartup('READY', `  URL: http://localhost:${config.port}`);
    logStartup('READY', `  初始管理员密码在数据库首次初始化时已显示，请勿在日志中明文记录凭据`);
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
    logError('FATAL', `Uncaught exception: ${sanitizeLog(String(err && err.message))}`);
    logError('FATAL', sanitizeLog(String(err && err.stack)));
  });

  process.on('unhandledRejection', (reason) => {
    logError('FATAL', `Unhandled rejection: ${sanitizeLog(String(reason))}`);
  });
}

main().catch(err => {
  console.error(`[${ts()}] [ERROR] [BOOT] Failed to start server:`, sanitizeLog(String(err && err.stack || err)));
  process.exit(1);
});