// Full flow test: login → change password → try to login with new password
// Simulates the exact frontend apiCall behavior including the 401 refresh logic
const BASE = 'http://localhost:3000/api/v1';
const fs = require('fs');
const path = require('path');

let accessToken = null;
let refreshTokenCookie = null;

function getAnswers() {
  const answersFile = path.join(__dirname, '..', '..', 'config', 'captcha_answers.json');
  return JSON.parse(fs.readFileSync(answersFile, 'utf8'));
}

async function getCaptcha() {
  const res = await fetch(`${BASE}/auth/captcha`);
  const data = await res.json();
  const answers = getAnswers();
  return { id: data.id, code: answers[data.id] };
}

// Simulate frontend apiCall behavior
async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const opts = { method, headers, credentials: 'include' };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    throw { status: 0, message: 'Network error' };
  }

  // Capture Set-Cookie for refresh_token
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && setCookie.includes('refresh_token=')) {
    refreshTokenCookie = setCookie.split('refresh_token=')[1].split(';')[0];
  }

  let data;
  try { data = await res.json(); } catch { data = {}; }

  // Simulate frontend 401 handler
  if (res.status === 401 && data.reason === 'ERR_UNAUTHORIZED') {
    console.log(`  [apiCall] Got 401, trying refresh...`);
    try {
      const refreshRes = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        console.log(`  [apiCall] Refresh SUCCESS, retrying original request...`);
        accessToken = refreshData.access_token;
        headers['Authorization'] = `Bearer ${accessToken}`;
        const retryRes = await fetch(`${BASE}${path}`, { method, headers, credentials: 'include', body: opts.body });
        const retryData = await retryRes.json().catch(() => ({}));
        if (!retryRes.ok) throw { status: retryRes.status, ...retryData };
        return retryData;
      } else {
        const refreshData = await refreshRes.json().catch(() => ({}));
        console.log(`  [apiCall] Refresh FAILED: ${refreshRes.status}`, refreshData);
        throw { status: refreshRes.status, ...refreshData };
      }
    } catch (e) {
      console.log(`  [apiCall] Refresh exception:`, e);
      if (e && e.status === 403 && e.message === '账号已被封禁') {
        throw e;
      }
      if (e && e.status !== undefined && e.status !== 401) throw e;
    }
    console.log(`  [apiCall] Refresh failed with 401, throwing original data:`, data);
    throw data;
  }

  if (res.status === 403 && data.reason === 'ERR_FORBIDDEN') {
    throw { status: 403, message: data.message || '账号已被封禁' };
  }

  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

async function login(username, password) {
  const captcha = await getCaptcha();
  console.log(`  Login: captcha=${captcha.id}, code=${captcha.code}`);
  try {
    const data = await apiCall('POST', '/auth/login', {
      username,
      password,
      captcha_id: captcha.id,
      captcha_code: captcha.code
    });
    accessToken = data.access_token;
    console.log(`  Login SUCCESS: token=${accessToken?.substring(0, 30)}...`);
    return data;
  } catch (err) {
    console.log(`  Login FAILED:`, err);
    throw err;
  }
}

async function main() {
  const OLD_PASSWORD = 'admin123';
  const NEW_PASSWORD = 'newpass456';

  console.log('=========================================');
  console.log('STEP 1: Login as admin with old password');
  console.log('=========================================');
  await login('admin', OLD_PASSWORD);

  console.log('\n=========================================');
  console.log('STEP 2: Change password');
  console.log('=========================================');
  try {
    const result = await apiCall('POST', '/auth/change-password', {
      old_password: OLD_PASSWORD,
      new_password: NEW_PASSWORD
    });
    console.log('  Change password result:', result);
  } catch (err) {
    console.log('  Change password FAILED:', err);
    return;
  }

  console.log('\n=========================================');
  console.log('STEP 3: Try to access protected endpoint with OLD token');
  console.log('=========================================');
  try {
    const me = await apiCall('GET', '/users/me');
    console.log('  /users/me result:', me);
  } catch (err) {
    console.log('  /users/me FAILED (expected after password change):', err);
    // After this fails, frontend would clear token and redirect to login
    accessToken = null;
  }

  console.log('\n=========================================');
  console.log('STEP 4: Login with NEW password');
  console.log('=========================================');
  try {
    await login('admin', NEW_PASSWORD);
    console.log('\n  >>> LOGIN WITH NEW PASSWORD SUCCEEDED <<<');
  } catch (err) {
    console.log('\n  >>> LOGIN WITH NEW PASSWORD FAILED <<<');
    console.log('  Error:', err);
  }

  console.log('\n=========================================');
  console.log('STEP 5: Reset password back to old');
  console.log('=========================================');
  try {
    const result = await apiCall('POST', '/auth/change-password', {
      old_password: NEW_PASSWORD,
      new_password: OLD_PASSWORD
    });
    console.log('  Reset result:', result);
  } catch (err) {
    console.log('  Reset FAILED:', err);
  }
}

main().catch(err => {
  console.error('Test script error:', err);
});
