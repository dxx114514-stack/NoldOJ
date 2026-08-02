(function() {
  const savedTheme = localStorage.getItem('winoj_theme') || 'light';
  if (savedTheme === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');

  const style = document.createElement('style');
  style.textContent = `
    .prose { text-align: left !important; }
    .prose p, .prose div, .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 { text-align: left !important; }
    .prose ul, .prose ol, .prose blockquote, .prose pre, .prose code { text-align: left !important; }
    textarea, input[type="text"], input:not([type]) { text-align: left !important; }
    .dark .katex, .dark .katex .mord, .dark .katex-display .katex { color: #e5e7eb !important; }
    .dark .katex .mtext { color: #d1d5db !important; }
    .dark .prose hr { border-color: #374151; }
    .dark .prose blockquote { border-color: #4b5563; color: #d1d5db; background-color: #1f2937; padding: 0.5rem 1rem; border-left-width: 4px; }
    .dark .prose table { color: #e5e7eb; border-color: #374151; border-collapse: collapse; }
    .dark .prose table th { background-color: #1f2937; border-color: #374151; padding: 0.5rem 0.75rem; border-width: 1px; }
    .dark .prose table td { border-color: #374151; padding: 0.5rem 0.75rem; border-width: 1px; }
    .dark .prose ol, .dark .prose ul { color: #e5e7eb; }
    .dark .prose ol li, .dark .prose ul li { margin: 0.25rem 0; }
    .dark .prose pre { color: #e5e7eb; background-color: #1f2937 !important; border: 1px solid #374151; }
    .dark .prose p { color: #e5e7eb; margin: 0.5rem 0; }
    .dark .prose strong { color: #f9fafb; }
    .dark .prose em { color: #e5e7eb; }
  `;
  document.head.appendChild(style);
})();

function toggleDarkMode() {
  const html = document.documentElement;
  const isDark = html.classList.toggle('dark');
  localStorage.setItem('winoj_theme', isDark ? 'dark' : 'light');
  document.querySelectorAll('.dark-toggle-icon').forEach(icon => {
    icon.classList.toggle('hidden');
  });
}

const API_BASE = '/api/v1';

let refreshPromise = null;

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setToken(data.access_token);
        return data.access_token;
      }
      if (res.status === 403) {
        throw { status: 403, message: '账号已被封禁' };
      }
      throw { status: 401, message: 'Refresh failed' };
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function getToken() {
  return localStorage.getItem('access_token');
}

function setToken(token) {
  localStorage.setItem('access_token', token);
}

function isTokenExpired() {
  const token = getToken();
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch { return true; }
}

function clearToken() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('user');
  const navEl = document.getElementById('nav');
  if (navEl && typeof renderNav === 'function') {
    const pathName = window.location.pathname;
    const page = pathName.split('/').pop().replace('.html', '');
    navEl.innerHTML = renderNav(page);
  }
}

function getUser() {
  const u = localStorage.getItem('user');
  return u ? JSON.parse(u) : null;
}

function setUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

async function refreshUser() {
  try {
    const u = await apiCall('GET', '/users/me');
    if (u) {
      setUser({ id: u.id, username: u.username, nickname: u.nickname, role: u.role, rating: u.rating, preferred_language: u.preferred_language || '' });
      const navEl = document.getElementById('nav');
      if (navEl && typeof renderNav === 'function') {
        const pathName = window.location.pathname;
        const page = pathName.split('/').pop().replace('.html', '');
        navEl.innerHTML = renderNav(page);
      }
    }
    return u;
  } catch { return null; }
}

async function refreshRating() {
  try {
    const u = await apiCall('GET', '/users/me');
    if (u) {
      setUser({ id: u.id, username: u.username, nickname: u.nickname, role: u.role, rating: u.rating, preferred_language: u.preferred_language || '' });
      const el = document.getElementById('nav-rating');
      if (el) el.textContent = `R:${u.rating || 1500}`;
    }
  } catch {}
}

setInterval(() => { if (getToken()) refreshRating(); }, 30000);

async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers, credentials: 'include' };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, opts);
  } catch (e) {
    throw { status: 0, message: 'Network error' };
  }
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401 && data.reason === 'ERR_UNAUTHORIZED') {
    try {
      const newToken = await refreshAccessToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryRes = await fetch(`${API_BASE}${path}`, { method, headers, credentials: 'include', body: opts.body });
      const retryData = await retryRes.json().catch(() => ({}));
      if (!retryRes.ok) throw { status: retryRes.status, ...retryData };
      if (path !== '/users/me') refreshUser().catch(() => {});
      return retryData;
    } catch (e) {
      if (e && e.status === 403 && e.message === '账号已被封禁') {
        clearToken();
        if (window.location.pathname !== '/pages/login.html') window.location.href = '/pages/login.html';
        throw e;
      }
      if (e && e.status !== undefined && e.status !== 401) throw e;
    }
    clearToken();
    if (window.location.pathname !== '/pages/login.html') window.location.href = '/pages/login.html';
    throw data;
  }
  if (res.status === 403 && data.reason === 'ERR_FORBIDDEN') {
    clearToken();
    if (window.location.pathname !== '/pages/login.html') window.location.href = '/pages/login.html';
    throw { status: 403, message: data.message || '账号已被封禁' };
  }
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function statusColor(status) {
  const colors = {
    accepted: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30',
    wrong_answer: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30',
    time_limit_exceeded: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30',
    memory_limit_exceeded: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30',
    runtime_error: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30',
    compile_error: 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/30',
    system_error: 'text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700',
    pending: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    running: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    judging: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    compiling: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    pending_review: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    pending_rejudge: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    skipped: 'text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
  };
  return colors[status] || 'text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700';
}

