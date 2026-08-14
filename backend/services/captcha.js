const svgCaptcha = require('svg-captcha');
const crypto = require('crypto');

const sessions = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
// 防止高并发请求无限增长导致内存耗尽: 超出后淘汰最旧的验证码
const MAX_SESSIONS = 10000;

function darkenColor(attr, color) {
  const c = color.toLowerCase();
  if (c === '#000000' || c === '#000' || c === 'black' || c === 'none') return `${attr}="${color}"`;
  const m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return `${attr}="${color}"`;
  let r, g, b;
  if (m[1].length === 3) {
    r = parseInt(m[1][0] + m[1][0], 16);
    g = parseInt(m[1][1] + m[1][1], 16);
    b = parseInt(m[1][2] + m[1][2], 16);
  } else {
    r = parseInt(m[1].substring(0, 2), 16);
    g = parseInt(m[1].substring(2, 4), 16);
    b = parseInt(m[1].substring(4, 6), 16);
  }
  const lum = (0.299 * r + 0.587 * g + 0.114 * b);
  if (lum > 220 || lum < 90) return `${attr}="${color}"`;
  const nr = Math.floor(r * 0.4);
  const ng = Math.floor(g * 0.4);
  const nb = Math.floor(b * 0.4);
  return `${attr}="#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}"`;
}

function darkenSvg(svg) {
  return svg.replace(/(fill|stroke)="([^"]+)"/g, (match, attr, color) => darkenColor(attr, color));
}

function generateCaptcha() {
  const captcha = svgCaptcha.create({
    size: 4,
    noise: 2,
    color: true,
    background: '#ffffff',
    width: 120,
    height: 44,
    fontSize: 26,
    charPreset: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  });
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + CAPTCHA_TTL;
  sessions.set(id, { text: captcha.text.toLowerCase(), expiresAt });
  if (sessions.size > MAX_SESSIONS) {
    // 淘汰最旧的验证码，防止 OOM
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
  cleanup();
  return { id, svg: darkenSvg(captcha.data) };
}

function verifyCaptcha(id, text) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  if (Date.now() > session.expiresAt) return false;
  if (!text) return false;
  return session.text === text.toLowerCase();
}

function cleanup() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}

setInterval(cleanup, 60 * 1000);

module.exports = { generateCaptcha, verifyCaptcha };
