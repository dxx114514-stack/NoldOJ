const buckets = new Map();

function createRateLimit({ windowMs = 60000, max = 10 } = {}) {
  return (req, res, next) => {
    // 反向代理 (cloudflared 等) 下 req.ip 依赖 trust proxy 设置；
    // 兜底取 X-Forwarded-For 首跳真实 IP，避免所有用户共享同一代理 IP 而共享限流额度
    const clientIp = req.ip ||
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';
    const key = `${clientIp}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ code: 4, reason: 'ERR_SUBMIT_LIMIT_EXCEEDED', message: 'Rate limit exceeded. Please try again later.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 120000) {
      buckets.delete(key);
    }
  }
}, 60000);

module.exports = { createRateLimit };
