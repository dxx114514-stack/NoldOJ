/**
 * 复现: 管理员重置密码后，用户无法登录的问题 (带验证码)
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const fs = require('fs');
const path = require('path');

const ANSWERS_FILE = path.join(__dirname, '..', '..', 'config', 'captcha_answers.json');

function getCaptchaText(captchaId) {
  try {
    const content = fs.readFileSync(ANSWERS_FILE, 'utf8');
    const answers = JSON.parse(content);
    return answers[captchaId] || null;
  } catch {
    return null;
  }
}

async function getCaptcha() {
  const r = await fetch(`${BASE}/api/v1/auth/captcha`);
  const { id, svg } = await r.json();
  let code = null;
  for (let i = 0; i < 20; i++) {
    code = getCaptchaText(id);
    if (code) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return { id, code, svg };
}

async function loginWithCaptcha(username, password) {
  const captcha = await getCaptcha();
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      captcha_id: captcha.id,
      captcha_code: captcha.code || ''
    })
  });
  const data = await res.json();
  return { res, data, captcha };
}

async function main() {
  console.log('\n=== 复现: 重置密码后无法登录 (带验证码) ===\n');

  // 1. admin 登录
  console.log('[1] admin 登录...');
  const adminLogin = await loginWithCaptcha('admin', 'admin123');
  console.log('    captcha:', adminLogin.captcha.code);
  console.log('    状态:', adminLogin.res.status);
  if (!adminLogin.data.access_token) {
    console.error('admin 登录失败:', adminLogin.data);
    process.exit(1);
  }
  const token = adminLogin.data.access_token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  console.log('    OK\n');

  // 2. 创建测试用户
  console.log('[2] 创建测试用户 testreset / Test@123...');
  const createUser = await fetch(`${BASE}/api/v1/users`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ username: 'testreset', password: 'Test@123', nickname: 'TestReset' })
  });
  const createData = await createUser.json();
  console.log('    响应:', createData);
  let userId = createData.user?.id;
  if (!userId) {
    const userList = await fetch(`${BASE}/api/v1/users?search=testreset`, { headers: auth });
    const ud = await userList.json();
    userId = ud.users?.find(u => u.username === 'testreset')?.id;
    console.log('    用户已存在, id:', userId);
  }
  console.log(`    用户 ID: ${userId}\n`);

  // 3. 用原始密码登录
  console.log('[3] 用原始密码 Test@123 登录...');
  const origLogin = await loginWithCaptcha('testreset', 'Test@123');
  console.log('    captcha:', origLogin.captcha.code);
  console.log('    状态:', origLogin.res.status);
  console.log('    响应:', origLogin.data.message || origLogin.data);
  console.log(origLogin.data.access_token ? '    OK\n' : '    失败!\n');

  // 4. admin 重置密码
  console.log('[4] admin 重置密码为 NewPass@456...');
  const resetRes = await fetch(`${BASE}/api/v1/users/${userId}/reset-password`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ new_password: 'NewPass@456' })
  });
  const resetData = await resetRes.json();
  console.log('    状态:', resetRes.status, resetData);
  console.log('    OK, 无报错\n');

  // 5. 用新密码登录 — 关键测试
  console.log('[5] 用新密码 NewPass@456 登录（应成功）...');
  const newPwdLogin = await loginWithCaptcha('testreset', 'NewPass@456');
  console.log('    captcha:', newPwdLogin.captcha.code);
  console.log('    状态:', newPwdLogin.res.status);
  console.log('    响应:', newPwdLogin.data.message || newPwdLogin.data);
  console.log(newPwdLogin.data.access_token ? '    OK, 新密码可登录\n' : '    失败! 这就是 bug!\n');

  // 6. 模拟前端: 错误密码登录后，验证码被消耗，再用新验证码登录
  console.log('[6] 模拟前端流程: 错误密码 → 验证码消耗 → 新验证码 + 新密码...');
  const wrongLogin = await loginWithCaptcha('testreset', 'WrongPassword');
  console.log('    错误密码状态:', wrongLogin.res.status, wrongLogin.data.message);
  // 前端在错误时会刷新验证码，然后用新验证码重试
  const retryLogin = await loginWithCaptcha('testreset', 'NewPass@456');
  console.log('    重试 captcha:', retryLogin.captcha.code);
  console.log('    重试状态:', retryLogin.res.status);
  console.log('    重试响应:', retryLogin.data.message || retryLogin.data);
  console.log(retryLogin.data.access_token ? '    OK, 重试成功\n' : '    失败!\n');

  // 清理
  if (userId) {
    console.log('[清理] 删除测试用户...');
    await fetch(`${BASE}/api/v1/users/${userId}`, { method: 'DELETE', headers: auth });
  }

  console.log('=== 测试结束 ===\n');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
