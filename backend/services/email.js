const { Resend } = require('resend');
const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config/config');
const { hmacDigest } = require('../utils/securityHelpers');

// 使用 CSPRNG (crypto.randomInt) 生成 6 位验证码，避免 Math.random 可预测
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendCodeEmail(email, code, opts) {
  const { subject, title, hint } = opts || {};
  if (!config.email.enabled || !config.email.apiKey) {
    // 邮件禁用时不在控制台打印明文验证码，避免泄露
    console.log('[Email] Skipped (disabled).');
    return true;
  }
  try {
    const resend = new Resend(config.email.apiKey);
    const result = await resend.emails.send({
      from: config.email.from,
      to: email,
      subject,
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px">
        <h2 style="color:#6366f1">${title}</h2>
        <p>你的验证码是：</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#1f2937;background:#f3f4f6;padding:16px;border-radius:8px;text-align:center">${code}</div>
        <p style="color:#6b7280;font-size:13px;margin-top:16px">${hint}</p>
      </div>`
    });
    // Resend v6 的 send 返回 { data, error } 而非抛错，需显式检查 error 字段
    if (result && result.error) {
      console.error('[Email] Resend returned error:', result.error.message || JSON.stringify(result.error));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return false;
  }
}

async function sendVerificationEmail(email, code) {
  return sendCodeEmail(email, code, {
    subject: 'NoldOJ - 邮箱验证码',
    title: 'NoldOJ 邮箱验证',
    hint: '验证码 10 分钟内有效，请勿泄露给他人。'
  });
}

async function sendPasswordResetEmail(email, code) {
  return sendCodeEmail(email, code, {
    subject: 'NoldOJ - 密码重置',
    title: 'NoldOJ 密码重置',
    hint: '重置验证码 10 分钟内有效，请勿泄露给他人。'
  });
}

function hashCode(code) {
  // HMAC-SHA256 + 独立密钥，防止数据库泄露后彩虹表反查验证码（D-L16: 不复用 JWT access secret）
  return hmacDigest(code, config.jwt.emailCodeSecret || config.jwt.accessSecret);
}

function saveCode(email, code) {
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  // R9-21: 顺带清理已过期/已用行，防止 email_codes 无限增长
  db.prepare("DELETE FROM email_codes WHERE used = 1 OR datetime(expires_at) <= datetime('now')").run();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  // 只存哈希，避免数据库泄露时验证码明文外泄（6 位码 + 校验速率限制下足够安全）
  db.prepare('INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, ?)').run(email, hashCode(code), expiresAt);
}

// D-M3: 单码最多 5 次失败，防 6 位验证码被暴力枚举
const MAX_VERIFY_ATTEMPTS = 5;

function verifyCode(email, code) {
  // datetime(expires_at) 归一化 ISO(…T…Z) 与 SQLite(空格) 两种时间格式，
  // 避免字符串比较使 'T' > ' ' 导致验证码当日恒有效
  const row = db.prepare("SELECT * FROM email_codes WHERE email = ? AND used = 0 AND datetime(expires_at) > datetime('now') ORDER BY id DESC LIMIT 1").get(email);
  if (!row) return false;
  const expected = Buffer.from(row.code, 'hex');
  const actual = Buffer.from(hashCode(code), 'hex');
  const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!ok) {
    // 失败计数：达到上限即作废该验证码，迫使重新申请
    const attempts = (row.attempts || 0) + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      db.prepare('DELETE FROM email_codes WHERE id = ?').run(row.id);
    } else {
      db.prepare('UPDATE email_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    }
    return false;
  }
  db.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').run(row.id);
  return true;
}

module.exports = { generateCode, sendVerificationEmail, sendPasswordResetEmail, saveCode, verifyCode };

