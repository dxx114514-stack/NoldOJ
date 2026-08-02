const svgCaptcha = require('svg-captcha');
const crypto = require('crypto');

const sessions = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;

function darkenSvg(svg) {
  return svg.replace(/(fill|stroke)="([^"]+)"/g, (match, attr, color) => {
    if (color === 'none') return match;
    const c = color.toLowerCase();
    if (c === '#000000' || c === '#000' || c === 'black') return match;
    const m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const r = parseInt(m[1].substring(0, 2), 16);
      const g = parseInt(m[1].substring(2, 4), 16);
      const b = parseInt(m[1].substring(4, 6), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b);
      if (lum > 220) return match;
      if (lum < 90) return match;
      const nr = Math.floor(r * 0.4);
      const ng = Math.floor(g * 0.4);
      const nb = Math.floor(b * 0.4);
      return `${attr}="#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}"`;
    }
    const m3 = c.match(/^#([0-9a-f]{3})$/i);
    if (m3) {
      const r = parseInt(m3[1][0] + m3[1][0], 16);
      const g = parseInt(m3[1][1] + m3[1][1], 16);
      const b = parseInt(m3[1][2] + m3[1][2], 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b);
      if (lum > 220) return match;
      if (lum < 90) return match;
      const nr = Math.floor(r * 0.4);
      const ng = Math.floor(g * 0.4);
      const nb = Math.floor(b * 0.4);
      return `${attr}="#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}"`;
    }
    return match;
  });
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
