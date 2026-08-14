// 共享安全工具: 日志脱敏 + 审计日志
const crypto = require('crypto');

// 日志脱敏: 屏蔽 JWT、Authorization、密码、token 等潜在敏感数据
const SENSITIVE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,   // JWT
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,                           // Authorization Bearer
  /(password\s*[=:]\s*)[^\s,;&]+/gi,                        // password=xxx
  /(token\s*[=:]\s*)[^\s,;&]+/gi,                           // token=xxx
  /(api[_-]?key\s*[=:]\s*)[^\s,;&]+/gi                      // api key
];

function sanitizeLog(text) {
  if (!text) return text;
  let out = String(text);
  for (const re of SENSITIVE_PATTERNS) out = out.replace(re, '$1[REDACTED]');
  return out;
}

// 生成 HMAC 校验码（供验证码等短值使用，防彩虹表）
function hmacDigest(value, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

module.exports = { sanitizeLog, hmacDigest };