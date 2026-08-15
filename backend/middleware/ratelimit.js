const buckets = new Map();
const MAX_BUCKETS = 10000; // 容量上限，防止伪造 IP 头耗尽内存

// 仅当显式启用 TRUST_PROXY 时才信任 X-Forwarded-For（由 server.js 注入），
// 否则一律以 socket 地址为限流键，杜绝客户端自造 XFF 绕过限流。
let trustProxy = false;
function setTrustProxy(v) {
  trustProxy = !!v;
}

function createRateLimit({ windowMs = 60000, max = 10, key } = {}) {
  return (req, res, next) => {
    // 反向代理 (cloudflared 等) 下 req.ip 依赖 trust proxy 设置；
    // 仅当显式配置了 trust proxy 时采用 XFF 首跳，否则用 socket 地址。
    let clientIp = req.ip;
    if (!clientIp && trustProxy) {
      clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    }
    clientIp = clientIp || req.socket?.remoteAddress || 'unknown';
    const keySuffix = typeof key === 'function' ? key(req) : '';
    const bucketKey = `${clientIp}:${req.baseUrl}${req.path}:${keySuffix}`;
    const now = Date.now();
    let bucket = buckets.get(bucketKey);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ code: 4, reason: 'ERR_SUBMIT_LIMIT_EXCEEDED', message: 'Rate limit exceeded. Please try again later.' });
    }
    // 超出容量时按最旧优先淘汰，保证内存有界
    if (buckets.size > MAX_BUCKETS) {
      let oldestKey = null;
      let oldestStart = Infinity;
      for (const [k, b] of buckets) {
        if (b.windowStart < oldestStart) {
          oldestStart = b.windowStart;
          oldestKey = k;
        }
      }
      if (oldestKey) buckets.delete(oldestKey);
    }
    next();
  };
}

// unref: 定时清理器不阻止进程退出（测试场景 node --test 可正常结束；
// 生产为长生命周期进程，unref 不影响定时清理执行）。
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 120000) {
      buckets.delete(key);
    }
  }
}, 60000);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { createRateLimit, setTrustProxy };
