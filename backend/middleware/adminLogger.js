const fs = require('fs');
const path = require('path');

function getLogPath() {
  const logDir = process.env.OJ_LOG_DIR;
  if (logDir) return path.join(logDir, 'admin.log');
  return path.join(__dirname, '..', '..', 'log', 'admin.log');
}

function logAdminAction(req, action) {
  const user = req.user;
  if (!user || !['admin', 'su'].includes(user.role)) return;

  const now = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const username = user.username || user.id;
  const role = user.role;
  const method = req.method;
  const url = req.originalUrl || req.url;

  let bodyStr = '';
  if (req.body && Object.keys(req.body).length > 0) {
    try {
      const safe = { ...req.body };
      delete safe.password;
      delete safe.password_hash;
      delete safe.token;
      bodyStr = ' body=' + JSON.stringify(safe).slice(0, 500);
    } catch {}
  }

  const line = `[${now}] [${role}] ${username} ${method} ${url} ip=${ip}${bodyStr}${action ? ' ' + action : ''}\n`;

  try {
    const logPath = getLogPath();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {}
}

function adminLogger(req, res, next) {
  if (!req.user || !['admin', 'su'].includes(req.user.role)) return next();

  const originalJson = res.json.bind(res);
  res.json = function (data) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      logAdminAction(req);
    }
    return originalJson(data);
  };

  next();
}

module.exports = { adminLogger, logAdminAction };
