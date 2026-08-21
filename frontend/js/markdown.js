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
  // R11-?: DOMPurify 默认白名单不含 iframe，@[url]/@[bilibili] 生成的 iframe 会被整段剥掉
  // 导致内嵌网页无法渲染（与 CORS 无关）。显式放行 iframe 及安全属性；src 仍受限
  // （fixUrl 仅允许 http/https/ 相对路径），javascript:/事件属性/嵌套脚本由 DOMPurify 兜底剥离。
  function sanitizeHtml(html) {
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_TAGS: ['iframe'],
        ADD_ATTR: ['allowfullscreen', 'scrolling', 'frameborder', 'framespacing', 'border', 'width', 'height', 'loading']
      });
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
    // ── 块级/富内容嵌入: 占位符策略 ──────────────────────────
    // @[office]/@[echarts]/@[mermaid] 先提取为 \x00N\x00 占位符, 防止其内容被后续
    // markdown 行内规则(-->/[x]/**等)破坏; sanitize 后回填(DOMPurify 放行 data-* 与 class)。
    const embeds = [];
    function stash(html) { embeds.push(html); return '\u0000' + (embeds.length - 1) + '\u0000'; }

    let html = text
      // Office 文档预览: 微软 Office Online 渲染, 文档 URL 需公网可访问(如图床)
      .replace(/@\[office\]\(([^)\s]+)\)/g, (_, raw) => {
        const url = fixUrl(raw);
        if (!/^https:\/\//i.test(url)) return '<div class="my-3 text-sm text-gray-500 dark:text-gray-400">[office] 仅支持公网 https 文档地址</div>';
        return stash('<div class="my-4"><iframe src="' + escapeHtml('https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(url)) + '" class="w-full rounded-lg border border-gray-200 dark:border-gray-600" height="600" loading="lazy"></iframe></div>');
      })
      // ECharts 图表: 参数为 JSON 配置, 解析失败降级为代码块; 渲染由文件尾部增强器完成
      .replace(/@\[echarts\]\((.+)\)/g, (_, json) => {
        const raw = json.trim().replace(/\)+$/, '');
        let cfg = null;
        try { cfg = JSON.parse(raw); } catch (e) { cfg = null; }
        if (!cfg || typeof cfg !== 'object') return '<pre class="my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto text-gray-700 dark:text-gray-300">' + escapeHtml('[echarts] JSON 配置无效:\n' + raw.slice(0, 2000)) + '</pre>';
        return stash('<div class="my-4 oj-echarts" data-config="' + escapeHtml(JSON.stringify(cfg)) + '"><div class="oj-echarts-loading text-sm text-gray-400 dark:text-gray-500 py-16 text-center">图表加载中…</div></div>');
      })
      // Mermaid 图表: 块级跨行语法, 结束标记 @[/mermaid]; 内容原样转义存放, 渲染由增强器完成
      .replace(/@\[mermaid\][ \t]*\n([\s\S]*?)\n?@\[\/mermaid\][ \t]*(?:\n|$)/g, (_, body) => {
        return stash('<pre class="oj-mermaid my-4 text-center">' + escapeHtml(body.trim()) + '</pre>');
      })
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
    let out = sanitizeHtml(html);
    // 回填嵌入块(sanitize 后): DOMPurify 已放行 iframe/data-*/class; 若被意外剥离则跳过
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => embeds[+i] !== undefined ? embeds[+i] : '');
    return `<div class="prose prose-sm dark:prose-invert max-w-none text-left text-gray-700 dark:text-gray-200 leading-relaxed"><p>${out}</p></div>`;
  } catch (e) {
    return `<pre class="text-sm text-gray-700 dark:text-gray-200">${escapeHtml(text)}</pre>`;
  }
}

