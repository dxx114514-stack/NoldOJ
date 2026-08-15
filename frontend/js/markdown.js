function renderMarkdown(text) {
  if (!text) return '';
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // C-3: 输出统一过 DOMPurify 清洗（白名单），无 DOMPurify 时 fail-closed 转义为纯文本
  function sanitizeHtml(html) {
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return escapeHtml(html);
  }
  function fixUrl(url) {
    if (!url) return '';
    url = String(url).replace(/&amp;/g, '&');
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/')) {
      return url;
    }
    return '/';
  }
  try {
    let html = text
      .replace(/\$\$\n?([\s\S]*?)\n?\$\$/g, (_, m) => `<div class="katex-display my-4 text-center">\\[${escapeHtml(m.trim())}\\]</div>`)
      .replace(/\$(.+?)\$/g, (_, m) => `\\(${escapeHtml(m)}\\)`)
      .replace(/@\[bilibili\]\((BV[a-zA-Z0-9]+)\)/g, (_, bv) => `<div class="my-4"><iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bv)}&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" class="w-full aspect-video rounded-lg"></iframe></div>`)
      .replace(/@\[url\]\(([^)]+)\)/g, (_, url) => `<div class="my-4"><iframe src="${escapeHtml(fixUrl(url))}" class="w-full min-h-[500px] rounded-lg border border-gray-200 dark:border-gray-600"></iframe></div>`)
      .replace(/@\[audio\]\(([^)]+)\)/g, (_, url) => `<div class="my-3"><audio controls class="w-full" src="${escapeHtml(fixUrl(url))}"></audio></div>`)
      .replace(/@\[video\]\(([^)]+)\)/g, (_, url) => `<div class="my-4"><video controls class="w-full rounded-lg" src="${escapeHtml(fixUrl(url))}"></video></div>`)
      .replace(/^### (.+)$/gm, (_, m) => `<h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2">${escapeHtml(m)}</h3>`)
      .replace(/^## (.+)$/gm, (_, m) => `<h2 class="text-xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3">${escapeHtml(m)}</h2>`)
      .replace(/^# (.+)$/gm, (_, m) => `<h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3">${escapeHtml(m)}</h1>`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${escapeHtml(fixUrl(url))}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 underline">${escapeHtml(label)}</a>`)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => `<img src="${escapeHtml(fixUrl(url))}" alt="${escapeHtml(alt)}" class="max-w-full rounded-lg my-2 border border-gray-200 dark:border-gray-700">`)
      .replace(/\*\*(.+?)\*\*/g, (_, m) => `<strong class="text-gray-900 dark:text-gray-100 font-semibold">${escapeHtml(m)}</strong>`)
      .replace(/\*(.+?)\*/g, (_, m) => `<em class="text-gray-800 dark:text-gray-200 italic">${escapeHtml(m)}</em>`)
      .replace(/~~(.+?)~~/g, (_, m) => `<del class="text-gray-500 dark:text-gray-400">${escapeHtml(m)}</del>`)
      .replace(/`([^`]+)`/g, (_, m) => `<code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm font-mono text-red-600 dark:text-red-400 border border-gray-200 dark:border-gray-600">${escapeHtml(m)}</code>`)
      .replace(/\n\n/g, '</p><p class="mt-3">')
      .replace(/\n/g, '<br>');
    return `<div class="prose prose-sm dark:prose-invert max-w-none text-left text-gray-700 dark:text-gray-200 leading-relaxed"><p>${sanitizeHtml(html)}</p></div>`;
  } catch (e) {
    return `<pre class="text-sm text-gray-700 dark:text-gray-200">${escapeHtml(text)}</pre>`;
  }
}