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
  // 属性值上下文: 额外转义反引号, 防止 attribute 中的 ` 干扰代码段规则
  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
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
    // 围栏代码块 / @[office] / @[echarts] / @[mermaid] / @[url] / 公式 先提取为 \x00N\x00
    // 占位符, 防止其内容被后续行内规则(-- / * / [x] / $)破坏; sanitize 之后回填
    // (DOMPurify 放行 data-* 与 class), 因此嵌入块不参与 escape 与 * 清理。
    const embeds = [];
    function stash(html) { embeds.push(html); return '\uE000' + (embeds.length - 1) + '\uE001'; }

    // 行内斜体单独占位: 单趟分词阶段避免 \* 与 \*\* 互相干扰, 清理后回填
    const italics = [];
    function stashItalic(html) { italics.push(html); return '\uE000I' + (italics.length - 1) + '\uE001'; }

    const headingCls = {
      1: 'text-2xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3',
      2: 'text-xl font-bold text-gray-900 dark:text-gray-100 mt-6 mb-3',
      3: 'text-lg font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2',
      4: 'text-base font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2',
      5: 'text-sm font-semibold text-gray-900 dark:text-gray-100 mt-3 mb-1',
      6: 'text-sm font-medium text-gray-700 dark:text-gray-300 mt-3 mb-1'
    };

    let t = String(text).replace(/\r\n?/g, '\n');

    // ── Stage 1: 需要整体保护的片段先抽成占位符 ──────────────
    // 围栏代码块(内容完全原样, 不参与任何后续规则)
    t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => stash(
      '<pre class="my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto"><code class="text-gray-700 dark:text-gray-300">' +
      escapeHtml(body.replace(/\n$/, '')) + '</code></pre>'));
    // Mermaid 图表: 块级跨行语法, 结束标记 @[/mermaid]; 内容原样转义存放, 渲染由增强器完成
    t = t.replace(/@\[mermaid\][ \t]*\n([\s\S]*?)\n?@\[\/mermaid\][ \t]*(?:\n|$)/g, (_, body) =>
      stash('<pre class="oj-mermaid my-4 text-center">' + escapeHtml(body.trim()) + '</pre>'));
    // Office 文档预览: 微软 Office Online 渲染, 文档 URL 需公网可访问(如图床)
    t = t.replace(/@\[office\]\(([^)\s]+)\)/g, (_, raw) => {
      const url = fixUrl(raw);
      if (!/^https:\/\//i.test(url)) return stash('<div class="my-3 text-sm text-gray-500 dark:text-gray-400">[office] 仅支持公网 https 文档地址</div>');
      return stash('<div class="my-4"><iframe src="' + escapeHtml('https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(url)) + '" class="w-full rounded-lg border border-gray-200 dark:border-gray-600" height="600" loading="lazy"></iframe></div>');
    });
    // ECharts 图表: 参数为 JSON 配置, 解析失败降级为代码块; 渲染由文件尾部增强器完成
    t = t.replace(/@\[echarts\]\((.+)\)/g, (_, json) => {
      const raw = json.trim().replace(/\)+$/, '');
      let cfg = null;
      try { cfg = JSON.parse(raw); } catch (e) { cfg = null; }
      if (!cfg || typeof cfg !== 'object') return stash('<pre class="my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto text-gray-700 dark:text-gray-300">' + escapeHtml('[echarts] JSON 配置无效:\n' + raw.slice(0, 2000)) + '</pre>');
      return stash('<div class="my-4 oj-echarts" data-config="' + escapeHtml(JSON.stringify(cfg)) + '"><div class="oj-echarts-loading text-sm text-gray-400 dark:text-gray-500 py-16 text-center">图表加载中…</div></div>');
    });
    t = t.replace(/@\[bilibili\]\((BV[a-zA-Z0-9]+)\)/g, (_, bv) => stash('<div class="my-4"><iframe src="https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bv) + '&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" class="w-full aspect-video rounded-lg"></iframe></div>'));
    t = t.replace(/@\[url\]\(([^)]+)\)/g, (_, url) => stash('<div class="my-4"><iframe src="' + escapeHtml(fixUrl(url)) + '" class="w-full min-h-[500px] rounded-lg border border-gray-200 dark:border-gray-600"></iframe></div>'));
    t = t.replace(/@\[audio\]\(([^)]+)\)/g, (_, url) => stash('<div class="my-3"><audio controls class="w-full" src="' + escapeHtml(fixUrl(url)) + '"></audio></div>'));
    t = t.replace(/@\[video\]\(([^)]+)\)/g, (_, url) => stash('<div class="my-4"><video controls class="w-full rounded-lg" src="' + escapeHtml(fixUrl(url)) + '"></video></div>'));
    // 展示公式(可跨行)必须先于行内公式, 否则 $$ 会被拆成两个 $...$
    t = t.replace(/\$\$\n?([\s\S]*?)\n?\$\$/g, (_, m) => stash('<div class="katex-display my-4 text-center">\\[' + escapeHtml(m.trim().replace(/\s+/g, ' ')) + '\\]</div>'));
    // 行内公式: 内容两端不能是空白, 避免 "$5 and $10" 被误判; 抽出后 $ 内的 * _ 不再参与行内规则
    t = t.replace(/\$([^\s$](?:[^$]*[^\s$])?)\$/g, (_, m) => stash('\\(' + escapeHtml(m) + '\\)'));

    // ── Stage 2: 行内分词(单趟, 每个 token 只处理一次) ────────
    // image 必须先于 link, 否则 ![alt](url) 会先被 link 规则吃掉变成 !<a>
    // 正则字面量写在函数体内: 每次调用新建带 g 的对象, 否则递归调用会互相污染 lastIndex
    function inline(raw) {
      const re = /!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\*([^*\n]+)\*|`([^`]+)`|<\/?[a-zA-Z][^<>]*>/g;
      let out = '', buf = '', pos = 0, m;
      while ((m = re.exec(raw)) !== null) {
        buf += raw.slice(pos, m.index);
        pos = re.lastIndex;
        out += escapeHtml(buf);
        buf = '';
        if (m[1] !== undefined) {
          out += '<img src="' + escapeAttr(fixUrl(m[2])) + '" alt="' + escapeAttr(m[1]) + '" class="max-w-full rounded-lg my-2 border border-gray-200 dark:border-gray-700">';
        } else if (m[3] !== undefined) {
          out += '<a href="' + escapeAttr(fixUrl(m[4])) + '" target="_blank" rel="noopener noreferrer" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 underline">' + escapeHtml(m[3]) + '</a>';
        } else if (m[5] !== undefined) {
          out += '<strong class="text-gray-900 dark:text-gray-100 font-semibold">' + inline(m[5]) + '</strong>';
        } else if (m[6] !== undefined) {
          out += '<del class="text-gray-500 dark:text-gray-400">' + inline(m[6]) + '</del>';
        } else if (m[7] !== undefined) {
          out += stashItalic('<em class="text-gray-800 dark:text-gray-200 italic">' + inline(m[7]) + '</em>');
        } else if (m[8] !== undefined) {
          out += '<code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm font-mono text-red-600 dark:text-red-400 border border-gray-200 dark:border-gray-600">' + escapeHtml(m[8]) + '</code>';
        } else {
          // 原样透传 HTML 标签, 安全性仍由末尾 DOMPurify 白名单兜底
          out += m[0];
        }
      }
      return out + escapeHtml(buf + raw.slice(pos));
    }

    function isBareBlock(s) { return /^\uE000\d+\uE001$/.test(s); }
    function isTableSep(s) {
      const c = String(s).trim();
      return c.indexOf('|') >= 0 && c.indexOf('-') >= 0 && !/[^\t :|-]/.test(c);
    }
    function isHr(s) {
      return /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s);
    }
    function startsBlock(s) {
      return /^#{1,6}(?:[ \t].*)?$/.test(s) ||
        /^[ \t]*(?:```|~~~)/.test(s) ||
        /^[ \t]*>/.test(s) ||
        isHr(s) ||
        /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/.test(s) ||
        (/^\|.*\|[ \t]*$/.test(s) && isTableSep(s)) ||
        isBareBlock(s.trim());
    }

    // ── Stage 3: 块级解析 ────────────────────────────────────
    function parseBlocks(lines) {
      let out = '', i = 0, first = true;
      function push(h) {
        out += (first ? '<p>' : '<p class="mt-3">') + h + '</p>';
        first = false;
      }
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        // 未闭合的围栏(闭合的已在 Stage 1 抽走)
        const fence = /^[ \t]*(```|~~~)/.exec(line);
        if (fence) {
          const marker = fence[1];
          const lang = line.slice(fence[0].length).trim();
          const buf = [];
          i++;
          while (i < lines.length && lines[i].trim().indexOf(marker) !== 0) { buf.push(lines[i]); i++; }
          if (i < lines.length) i++;
          out += '<pre class="my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto"><code class="' +
            (lang ? 'language-' + escapeAttr(lang) + ' ' : '') + 'text-gray-700 dark:text-gray-300">' +
            escapeHtml(buf.join('\n')) + '</code></pre>';
          first = false;
          continue;
        }

        // 独占一行的嵌入块/公式占位符 → 块级元素
        if (isBareBlock(line.trim())) { out += line.trim(); first = false; i++; continue; }

        // ATX 标题
        const h = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
        if (h) {
          const lvl = h[1].length;
          const title = (h[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim();
          out += '<h' + lvl + ' class="' + headingCls[lvl] + '">' + inline(title) + '</h' + lvl + '>';
          first = false;
          i++;
          continue;
        }

        // 分隔线(必须在列表规则之前: "- - -" 会被列表规则抢走)
        if (isHr(line)) { out += '<hr class="my-6">'; first = false; i++; continue; }

        // 表格: 首行 + 分隔行 + 数据行
        if (/^\|.*\|[ \t]*$/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
          const alignOf = (cell) => {
            const l = cell.charAt(0) === ':', r = cell.charAt(cell.length - 1) === ':';
            return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
          };
          const head = splitRow(line);
          const aligns = splitRow(lines[i + 1]).map(alignOf);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\|.*\|[ \t]*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
          const cell = (tag, txt, k) => '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(txt) + '</' + tag + '>';
          out += '<table class="my-3 w-full text-sm border-collapse"><thead><tr>' +
            head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + r.map((c, k) => cell('td', c, k)).join('') + '</tr>').join('') +
            '</tbody></table>';
          first = false;
          continue;
        }

        // 引用(内容递归解析)
        if (/^[ \t]*>/.test(line)) {
          const buf = [];
          while (i < lines.length && /^[ \t]*>/.test(lines[i])) {
            buf.push(lines[i].replace(/^[ \t]*>[ \t]?/, ''));
            i++;
          }
          out += '<blockquote>' + parseBlocks(buf) + '</blockquote>';
          first = false;
          continue;
        }

        // 列表(连续项 + 两空格缩进续行)
        const li = /^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/.exec(line);
        if (li) {
          const ordered = li[1].charAt(0) >= '0' && li[1].charAt(0) <= '9';
          const items = [];
          while (i < lines.length) {
            const cur = lines[i];
            const next = /^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/.exec(cur);
            if (next && ((next[1].charAt(0) >= '0' && next[1].charAt(0) <= '9') === ordered)) {
              items.push(next[2]);
              i++;
            } else if (/^[ \t]{2,}\S/.test(cur) || (items.length && cur.trim() && !startsBlock(cur))) {
              items[items.length - 1] += ' ' + cur.trim();
              i++;
            } else {
              break;
            }
          }
          // 任务列表: "- [ ] 待办" / "- [x] 已完成"
          const renderItem = (x) => {
            const tm = /^\[([ xX])\][ \t]+(\S.*)$/.exec(x);
            if (tm) {
              const checked = tm[1] === ' ' ? '' : ' checked';
              return '<li class="list-none"><input type="checkbox" disabled' + checked +
                ' class="mr-1.5 align-middle w-3.5 h-3.5 accent-indigo-600">' + inline(tm[2]) + '</li>';
            }
            return '<li>' + inline(x) + '</li>';
          };
          out += (ordered ? '<ol>' : '<ul>') + items.map(renderItem).join('') + (ordered ? '</ol>' : '</ul>');
          first = false;
          continue;
        }

        // 段落: 直到空行或下一个块级起始; 段内换行 → <br>
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { buf.push(lines[i]); i++; }
        push(buf.map((x) => inline(x)).join('<br>'));
      }
      return out;
    }

    let out = parseBlocks(t.split('\n'));
    out = sanitizeHtml(out);
    // 回填(sanitize 后): DOMPurify 已放行 iframe/data-*/class; 若被意外剥离则跳过
    // 斜体内容在分词阶段原样透传过 HTML 标签, 必须在回填时单独清洗,
    // 否则 *<img onerror=...>* 会绕过上面的 DOMPurify 白名单(存储型 XSS)。
    out = out.replace(/\uE000I(\d+)\uE001/g, (_, i) => (italics[+i] !== undefined ? sanitizeHtml(italics[+i]) : ''));
    out = out.replace(/\uE000(\d+)\uE001/g, (_, i) => (embeds[+i] !== undefined ? embeds[+i] : ''));
    return `<div class="prose prose-sm dark:prose-invert max-w-none text-left text-gray-700 dark:text-gray-200 leading-relaxed">${out}</div>`;
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
      '/js/echarts.min.js',
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
          var p = window.mermaid.render(id, src);
          if (p && typeof p.then === 'function') {
            p.then(function (result) {
              el.outerHTML = '<div class="oj-mermaid-svg my-4 overflow-x-auto">' + (result.svg || result) + '</div>';
            }).catch(function (e) {
              el.className = 'my-3 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm overflow-x-auto text-left text-gray-700 dark:text-gray-300';
              el.textContent = '[mermaid] 语法错误:\n' + String(e && e.message || e);
            });
          } else {
            window.mermaid.render(id, src, function (svg) {
              el.outerHTML = '<div class="oj-mermaid-svg my-4 overflow-x-auto">' + svg + '</div>';
            });
          }
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
