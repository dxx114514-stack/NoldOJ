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
      // 脱敏：change-password / reset-password 的明文口令、验证码、令牌等不得落盘。
      // 原先只 delete 了三个固定字段，new_password / old_password 会原样写进 admin.log。
      const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|credential|authorization|verify_?code|email_?code|otp|^code$)/i;
      const safe = {};
      for (const [k, v] of Object.entries(req.body)) {
        safe[k] = SENSITIVE_KEY.test(k) ? '***' : v;
      }
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
  // req.user 由路由级 requireAuth/optionalAuth 赋值，本中间件挂在路由之前，
  // 此刻必然是 undefined —— 原先在这里判断角色会导致包装永不生效、admin.log 恒空。
  // 改为无条件包一层 res.json，真正取用 req.user 的时机是路由处理完、
  // 即将响应时，那时鉴权已经完成。
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
