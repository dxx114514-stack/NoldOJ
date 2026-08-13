const { Resend } = require('resend');
const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config/config');

// 使用 CSPRNG (crypto.randomInt) 生成 6 位验证码，避免 Math.random 可预测
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendVerificationEmail(email, code) {
  if (!config.email.enabled || !config.email.apiKey) {
    // 邮件禁用时不在控制台打印明文验证码，避免泄露
    console.log('[Email] Skipped (disabled).');
    return true;
  }
  try {
    const resend = new Resend(config.email.apiKey);
    await resend.emails.send({
      from: config.email.from,
      to: email,
      subject: 'WinOJ - 邮箱验证码',
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px">
        <h2 style="color:#6366f1">WinOJ 邮箱验证</h2>
        <p>你的验证码是：</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#1f2937;background:#f3f4f6;padding:16px;border-radius:8px;text-align:center">${code}</div>
        <p style="color:#6b7280;font-size:13px;margin-top:16px">验证码 10 分钟内有效，请勿泄露给他人。</p>
      </div>`
    });
    return true;
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return false;
  }
}

function saveCode(email, code) {
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, ?)').run(email, code, expiresAt);
}

function verifyCode(email, code) {
  const row = db.prepare('SELECT * FROM email_codes WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime(\'now\') ORDER BY id DESC LIMIT 1').get(email, code);
  if (!row) return false;
  db.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').run(row.id);
  return true;
}

module.exports = { generateCode, sendVerificationEmail, saveCode, verifyCode };
