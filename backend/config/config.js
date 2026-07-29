const path = require('path');
const os = require('os');
const fs = require('fs');

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
    enabled: ai.enabled,
    url: ai.url,
    model: ai.model,
    key: ai.key,
    codeLengthLimit: ai.codeLengthLimit
  },
  captcha: {
    enabled: true
  },
  email: {
    enabled: email.enabled,
    apiKey: email.apiKey,
    from: email.from
  }
};
