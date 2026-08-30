const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// R9-13/D-L15: Windows 上 fs mode 不生效，config 目录下的密钥文件（jwt/email/ai/cors）
// 默认继承宽松 DACL（Authenticated Users 可读）。统一用 icacls 收紧——
// 只保留当前用户 + SYSTEM + Administrators，移除 Everyone/Users 读权限。
function hardenConfigFileAcl(filePath) {
  if (process.platform !== 'win32') return;
  const { execFileSync } = require('child_process');
  try {
    const user = `${process.env.USERDOMAIN || 'BUILTIN'}\\${process.env.USERNAME || 'Administrator'}`;
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(R,W)`, '/grant:r', 'SYSTEM:(F)', '/grant:r', 'Administrators:(F)'], { stdio: 'ignore', timeout: 10000 });
  } catch {}
}

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
  hardenConfigFileAcl(emailPath); // R9-13
  return result;
}

const email = loadEmailConfig();

function loadAiConfig() {
  const aiPath = path.join(__dirname, '..', '..', 'config', 'ai.txt');
  const defaults = { enabled: false, url: 'http://localhost:11434/api/chat', model: 'qwen3:1.7b', key: '' };
  const result = { codeLengthLimit: 131072, security: { ...defaults }, hint: { ...defaults }, testdata: { ...defaults } };
  try {
    const content = fs.readFileSync(aiPath, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('CODE_LENGTH_LIMIT=')) result.codeLengthLimit = parseInt(t.split('=')[1], 10) || 131072;
      // 安全审查
      if (t.startsWith('SECURITY_ENABLED=')) result.security.enabled = t.split('=')[1] === 'true';
      if (t.startsWith('SECURITY_URL=')) result.security.url = t.split('=').slice(1).join('=');
      if (t.startsWith('SECURITY_MODEL=')) result.security.model = t.split('=').slice(1).join('=');
      if (t.startsWith('SECURITY_KEY=')) result.security.key = t.split('=').slice(1).join('=');
      // AI 提示
      if (t.startsWith('HINT_ENABLED=')) result.hint.enabled = t.split('=')[1] === 'true';
      if (t.startsWith('HINT_URL=')) result.hint.url = t.split('=').slice(1).join('=');
      if (t.startsWith('HINT_MODEL=')) result.hint.model = t.split('=').slice(1).join('=');
      if (t.startsWith('HINT_KEY=')) result.hint.key = t.split('=').slice(1).join('=');
      // AI 测试数据
      if (t.startsWith('TESTDATA_ENABLED=')) result.testdata.enabled = t.split('=')[1] === 'true';
      if (t.startsWith('TESTDATA_URL=')) result.testdata.url = t.split('=').slice(1).join('=');
      if (t.startsWith('TESTDATA_MODEL=')) result.testdata.model = t.split('=').slice(1).join('=');
      if (t.startsWith('TESTDATA_KEY=')) result.testdata.key = t.split('=').slice(1).join('=');
    }
  } catch {}
  // 回退：未单独配置的字段继承 SECURITY_* 的值
  for (const sec of ['url', 'model', 'key']) {
    if (!result.hint[sec]) result.hint[sec] = result.security[sec];
    if (!result.testdata[sec]) result.testdata[sec] = result.security[sec];
  }
  hardenConfigFileAcl(aiPath); // R9-13
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
const registerCfg = loadRegisterConfig();

// ── 注册开关: config/register.txt 的 REGISTER_ENABLED=，默认开启；可由超管面板热切换(R12-3) ──
const registerPath = path.join(__dirname, '..', '..', 'config', 'register.txt');
function loadRegisterConfig() {
  const result = { enabled: true };
  try {
    const content = fs.readFileSync(registerPath, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('REGISTER_ENABLED=')) result.enabled = t.split('=').slice(1).join('=').trim() === 'true';
    }
  } catch {}
  return result;
}
function reloadRegisterConfig() {
  const cfg = loadRegisterConfig();
  module.exports.register.enabled = cfg.enabled;
  return cfg.enabled;
}

// ── 判题并发: config/judge.txt 的 MAX_THREADS= 或环境变量 NoldOJ_JUDGE_THREADS，
//    默认 (CPU 数 + 1) / 2，最小 1 ──
function loadJudgeConfig() {
  const cpu = Math.max(1, (os.cpus() || []).length || 1);
  let maxThreads = Math.max(1, Math.floor((cpu + 1) / 2));
  const envVal = parseInt(process.env.NoldOJ_JUDGE_THREADS, 10);
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
    const obj = { accessSecret: '', refreshSecret: '', emailCodeSecret: '' };
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('JWT_ACCESS_SECRET=')) obj.accessSecret = t.split('=').slice(1).join('=').trim();
      if (t.startsWith('JWT_REFRESH_SECRET=')) obj.refreshSecret = t.split('=').slice(1).join('=').trim();
      if (t.startsWith('EMAIL_CODE_SECRET=')) obj.emailCodeSecret = t.split('=').slice(1).join('=').trim();
    }
    return obj;
  };
  try {
    const obj = read();
    if (obj.accessSecret && obj.refreshSecret && obj.emailCodeSecret) return obj;
  } catch {}
  // 首次启动: 生成 64 字节强随机密钥并写入文件
  const generated = {
    accessSecret: crypto.randomBytes(64).toString('hex'),
    refreshSecret: crypto.randomBytes(64).toString('hex'),
    emailCodeSecret: crypto.randomBytes(64).toString('hex')
  };
  const fileContent =
    `# JWT 密钥配置 - 自动生成，请勿提交到公开仓库\n` +
    `# 修改后所有已签发的 token 将失效\n` +
    `JWT_ACCESS_SECRET=${generated.accessSecret}\n` +
    `JWT_REFRESH_SECRET=${generated.refreshSecret}\n` +
    `EMAIL_CODE_SECRET=${generated.emailCodeSecret}\n`;
  try {
    fs.mkdirSync(path.dirname(jwtPath), { recursive: true });
    fs.writeFileSync(jwtPath, fileContent, { mode: 0o600 });
    // D-L15/R9-13: Windows 上 fs mode 不生效（仅 Unix），用 icacls 收紧 ACL
    hardenConfigFileAcl(jwtPath);
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
  hardenConfigFileAcl(path.join(__dirname, '..', '..', 'config', 'cors.txt')); // R9-13
  return { restricted, origins: Array.from(origins) };
}

// ── Sandboxie 配置: config/sandboxie.txt ──
// 路径自动检测: 默认从 OJ 根目录的上级查找 (即 {OJ_ROOT}/../sandboxie/)
// 例: OJ 装在 C:\NoldOJ，则 Sandboxie 在 C:\sandboxie\ (与 NoldOJ 同级)
function loadSandboxieConfig() {
  const result = {
    enabled: true,
    startExe: 'Start.exe',
    sbieIni: 'SbieIni.exe',
    boxPrefix: 'NoldOJ',
    templateBox: 'JudgeBox',
    // 编译器/运行时路径白名单（Sandboxie ReadFilePath/OpenFilePath）
    compilerPaths: [],
    workspacePaths: []
  };
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'sandboxie.txt');
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('SANDBOXIE_ENABLED=')) result.enabled = t.split('=')[1] === 'true';
      if (t.startsWith('START_EXE=')) result.startExe = t.split('=').slice(1).join('=');
      if (t.startsWith('SBIE_INI=')) result.sbieIni = t.split('=').slice(1).join('=');
      if (t.startsWith('BOX_PREFIX=')) result.boxPrefix = t.split('=').slice(1).join('=');
      if (t.startsWith('TEMPLATE_BOX=')) result.templateBox = t.split('=').slice(1).join('=');
      if (t.startsWith('COMPILER_PATH=')) result.compilerPaths.push(t.split('=').slice(1).join('='));
      if (t.startsWith('WORKSPACE_PATH=')) result.workspacePaths.push(t.split('=').slice(1).join('='));
    }
  } catch {}

  // 路径自动检测：若 startExe/sbieIni 是相对文件名，在 OJ 安装根目录的 sandboxie/ 目录查找
  // 部署结构: {INSTALL_ROOT}/NoldOJ/ (OJ根) + {INSTALL_ROOT}/sandboxie/ + {INSTALL_ROOT}/mingw64/
  // __dirname = backend/config/ → 往上两级 = OJ 根 → 再往上一级 = 安装根
  const ojRoot = path.join(__dirname, '..', '..');
  const installRoot = path.join(ojRoot, '..'); // 安装根 (C:\NoldOJ)
  const sbieDir = path.join(installRoot, 'sandboxie');

  if (!path.isAbsolute(result.startExe)) {
    const candidate = path.join(sbieDir, result.startExe);
    if (fs.existsSync(candidate)) result.startExe = candidate;
  }
  if (!path.isAbsolute(result.sbieIni)) {
    const candidate = path.join(sbieDir, result.sbieIni);
    if (fs.existsSync(candidate)) result.sbieIni = candidate;
  }

  // 若未配置编译器路径，自动探测 mingw64 (在安装根目录下)
  if (result.compilerPaths.length === 0) {
    const mingwDir = path.join(installRoot, 'mingw64');
    if (fs.existsSync(mingwDir)) {
      result.compilerPaths.push(path.join(mingwDir, '*'));
    }
  }

  // 若未配置工作目录路径，使用 OJ 根目录下的 workspace
  if (result.workspacePaths.length === 0) {
    result.workspacePaths.push(path.join(ojRoot, 'workspace', '*'));
  }

  return result;
}

