const crypto = require('crypto');

// 自绘 SVG 验证码：替代已停止维护的 svg-captcha（1.4.0，2019 年后无更新）。
// 无第三方依赖，字符以 <text> 元素渲染（便于测试解析），内置噪线/噪点/旋转干扰。

const sessions = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
// 防止高并发请求无限增长导致内存耗尽: 超出后淘汰最旧的验证码
const MAX_SESSIONS = 10000;

const CHAR_PRESET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WIDTH = 120;
const HEIGHT = 44;

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function randColor() {
  const r = randInt(40, 180);
  const g = randInt(40, 180);
  const b = randInt(40, 180);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function pickText() {
  let text = '';
  for (let i = 0; i < 4; i++) {
    text += CHAR_PRESET[randInt(0, CHAR_PRESET.length - 1)];
  }
  return text;
}

function generateSvg(text) {
  const chars = text.split('');
  const fontSize = 24;
  const glyphs = chars.map((ch, i) => {
    const x = 18 + i * 26;
    const y = randInt(26, 34);
    const rotate = randInt(-18, 18);
    const color = randColor();
    return `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="Arial, sans-serif" font-weight="bold" fill="${color}" transform="rotate(${rotate} ${x} ${y})">${ch}</text>`;
  }).join('');

  // 噪线
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const x1 = randInt(0, WIDTH * 0.3);
    const y1 = randInt(0, HEIGHT);
    const x2 = randInt(WIDTH * 0.7, WIDTH);
    const y2 = randInt(0, HEIGHT);
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${randColor()}" stroke-width="1" opacity="0.6"/>`);
  }

  // 噪点
  const dots = [];
  for (let i = 0; i < 30; i++) {
    dots.push(`<circle cx="${randInt(0, WIDTH)}" cy="${randInt(0, HEIGHT)}" r="${randInt(1, 2)}" fill="${randColor()}" opacity="0.5"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>${dots.join('')}${lines.join('')}${glyphs}</svg>`;
}

function generateCaptcha() {
  const text = pickText();
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + CAPTCHA_TTL;
  sessions.set(id, { text: text.toLowerCase(), expiresAt });
  if (sessions.size > MAX_SESSIONS) {
    // 淘汰最旧的验证码，防止 OOM
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
  cleanup();
  return { id, svg: generateSvg(text) };
}

function verifyCaptcha(id, text) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  if (Date.now() > session.expiresAt) return false;
  if (!text) return false;
  return session.text === String(text).toLowerCase().replace(/\s+/g, '');
}

function cleanup() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}

setInterval(cleanup, 60 * 1000);

module.exports = { generateCaptcha, verifyCaptcha };