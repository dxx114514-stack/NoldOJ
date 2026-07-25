const path = require('path');
const os = require('os');
const fs = require('fs');

function loadCfConfig() {
  const cfPath = path.join(__dirname, '..', '..', 'config', 'cf.txt');
  const result = { siteKey: '', secretKey: '' };
  try {
    const content = fs.readFileSync(cfPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('TURNSTILE_SITE_KEY=')) result.siteKey = trimmed.split('=').slice(1).join('=');
      if (trimmed.startsWith('TURNSTILE_SECRET_KEY=')) result.secretKey = trimmed.split('=').slice(1).join('=');
    }
  } catch {}
  return result;
}

const cf = loadCfConfig();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'winoj-access-secret-key-2024',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'winoj-refresh-secret-key-2024',
    accessExpiry: '15m',
    refreshExpiry: '7d',
    refreshExpiryMs: 7 * 24 * 60 * 60 * 1000
  },
  database: {
    path: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'winoj.db')
  },
  sandbox: {
    timeLimitMultiplier: 2,
    maxProcesses: 64,
    tempDir: process.env.SANDBOX_TEMP || path.join(os.tmpdir(), 'winoj-sandbox'),
    maxOutputSize: 64 * 1024,
    maxSourceSize: 64 * 1024
  },
  rateLimit: {
    submissions: { windowMs: 60000, max: 10 },
    ideRun: { windowMs: 60000, max: 20 }
  },
  security: {
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:1.7b',
    codeLengthLimit: parseInt(process.env.CODE_LENGTH_LIMIT || '131072')
  },
  turnstile: {
    siteKey: cf.siteKey,
    secretKey: cf.secretKey
  }
};