// ══ 富内容嵌入渲染增强器(echarts / mermaid) ══════════════════════════
// renderMarkdown 输出插入 DOM 后, 由 MutationObserver 自动发现占位并懒加载 CDN 库渲染。
// 全站页面零改动; CSP scriptSrc 已放行 cdn.jsdelivr.net(KaTeX 同源惯例)。
(function () {
  if (typeof window === 'undefined' || !document.body) {
    if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', boot);
    else return;
  } else boot();

  var loaded = {};
  function ensureLib(src, check, cb) {
    if (check()) { cb(); return; }
    var s = document.querySelector('script[data-oj-lib="' + src + '"]');
    if (s) { s.addEventListener('oj-load', function () { cb(); }); return; }
    s = document.createElement('script');
    s.src = src;
    s.setAttribute('data-oj-lib', src);
    s.crossOrigin = 'anonymous';
    s.onload = function () { s.dispatchEvent(new Event('oj-load')); cb(); };
    s.onerror = function () { s.dispatchEvent(new Event('oj-load')); };
    document.head.appendChild(s);
  }

  function failNode(el, msg) {
    el.removeAttribute('data-config');
    el.innerHTML = '<div class="text-sm text-gray-400 dark:text-gray-500 py-10 text-center">' + msg + '</div>';
  }

  function renderEcharts(el) {
    el.setAttribute('data-done', '1');
    var raw = el.getAttribute('data-config');
    if (!raw) return;
    var cfg = null;
    try { cfg = JSON.parse(raw); } catch (e) { cfg = null; }
    if (!cfg) { failNode(el, '图表配置解析失败'); return; }
    ensureLib(
      'https://cdn.jsdelivr.net/npm/echarts@5.15.0/dist/echarts.min.js',
      function () { return typeof window.echarts !== 'undefined'; },
      function () {
        if (typeof window.echarts === 'undefined') { failNode(el, '图表库加载失败(检查网络或广告拦截)'); return; }
        el.textContent = '';
        var h = parseInt(cfg.height, 10);
        el.style.height = (h > 80 && h < 2000 ? h : 380) + 'px';
        delete cfg.height;
        try {
          var chart = window.echarts.init(el);
          chart.setOption(cfg);
          window.addEventListener('resize', function () { chart.resize(); });
        } catch (e) {
          failNode(el, '图表渲染失败');
        }
      }
    );
  }

  function renderMermaid(el) {
    el.setAttribute('data-done', '1');
    var src = el.textContent;
    if (!src.trim()) { el.remove(); return; }
    ensureLib(
      'https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js',
      function () { return typeof window.mermaid !== 'undefined'; },
      function () {
        if (typeof window.mermaid === 'undefined') { el.textContent = '流程图库加载失败(检查网络或广告拦截)'; el.className = 'my-4 text-center text-sm text-gray-400 dark:text-gray-500'; return; }
        try {
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
          var id = 'oj-mmd-' + Math.random().toString(36).slice(2, 9);
          window.mermaid.render(id, src, function (svg) {
            el.outerHTML = '<div class="oj-mermaid-svg my-4 overflow-x-auto">' + svg + '</div>';
          });
        } catch (e) {
          el.className = 'my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto text-left text-gray-700 dark:text-gray-300';
          el.textContent = '[mermaid] 语法错误:\n' + String(e && e.message || e);
        }
      }
    );
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    var charts = root.matches && root.matches('.oj-echarts:not([data-done])') ? [root] : [];
    var mermaids = root.matches && root.matches('.oj-mermaid:not([data-done])') ? [root] : [];
    if (root.querySelectorAll) {
      charts = charts.concat(Array.prototype.slice.call(root.querySelectorAll('.oj-echarts:not([data-done])')));
      mermaids = mermaids.concat(Array.prototype.slice.call(root.querySelectorAll('.oj-mermaid:not([data-done])')));
    }
    for (var i = 0; i < charts.length; i++) renderEcharts(charts[i]);
    for (var j = 0; j < mermaids.length; j++) renderMermaid(mermaids[j]);
  }

  function boot() {
    // 嵌入容器基础样式(一次性注入)
    if (!document.getElementById('oj-embed-style')) {
      var st = document.createElement('style');
      st.id = 'oj-embed-style';
      st.textContent = '.oj-echarts{width:100%;min-height:200px;border-radius:8px}.oj-mermaid{background:transparent}';
      document.head.appendChild(st);
    }
    scan(document.body);
    if (typeof MutationObserver === 'undefined') return; // 极旧环境降级: 仅首屏扫描, 不自动增强后续插入
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) scan(added[j]);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
