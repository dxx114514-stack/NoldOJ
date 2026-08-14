const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

function loadEmailConfig() {
  const emailPath = path.join(__dirname, '..', '..', 'config', 'email.txt');
  const result = { enabled: false, apiKey: '', from: 'onboarding@resend.dev' };
  try {
    const content = fs.readFileSync(emailPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('RESEND_API_KEY=')) result.apiKey = trimmed.split('=').slice(1).join('=');
      if (trimmed.startsWith('EMAIL_FROM=')) result.from = trimmed.split('=').slice(1).join('=');
      if (trimmed.startsWith('EMAIL_ENABLED=')) result.enabled = trimmed.split('=')[1] === 'true';
    }
    if (result.apiKey && result.apiKey !== 're_xxxxxxxxx') result.enabled = true;
  } catch {}
  return result;
}

const email = loadEmailConfig();

function loadAiConfig() {
  const aiPath = path.join(__dirname, '..', '..', 'config', 'ai.txt');
  const result = { enabled: false, url: 'http://localhost:11434/api/chat', model: 'qwen3:1.7b', key: '', codeLengthLimit: 131072 };
  try {
    const content = fs.readFileSync(aiPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('AI_ENABLED=')) result.enabled = trimmed.split('=')[1] === 'true';
      if (trimmed.startsWith('URL=')) result.url = trimmed.split('=').slice(1).join('=');
      if (trimmed.startsWith('MODEL=')) result.model = trimmed.split('=').slice(1).join('=');
      if (trimmed.startsWith('KEY=')) result.key = trimmed.split('=').slice(1).join('=');
      if (trimmed.startsWith('CODE_LENGTH_LIMIT=')) result.codeLengthLimit = parseInt(trimmed.split('=')[1], 10) || 131072;
    }
  } catch {}
  return result;
}

const ai = loadAiConfig();

// ── 验证码开关: 从 config/captcha.txt 读取，默认开启 ──
function loadCaptchaConfig() {
  const result = { enabled: true };
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'captcha.txt');
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('CAPTCHA_ENABLED=')) result.enabled = t.split('=')[1].trim() === 'true';
    }
  } catch {}
  return result;
}

const captchaCfg = loadCaptchaConfig();

// ── 判题并发: config/judge.txt 的 MAX_THREADS= 或环境变量 WINOJ_JUDGE_THREADS，
//    默认 (CPU 数 + 1) / 2，最小 1 ──
function loadJudgeConfig() {
  const cpu = Math.max(1, (os.cpus() || []).length || 1);
  let maxThreads = Math.max(1, Math.floor((cpu + 1) / 2));
  const envVal = parseInt(process.env.WINOJ_JUDGE_THREADS, 10);
  if (envVal && envVal > 0) maxThreads = envVal;
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'judge.txt');
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('MAX_THREADS=')) {
        const v = parseInt(t.split('=')[1], 10);
        if (v && v > 0) maxThreads = v;
      }
    }
  } catch {}
  return { maxThreads };
}

const judgeCfg = loadJudgeConfig();

// ── JWT 密钥: 从 config/jwt.txt 读取，首次启动自动生成强随机密钥 ──
function loadJwtConfig() {
  const jwtPath = path.join(__dirname, '..', '..', 'config', 'jwt.txt');
  const read = () => {
    const content = fs.readFileSync(jwtPath, 'utf8');
    const obj = { accessSecret: '', refreshSecret: '' };
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('JWT_ACCESS_SECRET=')) obj.accessSecret = t.split('=').slice(1).join('=').trim();
      if (t.startsWith('JWT_REFRESH_SECRET=')) obj.refreshSecret = t.split('=').slice(1).join('=').trim();
    }
    return obj;
  };
  try {
    const obj = read();
    if (obj.accessSecret && obj.refreshSecret) return obj;
  } catch {}
  // 首次启动: 生成 64 字节强随机密钥并写入文件
  const generated = {
    accessSecret: crypto.randomBytes(64).toString('hex'),
    refreshSecret: crypto.randomBytes(64).toString('hex')
  };
  const fileContent =
    `# JWT 密钥配置 - 自动生成，请勿提交到公开仓库\n` +
    `# 修改后所有已签发的 token 将失效\n` +
    `JWT_ACCESS_SECRET=${generated.accessSecret}\n` +
    `JWT_REFRESH_SECRET=${generated.refreshSecret}\n`;
  try {
    fs.mkdirSync(path.dirname(jwtPath), { recursive: true });
    fs.writeFileSync(jwtPath, fileContent, { mode: 0o600 });
    console.log('[CONFIG] Generated config/jwt.txt with random secrets');
  } catch (e) {
    console.error('[CONFIG] Failed to write jwt.txt:', e.message);
  }
  return generated;
}

const jwt = loadJwtConfig();

// ── CORS 配置: config/cors.txt ──
// CORS_RESTRICTED=true 启用白名单（仅允许内置+列出的源携带凭据）；false 放开限制
//（反射任意 Origin 并允许凭据，供 @[url](URL) 内嵌网页跨源调用 OJ API 的场景）。
// 内嵌页受 SameSite=strict Cookie 与 localStorage Token 双约束，放开后凭证不随第三方页自动带出。
function loadCorsConfig() {
  let restricted = true;
  const origins = new Set([
    'http://localhost',
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://127.0.0.1:3000'
  ]);
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'cors.txt');
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (/^CORS_RESTRICTED=/i.test(t)) {
        restricted = t.split('=')[1].trim() !== 'false';
      } else {
        origins.add(t.replace(/\/$/, ''));
      }
    }
  } catch {}
  return { restricted, origins: Array.from(origins) };
}

const corsCfg = loadCorsConfig();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    accessSecret: jwt.accessSecret,
    refreshSecret: jwt.refreshSecret,
    accessExpiry: '15m',
    refreshExpiry: '7d',
    refreshExpiryMs: 7 * 24 * 60 * 60 * 1000
  },
  cors: {
    restricted: corsCfg.restricted,
    origins: corsCfg.origins
  },
  cookie: {
    // 生产环境（HTTPS）应设为 true；本地 HTTP 部署保持 false
    secure: process.env.COOKIE_SECURE === 'true' || false
  },
  database: {
    path: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'winoj.db')
  },
  sandbox: {
    timeLimitMultiplier: 2,
    maxProcesses: 64,
    tempDir: process.env.SANDBOX_TEMP || path.join(os.tmpdir(), 'winoj-sandbox'),
    maxOutputSize: 64 * 1024,
    maxSourceSize: 64 * 1024,
    // 安全沙箱: 编译 sandbox_runner.cpp 后自动启用 Job Object + 受限令牌隔离
    // 未编译时自动回退到传统模式 (spawn + memwatch)
    networkIsolation: true,   // 断网: 通过受限令牌剥离网络相关特权
    killOnJobClose: true,     // Job 关闭时杀死整棵进程树
    noBreakaway: true          // 禁止子进程脱离沙箱
  },
  judge: judgeCfg,
  ide: {
    timeLimitMs: 10000,
    memoryLimitMb: 256
  },
  rateLimit: {
    submissions: { windowMs: 60000, max: 10 },
    ideRun: { windowMs: 60000, max: 20 }
  },
  security: {
    enabled: ai.enabled,
    url: ai.url,
    model: ai.model,
    key: ai.key,
    codeLengthLimit: ai.codeLengthLimit
  },
  captcha: {
    enabled: captchaCfg.enabled
  },
  email: {
    enabled: email.enabled,
    apiKey: email.apiKey,
    from: email.from
  }
};