const corsCfg = loadCorsConfig();

// R9-20: security.txt 联系方式：可写 config/security.txt（CONTACT=），缺省回退仓库地址
function loadSecurityContact() {
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'security.txt');
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('CONTACT=')) {
        const v = t.split('=').slice(1).join('=').trim();
        if (v) return v;
      }
    }
  } catch {}
  return 'https://github.com/dxx114514-stack/NoldOJ.mimo';
}

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
    path: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'NoldOJ.db')
  },
  sandbox: {
    timeLimitMultiplier: 2,
    maxProcesses: 64,
    tempDir: process.env.SANDBOX_TEMP || path.join(os.tmpdir(), 'NoldOJ-sandbox'),
    maxOutputSize: 64 * 1024,
    maxSourceSize: 64 * 1024,
    // 安全沙箱: 编译 sandbox_runner.cpp 后自动启用 Job Object + 受限令牌隔离
    // 未编译时自动回退到传统模式 (spawn + memwatch)
    networkIsolation: true,   // 断网: 通过受限令牌剥离网络相关特权
    killOnJobClose: true,     // Job 关闭时杀死整棵进程树
    noBreakaway: true,        // 禁止子进程脱离沙箱
    // Sandboxie-Classic 隔离: 编译/运行均可选包装, 与 Job Object 叠加
    // 启用条件: config/sandboxie.txt 中 SANDBOXIE_ENABLED=true 且 Start.exe 可用
    sandboxie: loadSandboxieConfig()
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
    enabled: ai.security.enabled,
    url: ai.security.url,
    model: ai.security.model,
    key: ai.security.key,
    codeLengthLimit: ai.codeLengthLimit,
    // R9-20: security.txt contact 可由 config/security.txt 配置，缺省回退仓库地址
    contact: loadSecurityContact()
  },
  ai: {
    security: ai.security,
    hint: ai.hint,
    testdata: ai.testdata
  },
  captcha: {
    enabled: captchaCfg.enabled
  },
  register: {
    // R12-3: 注册开关, 默认开放; registerPath/reloadRegisterConfig 供管理接口热切换
    get enabled() { return registerCfg.enabled; },
    set enabled(v) { registerCfg.enabled = !!v; },
    reload: reloadRegisterConfig,
    path: registerPath
  },
  email: {
    enabled: email.enabled,
    apiKey: email.apiKey,
    from: email.from
  }
};

