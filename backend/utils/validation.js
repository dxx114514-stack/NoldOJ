// 共享校验工具（密码强度等），供 auth/users 等路由复用

// 密码强度: 至少 8 位，含字母，且含数字或特殊符号
function isStrongPassword(pw) {
  if (!pw || pw.length < 8) return false;
  // bcrypt 底层仅处理前 72 字节，超长密码会被截断导致认证绕过风险
  if (Buffer.byteLength(pw, 'utf8') > 72) return false;
  if (!/[a-zA-Z]/.test(pw)) return false;
  return /\d/.test(pw) || /[^a-zA-Z0-9]/.test(pw);
}

module.exports = { isStrongPassword };