function statusText(status) {
  const texts = {
    accepted: '通过',
    wrong_answer: '答案错误',
    time_limit_exceeded: '时间超限',
    memory_limit_exceeded: '内存超限',
    runtime_error: '运行错误',
    compile_error: '编译错误',
    system_error: '系统错误',
    pending: '等待中',
    running: '运行中',
    judging: '评测中',
    compiling: '编译中',
    pending_rejudge: '等待重测',
    pending_review: '审查中',
    skipped: '已跳过',
  };
  return texts[status] || status;
}

function roleBadge(role) {
  const badges = {
    user: '<span class="px-2 py-1 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">用户</span>',
    teacher: '<span class="px-2 py-1 text-xs rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">教师</span>',
    admin: '<span class="px-2 py-1 text-xs rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">管理员</span>',
    su: '<span class="px-2 py-1 text-xs rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">超级管理员</span>',
  };
  return badges[role] || '';
}

function renderNav(activePage) {
  try {
    const user = getUser();
    const isAdmin = user && ['admin', 'su'].includes(user.role);
    const isSu = user && user.role === 'su';
    const isTeacher = user && ['teacher', 'admin', 'su'].includes(user.role);

    const isDark = document.documentElement.classList.contains('dark');
    const sunIcon = `<svg class="w-5 h-5 dark-toggle-icon ${isDark ? 'hidden' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>`;
    const moonIcon = `<svg class="w-5 h-5 dark-toggle-icon ${isDark ? '' : 'hidden'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>`;

    return `
    <nav class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-14">
          <div class="flex items-center space-x-8">
            <a href="/pages/index.html" class="flex items-center space-x-2">
              <svg class="w-7 h-7 text-indigo-600 dark:text-indigo-400" fill="currentColor" viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
              <span class="text-xl font-bold text-gray-900 dark:text-white">WinOJ</span>
            </a>
            <div class="hidden md:flex space-x-1">
              <a href="/pages/problems.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='problems'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">题库</a>
              <a href="/pages/submissions.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='submissions'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">提交记录</a>
              <a href="/pages/articles.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='articles'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">文章</a>
              <a href="/pages/announcements.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='announcements'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">公告</a>
              <a href="/pages/ide.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='ide'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">在线编程</a>
              ${isTeacher ? `<a href="/pages/upload.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='upload'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">图床</a>` : ''}
              <a href="/pages/rating.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='rating'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">排行</a>
              <a href="/pages/contests.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='contests'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">比赛</a>
              ${isTeacher ? `<a href="/pages/admin.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='admin'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">管理</a>` : ''}
              ${isSu ? `<a href="/pages/languages.html" class="px-3 py-2 rounded-md text-sm font-medium ${activePage==='languages'?'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300':'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}">语言</a>` : ''}
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <button onclick="toggleDarkMode()" class="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" title="切换主题">
              ${sunIcon}${moonIcon}
            </button>
            ${user ? `
              <div class="flex items-center space-x-3">
                <span class="text-sm text-gray-700 dark:text-gray-300">${escapeHtml(user.nickname || user.username || '')}</span>
                <span id="nav-rating" class="px-1.5 py-0.5 text-xs rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300">R:${user.rating || 1500}</span>
                ${roleBadge(user.role)}
                <a href="/pages/profile.html" class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">资料</a>
                <button onclick="showPasswordModal()" class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">设置</button>
                <button onclick="logout()" class="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300">退出</button>
              </div>
            ` : `
              <a href="/pages/login.html" class="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium">登录</a>
              <a href="/pages/register.html" class="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 font-medium">注册</a>
            `}
          </div>
        </div>
      </div>
    </nav>
    <div id="passwordModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-full max-w-md">
        <h3 class="text-lg font-semibold mb-4 text-gray-900 dark:text-white">修改密码</h3>
        <input id="oldPwd" type="password" placeholder="当前密码" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg mb-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
        <input id="newPwd" type="password" placeholder="新密码" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg mb-4 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
        <div class="flex justify-end space-x-3">
          <button onclick="closePasswordModal()" class="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">取消</button>
          <button onclick="changePassword()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存</button>
        </div>
      </div>
    </div>`;
  } catch(e) {
    console.error('renderNav error:', e);
    return `<nav class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50"><div class="max-w-7xl mx-auto px-4 h-14 flex items-center"><a href="/pages/index.html" class="text-xl font-bold text-gray-900 dark:text-white">WinOJ</a></div></nav>`;
  }
}

function showPasswordModal() { document.getElementById('passwordModal').classList.remove('hidden'); }
function closePasswordModal() { document.getElementById('passwordModal').classList.add('hidden'); }

async function changePassword() {
  const old_password = document.getElementById('oldPwd').value;
  const new_password = document.getElementById('newPwd').value;
  try {
    await apiCall('POST', '/auth/change-password', { old_password, new_password });
    alert('密码修改成功');
    closePasswordModal();
  } catch (e) {
    alert(e.message || '密码修改失败');
  }
}

async function logout() {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        credentials: 'include'
      });
    } catch {}
  }
  clearToken();
  window.location.href = '/pages/index.html';
}
