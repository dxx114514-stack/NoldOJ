function renderMarkdown(text) {
  if (!text) return '';
  function fixUrl(url) {
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/')) return url;
    return '/' + url;
  }
  try {
    let html = text
      .replace(/\$\$\n?([\s\S]*?)\n?\$\$/g, (_, m) => `<div class="katex-display my-4 text-center">\\[${m.trim()}\\]</div>`)
      .replace(/\$(.+?)\$/g, (_, m) => `\\(${m}\\)`)
      .replace(/@\[bilibili\]\((BV[a-zA-Z0-9]+)\)/g, '<div class="my-4"><iframe src="https://player.bilibili.com/player.html?bvid=$1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" class="w-full aspect-video rounded-lg"></iframe></div>')
      .replace(/@\[url\]\(([^)]+)\)/g, (_, url) => `<div class="my-4"><iframe src="${fixUrl(url)}" class="w-full min-h-[500px] rounded-lg border border-gray-200 dark:border-gray-600"></iframe></div>`)
      .replace(/@\[audio\]\(([^)]+)\)/g, (_, url) => `<div class="my-3"><audio controls class="w-full" src="${fixUrl(url)}"></audio></div>`)
      .replace(/@\[video\]\(([^)]+)\)/g, (_, url) => `<div class="my-4"><video controls class="w-full rounded-lg" src="${fixUrl(url)}"></video></div>`)
      .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3">$1</h1>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 underline">$1</a>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="max-w-full rounded-lg my-2 border border-gray-200 dark:border-gray-700">')
      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em class="text-gray-800 dark:text-gray-200 italic">$1</em>')
      .replace(/~~(.+?)~~/g, '<del class="text-gray-500 dark:text-gray-400">$1</del>')
      .replace(/`([^`]+)`/g, '<code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm font-mono text-red-600 dark:text-red-400 border border-gray-200 dark:border-gray-600">$1</code>')
      .replace(/\n\n/g, '</p><p class="mt-3">')
      .replace(/\n/g, '<br>');
    return `<div class="prose prose-sm dark:prose-invert max-w-none text-left text-gray-700 dark:text-gray-200 leading-relaxed"><p>${html}</p></div>`;
  } catch (e) {
    return `<pre class="text-sm text-gray-700 dark:text-gray-200">${escapeHtml(text)}</pre>`;
  }
}

function renderMarkdownBlock(text) {
  if (!text) return '<p class="text-gray-400 dark:text-gray-500 italic">暂无内容</p>';
  return renderMarkdown(text);
}

function renderMathInElement(container) {
  if (typeof katex === 'undefined') return;
  try {
    const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walk.nextNode()) nodes.push(walk.currentNode);
    for (const node of nodes) {
      const text = node.textContent;
      if (!text.includes('\\(') && !text.includes('\\[')) continue;
      const span = document.createElement('span');
      span.innerHTML = text.replace(/\\\((.+?)\\\)/g, (_, tex) => {
        try { return katex.renderToString(tex, { throwOnError: false }); } catch { return tex; }
      }).replace(/\\\[(.+?)\\\]/gs, (_, tex) => {
        try { return katex.renderToString(tex, { displayMode: true, throwOnError: false }); } catch { return tex; }
      });
      node.parentNode.replaceChild(span, node);
    }
  } catch {}
}
