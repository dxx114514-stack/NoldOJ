// Debug login flow - test captcha + login
const BASE = 'http://localhost:3000/api/v1';

async function main() {
  // 1. Get captcha
  console.log('=== 1. Get captcha ===');
  const captchaRes = await fetch(`${BASE}/auth/captcha`);
  const captchaData = await captchaRes.json();
  console.log('Captcha ID:', captchaData.id);

  // Read answer from debug file
  const fs = require('fs');
  const path = require('path');
  const answersFile = path.join(__dirname, '..', '..', 'config', 'captcha_answers.json');
  const answers = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
  const captchaCode = answers[captchaData.id];
  console.log('Captcha answer (from debug file):', captchaCode);

  // 2. Try login with admin/admin123 and the correct captcha
  console.log('\n=== 2. Login attempt with correct password ===');
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'admin123',
      captcha_id: captchaData.id,
      captcha_code: captchaCode
    })
  });
  console.log('Status:', loginRes.status, loginRes.statusText);
  const loginData = await loginRes.json();
  console.log('Response:', JSON.stringify(loginData, null, 2));

  if (loginRes.ok) {
    console.log('\n=== LOGIN SUCCESS ===');
    console.log('Access token (first 50 chars):', loginData.access_token?.substring(0, 50));
    console.log('User:', JSON.stringify(loginData.user));
  } else {
    console.log('\n=== LOGIN FAILED ===');
    console.log('Error reason:', loginData.reason);
    console.log('Error message:', loginData.message);
  }

  // 3. Try login with WRONG password (to test error handling)
  console.log('\n=== 3. Login attempt with WRONG password ===');
  // Get a fresh captcha first
  const captcha2Res = await fetch(`${BASE}/auth/captcha`);
  const captcha2Data = await captcha2Res.json();
  const answers2 = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
  const captcha2Code = answers2[captcha2Data.id];
  console.log('Captcha 2 ID:', captcha2Data.id, 'answer:', captcha2Code);

  const login2Res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'wrongpassword',
      captcha_id: captcha2Data.id,
      captcha_code: captcha2Code
    })
  });
  console.log('Status:', login2Res.status, login2Res.statusText);
  const login2Data = await login2Res.json();
  console.log('Response:', JSON.stringify(login2Data, null, 2));

  // 4. Try login with WRONG captcha
  console.log('\n=== 4. Login attempt with WRONG captcha ===');
  const captcha3Res = await fetch(`${BASE}/auth/captcha`);
  const captcha3Data = await captcha3Res.json();
  console.log('Captcha 3 ID:', captcha3Data.id, '(will send wrong code)');

  const login3Res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'admin123',
      captcha_id: captcha3Data.id,
      captcha_code: 'XXXX'  // wrong code
    })
  });
  console.log('Status:', login3Res.status, login3Res.statusText);
  const login3Data = await login3Res.json();
  console.log('Response:', JSON.stringify(login3Data, null, 2));

  // 5. Try login with EMPTY captcha fields
  console.log('\n=== 5. Login attempt with EMPTY captcha fields ===');
  const login4Res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'admin123'
    })
  });
  console.log('Status:', login4Res.status, login4Res.statusText);
  const login4Data = await login4Res.json();
  console.log('Response:', JSON.stringify(login4Data, null, 2));
}

main().catch(err => {
  console.error('Test script error:', err);
});
