/**
 * 安全修复验证测试
 *
 * 用法:
 *   1. 先启动服务器: cd backend && npm start
 *   2. 再运行测试:   node test/security.test.js
 *
 * 覆盖场景:
 *   - CORS 白名单（恶意源拒绝 / 白名单源放行）
 *   - helmet 安全响应头
 *   - 上传文件接口认证
 *   - SVG 上传禁用
 *   - magic bytes 伪装文件检测
 *   - JWT 旧硬编码密钥失效
 *   - SPJ 代码沙箱（阻断 require / process）
 *   - Zip Slip 路径遍历防御
 *   - login 速率限制
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

let pass = 0, fail = 0, skip = 0;
const results = [];

const C = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  yellow:s => `\x1b[33m${s}\x1b[0m`,
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
  gray:  s => `\x1b[90m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`
};

async function test(name, fn) {
  try {
    await fn();
    pass++;
    results.push({ name, status: 'pass' });
    console.log(`${C.green('✓ PASS')} ${name}`);
  } catch (err) {
    fail++;
    results.push({ name, status: 'fail', err: err.message });
    console.log(`${C.red('✗ FAIL')} ${name}`);
    console.log(C.red(`        ${err.message}`));
  }
}

function skip_(name, reason) {
  skip++;
  results.push({ name, status: 'skip', reason });
  console.log(`${C.yellow('⊘ SKIP')} ${name}  ${C.gray(reason)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `期望 ${expected}, 实际 ${actual}`);
}

async function request(method, urlPath, { headers = {}, body } = {}) {
  const opts = { method, headers: { ...headers } };
  // 模拟浏览器同源请求头，满足服务端 CORS 凭据校验（无 Origin 的带凭据写请求会被拒绝）
  const hasCreds = !!(headers.Authorization || headers.Cookie);
  if (hasCreds && !('Origin' in headers)) {
    opts.headers['Origin'] = BASE;
  }
  if (body !== undefined) {
    if (body instanceof FormData) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(`${BASE}${urlPath}`, opts);
  return res;
}

async function login(username, password) {
  const res = await request('POST', '/api/v1/auth/login', { body: { username, password } });
  const data = await res.json();
  return { res, data };
}

// 获取验证码：优先用 WINOJ_CAPTCHA_DEBUG=1 时响应携带的 code 字段；
// 兜底解析 svg 中的 <text>（兼容旧版 <text> 渲染的验证码）。
async function getCaptcha() {
  const r = await fetch(`${BASE}/api/v1/auth/captcha`);
  const data = await r.json();
  const { id, svg } = data;
  let code = data.code || '';
  if (!code && svg) {
    const matches = [...svg.matchAll(/<text[^>]*>\s*([^<]+?)\s*<\/text>/g)];
    code = matches.map(m => m[1].trim()).join('');
  }
  return { id, code };
}

// 带 captcha 的登录
async function loginWithCaptcha(username, password) {
  const captcha = await getCaptcha();
  const res = await request('POST', '/api/v1/auth/login', {
    body: { username, password, captcha_id: captcha.id, captcha_code: captcha.code }
  });
  const data = await res.json();
  return { res, data, captcha };
}

async function pollSubmission(sid, token, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await request('GET', `/api/v1/submissions/${sid}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d.status && !['pending', 'running', 'compiling', 'judging'].includes(d.status)) {
      return d;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error('提交评测超时');
}

async function main() {
  console.log(C.bold(C.cyan('\n═══════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  WinOJ 安全修复验证测试')));
  console.log(C.bold(C.cyan('═══════════════════════════════════════════════')));
  console.log(C.gray(`  目标: ${BASE}`));

  // 健康检查
  try {
    const r = await fetch(`${BASE}/api/v1/stats`);
    if (!r.ok) throw new Error(`状态码 ${r.status}`);
  } catch {
    console.log(C.red('\n[ERROR] 服务器未运行，请先执行 npm start'));
    process.exit(1);
  }

  // 登录 admin 获取 token（在所有限制触发前）
  const { data: loginData, captcha } = await loginWithCaptcha(ADMIN_USER, ADMIN_PASS);
  assert(loginData.access_token, `admin 登录失败（captcha=${captcha.code || '空'}）: ${JSON.stringify(loginData)}`);
  const token = loginData.access_token;
  const auth = { Authorization: `Bearer ${token}` };
  console.log(C.gray(`  已登录: ${loginData.user.username} (${loginData.user.role})\n`));

  // ─────────────────────────────────────────────
  // 1. CORS 白名单
  // ─────────────────────────────────────────────
  await test('CORS: 恶意源不被回显', async () => {
    const r = await fetch(`${BASE}/api/v1/stats`, {
      headers: { Origin: 'https://evil-attacker.com' }
    });
    const acao = r.headers.get('access-control-allow-origin');
    assert(acao !== 'https://evil-attacker.com', `恶意源被回显: ${acao}`);
  });

  await test('CORS: 白名单源被允许', async () => {
    const r = await fetch(`${BASE}/api/v1/stats`, {
      headers: { Origin: 'http://localhost:3000' }
    });
    const acao = r.headers.get('access-control-allow-origin');
    assert(acao === 'http://localhost:3000', `白名单源未被放行: ${acao}`);
  });

  // ─────────────────────────────────────────────
  // 2. helmet 安全响应头
  // ─────────────────────────────────────────────
  await test('helmet: X-Content-Type-Options: nosniff', async () => {
    const r = await fetch(`${BASE}/api/v1/stats`);
    const v = r.headers.get('x-content-type-options');
    assertEqual(v, 'nosniff', `头缺失或错误: ${v}`);
  });

  await test('helmet: Content-Security-Policy 存在', async () => {
    const r = await fetch(`${BASE}/index.html`);
    const v = r.headers.get('content-security-policy');
    assert(v && v.length > 0, 'CSP 头缺失');
  });

  await test('helmet: X-Frame-Options 防点击劫持', async () => {
    const r = await fetch(`${BASE}/index.html`);
    const v = r.headers.get('x-frame-options');
    assert(v && v.toLowerCase() !== 'allow', `X-Frame-Options 未设置: ${v}`);
  });

  // ─────────────────────────────────────────────
  // 2.5 验证码: 答案不得以 <text> 明文暴露在 SVG DOM 中（R10 方案 A）
  // ─────────────────────────────────────────────
  await test('captcha: SVG 不含 <text> 明文答案', async () => {
    const r = await fetch(`${BASE}/api/v1/auth/captcha`);
    const data = await r.json();
    assert(data.id, '未返回验证码 id');
    assert(data.svg, '未返回验证码 svg');
    assert(!/<text/i.test(data.svg), 'SVG 含 <text> 元素，答案可从 DOM 提取');
    assert(/<path/i.test(data.svg), 'SVG 未使用 <path> 轮廓渲染');
    // 生产模式（无 WINOJ_CAPTCHA_DEBUG）响应不得携带答案；debug 模式（测试专用）允许
    if (process.env.WINOJ_CAPTCHA_DEBUG !== '1') {
      assert(!('code' in data), '验证码响应泄露 code 字段');
    }
  });

  // ─────────────────────────────────────────────
  // 3. 上传文件接口认证
  // ─────────────────────────────────────────────
  await test('上传文件 GET: 未认证返回 401', async () => {
    const r = await fetch(`${BASE}/api/v1/uploads/nonexist.png`);
    assertEqual(r.status, 401, `期望 401, 实际 ${r.status}`);
  });

  await test('上传文件 GET: 路径遍历被拦截', async () => {
    const r = await fetch(`${BASE}/api/v1/uploads/..%2f..%2fpackage.json`, { headers: auth });
    // 路径校验会拒绝越界路径，返回 404（不存在）而非文件内容
    const text = await r.text();
    assert(!text.includes('"name"') || r.status === 404, `路径遍历可能成功: ${r.status}`);
  });

  // ─────────────────────────────────────────────
  // 4. SVG 上传禁用
  // ─────────────────────────────────────────────
  await test('SVG 上传: 被 fileFilter 拒绝', async () => {
    const form = new FormData();
    form.append('file', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'evil.svg');
    const r = await request('POST', '/api/v1/uploads', { headers: auth, body: form });
    assert(r.status >= 400, `SVG 上传未被拒绝: ${r.status}`);
    const text = await r.text();
    assert(!text.includes('"url"'), 'SVG 上传成功，存在存储型 XSS 风险');
  });

  // ─────────────────────────────────────────────
  // 5. magic bytes 伪装文件检测
  // ─────────────────────────────────────────────
  await test('magic bytes: 伪 PNG 文本被拒', async () => {
    const form = new FormData();
    // 内容是纯文本，扩展名伪装成 .png
    form.append('file', new Blob(['this is not a png file'], { type: 'image/png' }), 'fake.png');
    const r = await request('POST', '/api/v1/uploads', { headers: auth, body: form });
    const data = await r.json().catch(() => ({}));
    assert(data.code === 1 || r.status === 400, `伪装文件未被拦截: ${r.status} ${JSON.stringify(data)}`);
    assert(!data.url, '伪装 PNG 上传成功，magic bytes 校验失效');
  });

  // ─────────────────────────────────────────────
  // 6. JWT 旧硬编码密钥失效
  // ─────────────────────────────────────────────
  await test('JWT: 旧硬编码密钥签发的 token 被拒', async () => {
    const oldToken = jwt.sign({ userId: 1 }, 'winoj-access-secret-key-2024', { expiresIn: '1h' });
    const r = await request('GET', '/api/v1/users/me', { headers: { Authorization: `Bearer ${oldToken}` } });
    assertEqual(r.status, 401, `旧密钥 token 未被拒绝: ${r.status}`);
  });

  await test('JWT: refresh 密钥同样已更换', async () => {
    const oldRefresh = jwt.sign({ userId: 1 }, 'winoj-refresh-secret-key-2024', { expiresIn: '1h' });
    const r = await request('POST', '/api/v1/auth/refresh', {
      headers: { Cookie: `refresh_token=${oldRefresh}` }
    });
    assertEqual(r.status, 401, `旧 refresh 密钥未被拒绝: ${r.status}`);
  });

  // ─────────────────────────────────────────────
  // 7. SPJ 沙箱：阻断 require / process
  // ─────────────────────────────────────────────
  let spjProblemId = null;
  await test('SPJ 沙箱: require 被阻断（结果应为 wrong_answer）', async () => {
    // 创建 SPJ 题目: 若 require 可用则返回 true（旧 eval 行为），沙箱中 require 未定义返回 false
    const spjCode = `try { if (typeof require !== 'undefined') return true; } catch(e) {} return false;`;
    const r = await request('POST', '/api/v1/problems', {
      headers: auth,
      body: {
        title: '__SEC_TEST_SPJ__',
        description: 'security test',
        time_limit: 2000,
        memory_limit: 256,
        compare_mode: 'spj',
        spj_code: spjCode,
        is_public: false
      }
    });
    assert(r.ok, `创建 SPJ 题目失败: ${r.status}`);
    const prob = await r.json();
    spjProblemId = prob.id;

    // 添加测试点
    await request('POST', `/api/v1/problems/${spjProblemId}/testcases`, {
      headers: auth,
      body: { test_cases: [{ input_data: '1', output_data: '1', score: 100 }] }
    });

    // 提交 javascript 代码
    const sr = await request('POST', '/api/v1/submissions', {
      headers: auth,
      body: { problem_id: spjProblemId, language: 'javascript', source_code: "console.log('1');" }
    });
    assert(sr.ok, `提交失败: ${sr.status}`);
    const sdata = await sr.json();
    const sid = sdata.submission_id;
    assert(sid, '未返回提交 ID');

    const sub = await pollSubmission(sid, token);
    // 沙箱生效: require 未定义 → false → wrong_answer
    // 旧 eval: require 可用 → true → accepted
    assertEqual(sub.status, 'wrong_answer',
      `期望 wrong_answer（沙箱阻断 require），实际 ${sub.status}（沙箱可能未生效）`);
  });

  // ─────────────────────────────────────────────
  // 8. Zip Slip 路径遍历防御
  // ─────────────────────────────────────────────
  await test('Zip Slip: 恶意 ../ 条目被安全忽略', async () => {
    assert(spjProblemId, '依赖 SPJ 题目，已跳过');
    // 构造恶意 ZIP: 包含 ../evil.txt 和正常 1.in/1.out
    const zip = new AdmZip();
    zip.addFile('../evil.txt', Buffer.from('MALICIOUS'));
    zip.addFile('1.in', Buffer.from('1'));
    zip.addFile('1.out', Buffer.from('1'));
    const zipBuf = zip.toBuffer();
    const tmpZip = path.join(require('os').tmpdir(), `zipslip-${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, zipBuf);

    const form = new FormData();
    form.append('file', new Blob([zipBuf]), 'test.zip');
    const r = await fetch(`${BASE}/api/v1/problems/${spjProblemId}/testdata-zip`, {
      method: 'POST', headers: auth, body: form
    });
    // 服务器应正常响应（不崩溃）
    assert(r.status < 500, `服务器异常: ${r.status}`);

    // 验证 evil.txt 未被写入上级目录
    const parentDir = path.join(__dirname, '..', '..');
    const evilPath = path.join(parentDir, 'evil.txt');
    assert(!fs.existsSync(evilPath), 'evil.txt 被写入上级目录，Zip Slip 防御失效');

    // 清理临时文件
    try { fs.unlinkSync(tmpZip); } catch {}
  });

  // ─────────────────────────────────────────────
  // 9. SPJ 沙箱: process 访问被阻断
  // ─────────────────────────────────────────────
  await test('SPJ 沙箱: process.env 被阻断', async () => {
    assert(spjProblemId, '依赖 SPJ 题目，已跳过');
    const spjCode2 = `try { if (typeof process !== 'undefined' && process.env) return true; } catch(e) {} return false;`;
    await request('PUT', `/api/v1/problems/${spjProblemId}`, {
      headers: auth,
      body: { spj_code: spjCode2, compare_mode: 'spj' }
    });

    const sr = await request('POST', '/api/v1/submissions', {
      headers: auth,
      body: { problem_id: spjProblemId, language: 'javascript', source_code: "console.log('1');" }
    });
    const sdata = await sr.json();
    const sid = sdata.submission_id;
    const sub = await pollSubmission(sid, token);
    assertEqual(sub.status, 'wrong_answer',
      `期望 wrong_answer（process 被阻断），实际 ${sub.status}`);
  });

  // ─────────────────────────────────────────────
  // 清理测试题目
  // ─────────────────────────────────────────────
  if (spjProblemId) {
    try {
      await request('DELETE', `/api/v1/problems/${spjProblemId}`, { headers: auth });
      console.log(C.gray(`  已清理测试题目 #${spjProblemId}`));
    } catch {}
  }

  // ─────────────────────────────────────────────
  // 10. 隐私功能: 成就/看板/收藏 对其它用户保密（admin/su 始终可见）
  // ─────────────────────────────────────────────
  let privacyUserId = null;
  let privacyUserToken = null;
  let privacyUser2Token = null;

  await test('隐私: 普通用户可开启成就/看板/收藏保密开关', async () => {
    const suffix = Date.now().toString().slice(-6);
    // 创建两个普通测试用户
    const u1 = `priv${suffix}a`;
    const r1 = await request('POST', '/api/v1/users', {
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: { username: u1, password: 'Test@12345', nickname: 'PrivA' }
    });
    assert(r1.ok, `创建用户失败: ${r1.status}`);
    const d1 = await r1.json();
    privacyUserId = d1.user.id;

    const l1 = await loginWithCaptcha(u1, 'Test@12345');
    assert(l1.data.access_token, '用户1 登录失败');
    privacyUserToken = l1.data.access_token;

    const u2 = `priv${suffix}b`;
    const r2 = await request('POST', '/api/v1/users', {
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: { username: u2, password: 'Test@12345', nickname: 'PrivB' }
    });
    assert(r2.ok, `创建用户2 失败: ${r2.status}`);
    const l2 = await loginWithCaptcha(u2, 'Test@12345');
    assert(l2.data.access_token, '用户2 登录失败');
    privacyUser2Token = l2.data.access_token;

    // 用户1 开启三个开关
    const put = await request('PUT', '/api/v1/users/me', {
      headers: { Authorization: `Bearer ${privacyUserToken}`, 'Content-Type': 'application/json' },
      body: { hide_achievements: true, hide_dashboard: true, hide_favorites: true }
    });
    assert(put.ok, `PUT /me 失败: ${put.status}`);
    const putData = await put.json();
    assert(putData.hide_achievements === 1 && putData.hide_dashboard === 1 && putData.hide_favorites === 1,
      `开关未生效: ${JSON.stringify(putData)}`);
  });

  await test('隐私: 匿名访问他人成就/看板/收藏返回 401', async () => {
    for (const url of [
      `/api/v1/achievements?user_id=${privacyUserId}`,
      `/api/v1/statistics/me/stats?user_id=${privacyUserId}`,
      `/api/v1/favorites?user_id=${privacyUserId}`
    ]) {
      const r = await request('GET', url);
      assertEqual(r.status, 401, `${url} 期望 401, 实际 ${r.status}`);
    }
  });

  await test('隐私: 他人(非admin)访问保密数据返回 403', async () => {
    const h = { Authorization: `Bearer ${privacyUser2Token}` };
    for (const url of [
      `/api/v1/achievements?user_id=${privacyUserId}`,
      `/api/v1/statistics/me/stats?user_id=${privacyUserId}`,
      `/api/v1/favorites?user_id=${privacyUserId}`
    ]) {
      const r = await request('GET', url, { headers: h });
      assertEqual(r.status, 403, `${url} 期望 403, 实际 ${r.status}`);
    }
  });

  await test('隐私: 本人访问自己的保密数据返回 200', async () => {
    const h = { Authorization: `Bearer ${privacyUserToken}` };
    for (const url of [
      `/api/v1/achievements?user_id=${privacyUserId}`,
      `/api/v1/statistics/me/stats?user_id=${privacyUserId}`,
      `/api/v1/favorites?user_id=${privacyUserId}`
    ]) {
      const r = await request('GET', url, { headers: h });
      assertEqual(r.status, 200, `${url} 期望 200, 实际 ${r.status}`);
    }
  });

  await test('隐私: admin 访问他人保密数据返回 200', async () => {
    for (const url of [
      `/api/v1/achievements?user_id=${privacyUserId}`,
      `/api/v1/statistics/me/stats?user_id=${privacyUserId}`,
      `/api/v1/favorites?user_id=${privacyUserId}`
    ]) {
      const r = await request('GET', url, { headers: auth });
      assertEqual(r.status, 200, `${url} 期望 200, 实际 ${r.status}`);
    }
  });

  await test('隐私: 关闭开关后他人可访问', async () => {
    await request('PUT', '/api/v1/users/me', {
      headers: { Authorization: `Bearer ${privacyUserToken}`, 'Content-Type': 'application/json' },
      body: { hide_achievements: false, hide_dashboard: false, hide_favorites: false }
    });
    const h = { Authorization: `Bearer ${privacyUser2Token}` };
    for (const url of [
      `/api/v1/achievements?user_id=${privacyUserId}`,
      `/api/v1/statistics/me/stats?user_id=${privacyUserId}`,
      `/api/v1/favorites?user_id=${privacyUserId}`
    ]) {
      const r = await request('GET', url, { headers: h });
      assertEqual(r.status, 200, `${url} 期望 200, 实际 ${r.status}`);
    }
  });

  await test('隐私: 无效/不存在的 user_id 返回 400/404', async () => {
    const h = { Authorization: `Bearer ${privacyUser2Token}` };
    const bad = await request('GET', `/api/v1/achievements?user_id=abc`, { headers: h });
    assertEqual(bad.status, 400, `无效 user_id 期望 400, 实际 ${bad.status}`);
    const missing = await request('GET', `/api/v1/achievements?user_id=99999999`, { headers: h });
    assertEqual(missing.status, 404, `不存在用户期望 404, 实际 ${missing.status}`);
  });

  await test('隐私: profile 公开接口返回三个开关字段', async () => {
    const r = await request('GET', `/api/v1/users/${privacyUserId}/profile`);
    assert(r.ok, `profile 失败: ${r.status}`);
    const d = await r.json();
    assert('hide_achievements' in d && 'hide_dashboard' in d && 'hide_favorites' in d,
      `profile 未返回开关字段: ${Object.keys(d).join(',')}`);
  });

  // 清理隐私测试用户
  if (privacyUserId) {
    try {
      await request('DELETE', `/api/v1/users/${privacyUserId}`, { headers: auth });
      console.log(C.gray(`  已清理隐私测试用户 #${privacyUserId}`));
    } catch {}
  }

  // ─────────────────────────────────────────────
  // 10. 速率限制: login 暴力破解（放最后避免影响其他测试）
  // ─────────────────────────────────────────────
  await test('速率限制: login 超过 10 次/分钟被 429 拦截', async () => {
    let blocked = false;
    // 前面已用掉 1 次 login，再发 12 次确保触发（每次带 captcha 避免 403 干扰）
    for (let i = 0; i < 12; i++) {
      const r = await loginWithCaptcha('nonexistent_user', 'wrong');
      if (r.res.status === 429) { blocked = true; break; }
    }
    assert(blocked, '连续 12 次登录未被速率限制拦截');
  });

  // ─────────────────────────────────────────────
  // 汇总
  // ─────────────────────────────────────────────
  console.log(C.bold(C.cyan('\n═══════════════════════════════════════════════')));
  console.log(`  ${C.green(`通过 ${pass}`)}  ${C.red(`失败 ${fail}`)}  ${C.yellow(`跳过 ${skip}`)}  共 ${pass + fail + skip} 项`);
  console.log(C.bold(C.cyan('═══════════════════════════════════════════════\n')));

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(C.red(`\n[ FATAL ] ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
