/* 页面脚本：段落提取、可见区域懒翻译、双语/替换渲染、悬浮按钮、划词翻译 */
(() => {
  if (window.__WT_LOADED__) return;
  window.__WT_LOADED__ = true;
  if (window.top !== window) return; // 只在顶层页面工作

  const L = window.WT_LANG;
  const C = window.WT_CONFIG;

  // ======================= 常量 =======================
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT',
    'EMBED', 'VIDEO', 'AUDIO', 'RT', 'RP', 'HEAD', 'TITLE'
  ]);
  const HAS_LETTER = /\p{L}/u;
  const TAG_RE = /<\/?g\d+>/g;
  const INLINE_MAX_CHARS = 40; // 短文本译文跟在原文后面（同一行），长文本另起一行
  const LANG_CHECK_MIN_CHARS = 24; // 段落足够长时才检测是否已是目标语言

  // ======================= 状态 =======================
  let S = Object.assign({}, C.DEFAULT_SETTINGS); // 当前设置
  const state = {
    enabled: false,
    session: 0, // 每次开启翻译 +1，用于丢弃过期的返回结果
    detectedLang: 'auto',
    sourceOverride: null, // 用户在弹窗中手动指定的源语言（仅当前页面）
    pending: 0,
    lastError: ''
  };
  let processed = new WeakSet(); // 已建组的文本节点
  let groups = []; // 所有段落组
  let blockGroups = new Map(); // block 元素 → 段落组数组
  let io = null; // IntersectionObserver
  let mo = null; // MutationObserver
  let queue = [];
  let flushTimer = null;
  const inflight = new Map(); // cacheKey → 等待结果的组数组
  const pageCache = new Map(); // cacheKey → 译文（页面生命周期内有效）
  let displayCache = new WeakMap();

  // ======================= 工具函数 =======================
  const sourceLang = () => state.sourceOverride || state.detectedLang || 'auto';
  const cacheKey = (src) => `${S.targetLang}|${S.activeProviderId}|${sourceLang()}|${src}`;
  const stripTags = (t) => (t || '').replace(TAG_RE, '');
  const collapse = (t) => t.replace(/\s+/g, ' ');

  function isInlineEl(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      displayCache.set(el, d);
    }
    return d.startsWith('inline') || d === 'contents' || d === 'ruby' || d === 'ruby-base';
  }

  function shouldSkipElement(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.tagName.startsWith('WT-')) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    return false;
  }

  function blockOf(textNode) {
    let el = textNode.parentElement;
    while (el && el !== document.body && isInlineEl(el)) el = el.parentElement;
    return el || document.body;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else resolve(resp || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: '插件已更新或被禁用，请刷新页面后重试', invalidated: true });
      }
    });
  }

  async function detectLang(text) {
    try {
      const r = await chrome.i18n.detectLanguage(text);
      if (r && r.languages && r.languages.length) {
        const top = r.languages.slice().sort((a, b) => b.percentage - a.percentage)[0];
        return { lang: L.normalizeLang(top.language), reliable: !!r.isReliable };
      }
    } catch (_) {}
    return { lang: 'auto', reliable: false };
  }

  async function detectPageLang() {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    const sample = (document.title + '\n' + (root.innerText || '')).slice(0, 4000);
    const htmlLang = L.normalizeLang(document.documentElement.getAttribute('lang'));
    const r = await detectLang(sample);
    if (r.reliable && r.lang !== 'auto') return r.lang;
    if (htmlLang !== 'auto') return htmlLang;
    return r.lang;
  }

  // ======================= 段落提取 =======================
  /**
   * 段落组：同一个“块级祖先”下的一组文本节点。
   * 只有一个文本节点时直接发送文本；有多个（含链接、加粗等）时用 <g0>…</g0> 标记每个节点，
   * 这样“仅显示译文”模式下可以把译文逐个写回原来的文本节点，保留链接等结构。
   */
  function makeGroup(block, textNodes) {
    const texts = textNodes.map((node) => ({ node, orig: node.nodeValue }));
    const plain = collapse(texts.map((t) => t.orig).join('')).trim();
    let source;
    if (texts.length === 1) {
      source = plain;
    } else {
      source = texts.map((t, i) => `<g${i}>${collapse(t.orig)}</g${i}>`).join('').trim();
    }
    return {
      block,
      texts,
      plain,
      source,
      status: 'idle', // idle | checking | queued | done | skipped | error
      translation: null,
      error: '',
      transEl: null, // 双语模式下插入的译文元素 / 加载中、出错提示
      replaced: false
    };
  }

  function scan(root) {
    if (!root || !state.enabled) return;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentElement;
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    // 祖先中有需要跳过的元素时整棵子树跳过
    for (let el = root; el && el !== document.documentElement; el = el.parentElement) {
      if (shouldSkipElement(el)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return shouldSkipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        if (processed.has(node)) return NodeFilter.FILTER_SKIP;
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const byBlock = new Map();
    let n;
    while ((n = walker.nextNode())) {
      processed.add(n);
      const block = blockOf(n);
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(n);
    }
    for (const [block, nodes] of byBlock) {
      const g = makeGroup(block, nodes);
      if (!HAS_LETTER.test(g.plain)) continue; // 纯数字 / 符号不翻译
      groups.push(g);
      if (!blockGroups.has(block)) {
        blockGroups.set(block, []);
        io.observe(block);
      }
      blockGroups.get(block).push(g);
    }
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const list = blockGroups.get(entry.target) || [];
      for (const g of list) if (g.status === 'idle') prepare(g);
      io.unobserve(entry.target);
    }
  }

  async function prepare(g) {
    const session = state.session;
    if (g.plain.length >= LANG_CHECK_MIN_CHARS) {
      g.status = 'checking';
      const r = await detectLang(g.plain);
      if (session !== state.session) return;
      if (r.reliable && r.lang === S.targetLang) {
        g.status = 'skipped';
        return;
      }
    }
    enqueue(g);
  }

  // ======================= 批量请求 =======================
  function enqueue(g) {
    g.status = 'queued';
    g.error = '';
    const key = cacheKey(g.source);
    if (pageCache.has(key)) {
      applyTranslation(g, pageCache.get(key));
      return;
    }
    showLoading(g);
    queue.push(g);
    state.pending++;
    updateBall();
    if (!flushTimer) flushTimer = setTimeout(flush, 80);
  }

  function flush() {
    flushTimer = null;
    const items = queue.splice(0);
    const unique = []; // 本次需要请求的去重文本
    for (const g of items) {
      const key = cacheKey(g.source);
      if (pageCache.has(key)) {
        state.pending--;
        applyTranslation(g, pageCache.get(key));
        continue;
      }
      if (inflight.has(key)) {
        inflight.get(key).push(g);
        continue;
      }
      inflight.set(key, [g]);
      unique.push({ key, source: g.source });
    }
    const maxChars = Math.max(200, Number(S.batchChars) || 2000);
    const maxItems = Math.max(1, Number(S.batchItems) || 30);
    let batch = [];
    let chars = 0;
    for (const u of unique) {
      if (batch.length && (chars + u.source.length > maxChars || batch.length >= maxItems)) {
        requestBatch(batch);
        batch = [];
        chars = 0;
      }
      batch.push(u);
      chars += u.source.length;
    }
    if (batch.length) requestBatch(batch);
    updateBall();
  }

  async function requestBatch(batch) {
    const session = state.session;
    const resp = await sendMessage({
      type: 'translate',
      segments: batch.map((b) => b.source),
      from: sourceLang(),
      to: S.targetLang,
      title: document.title,
      host: location.hostname
    });
    // 注意：stop() 会清空 inflight，所以这里取到的等待列表一定属于当前这一轮（缓存键相同，译文同样有效）
    batch.forEach((b, i) => {
      const waiting = inflight.get(b.key) || [];
      inflight.delete(b.key);
      state.pending = Math.max(0, state.pending - waiting.length);
      if (resp && resp.ok) {
        const t = resp.translations[i];
        pageCache.set(b.key, t);
        waiting.forEach((g) => applyTranslation(g, t));
      } else {
        waiting.forEach((g) => markError(g, resp && resp.error));
      }
    });
    if (resp && !resp.ok && session === state.session) {
      state.lastError = resp.error;
      reportError(resp);
    }
    updateBall();
  }

  // ======================= 渲染 =======================
  function isAlive(g) {
    return g.texts.some((t) => t.node.isConnected);
  }

  /** 译文插入位置：最后一个文本节点所在的、块级元素的直接子节点之后 */
  function anchorOf(g) {
    for (let i = g.texts.length - 1; i >= 0; i--) {
      let node = g.texts[i].node;
      if (!node.isConnected) continue;
      while (node.parentNode && node.parentNode !== g.block) node = node.parentNode;
      if (node.parentNode === g.block) return node;
    }
    return null;
  }

  function insertMarker(g, el) {
    removeMarker(g);
    const anchor = anchorOf(g);
    if (!anchor) return;
    anchor.after(el);
    g.transEl = el;
  }

  function removeMarker(g) {
    if (g.transEl) {
      g.transEl.remove();
      g.transEl = null;
    }
  }

  function restoreText(g) {
    if (!g.replaced) return;
    for (const t of g.texts) {
      if (t.node.isConnected && t.node.nodeValue !== t.orig) t.node.nodeValue = t.orig;
    }
    g.replaced = false;
  }

  function clearRender(g) {
    removeMarker(g);
    restoreText(g);
  }

  function showLoading(g) {
    if (!state.enabled || g.translation) return;
    const el = document.createElement('wt-trans');
    el.className = 'wt-trans wt-loading';
    el.setAttribute('aria-hidden', 'true');
    insertMarker(g, el);
  }

  function markError(g, msg) {
    g.status = 'error';
    g.error = msg || '翻译失败';
    if (!state.enabled) return;
    const el = document.createElement('wt-trans');
    el.className = 'wt-trans wt-error';
    el.textContent = '翻译失败，点击重试';
    el.title = g.error;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeMarker(g);
      enqueue(g);
    });
    insertMarker(g, el);
  }

  function applyTranslation(g, translation) {
    g.translation = translation;
    g.status = 'done';
    if (state.enabled) render(g);
  }

  /** 把带 <gN> 标记的译文拆回每个文本节点；标记缺失时返回 null */
  function splitPieces(t, n) {
    if (n === 1) return [stripTags(t).trim()];
    const pieces = new Array(n).fill(null);
    const re = /<g(\d+)>([\s\S]*?)<\/g\1>/g;
    let m;
    let last = -1;
    let cursor = 0;
    let leading = '';
    while ((m = re.exec(t))) {
      const gap = t.slice(cursor, m.index); // 标记之间的文字（如标点）归到前一个节点
      if (last >= 0) pieces[last] += gap;
      else leading += gap;
      const i = Number(m[1]);
      if (i >= n || pieces[i] !== null) return null;
      pieces[i] = stripTags(m[2]);
      last = i;
      cursor = re.lastIndex;
    }
    if (pieces.some((p) => p === null)) return null;
    if (last >= 0) pieces[last] += t.slice(cursor);
    const first = pieces.findIndex((p) => p !== null);
    pieces[first] = stripTags(leading) + pieces[first];
    return pieces.map((p) => stripTags(p));
  }

  function render(g) {
    clearRender(g);
    if (!g.translation || !isAlive(g)) return;
    const text = stripTags(g.translation).trim();
    if (!text || text === g.plain) return;

    if (S.displayMode === 'replace') {
      const pieces = splitPieces(g.translation, g.texts.length);
      g.texts.forEach((t, i) => {
        if (!t.node.isConnected) return;
        const lead = t.orig.match(/^\s*/)[0];
        const trail = t.orig.match(/\s*$/)[0];
        let piece;
        if (pieces) piece = pieces[i].trim();
        else piece = i === 0 ? text : ''; // 标记丢失时整段译文放进第一个节点
        t.node.nodeValue = piece ? lead + piece + trail : lead || trail ? ' ' : '';
      });
      g.replaced = true;
      return;
    }

    const el = document.createElement('wt-trans');
    const inline = g.plain.length <= INLINE_MAX_CHARS;
    el.className = `wt-trans ${inline ? 'wt-inline' : 'wt-block'} wt-style-${S.transStyle || 'faded'}`;
    el.textContent = text;
    insertMarker(g, el);
  }

  function rerenderAll() {
    for (const g of groups) {
      if (g.status === 'done') render(g);
    }
  }

  // ======================= 开启 / 关闭 =======================
  function scheduleScan(nodes) {
    for (const n of nodes) pendingScanRoots.add(n);
    if (!scanTimer) scanTimer = setTimeout(runPendingScans, 300);
  }
  const pendingScanRoots = new Set();
  let scanTimer = null;
  function runPendingScans() {
    scanTimer = null;
    const roots = Array.from(pendingScanRoots);
    pendingScanRoots.clear();
    displayCache = new WeakMap();
    for (const r of roots) if (r.isConnected) scan(r);
  }

  function isOwnNode(n) {
    const el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
    if (!el) return true;
    if (el === uiHost) return true;
    return !!(el.closest && el.closest('wt-trans'));
  }

  function start() {
    if (state.enabled) return;
    state.enabled = true;
    state.session++;
    state.lastError = '';
    io = new IntersectionObserver(onIntersect, { rootMargin: `${Number(S.rootMargin) || 600}px 0px` });
    mo = new MutationObserver((records) => {
      const roots = [];
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.TEXT_NODE) continue;
          if (isOwnNode(n)) continue;
          roots.push(n);
        }
      }
      if (roots.length) scheduleScan(roots);
    });
    displayCache = new WeakMap();
    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
    updateBall();
  }

  function stop() {
    if (!state.enabled) return;
    state.enabled = false;
    state.session++;
    if (io) io.disconnect();
    if (mo) mo.disconnect();
    io = mo = null;
    clearTimeout(flushTimer);
    clearTimeout(scanTimer);
    flushTimer = scanTimer = null;
    pendingScanRoots.clear();
    queue = [];
    inflight.clear();
    for (const g of groups) clearRender(g);
    groups = [];
    blockGroups = new Map();
    processed = new WeakSet();
    state.pending = 0;
    updateBall();
  }

  function toggle() {
    state.enabled ? stop() : start();
  }

  function restart() {
    if (!state.enabled) return;
    stop();
    start();
  }

  function getState() {
    return {
      ok: true,
      enabled: state.enabled,
      detectedLang: state.detectedLang,
      sourceOverride: state.sourceOverride,
      pending: state.pending,
      lastError: state.lastError,
      host: location.hostname
    };
  }

  // ======================= 页面 UI（Shadow DOM 隔离样式） =======================
  let uiHost = null;
  let ui = null; // shadowRoot
  let ball = null;
  let selIcon = null;
  let panel = null;
  let toastTimer = null;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ball {
      position: fixed; right: 0; z-index: 2147483646; width: 38px; height: 38px;
      border-radius: 19px 0 0 19px; background: #4f46e5; color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center; user-select: none;
      font: 600 16px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,.2); opacity: .55; transition: opacity .2s, width .2s;
    }
    .ball:hover { opacity: 1; width: 44px; }
    .ball.on { background: #16a34a; opacity: .9; }
    .ball.busy::after {
      content: ""; position: absolute; inset: 3px 5px 3px 3px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: spin .8s linear infinite;
    }
    .ball .close {
      position: absolute; top: -6px; left: -6px; width: 16px; height: 16px; border-radius: 50%;
      background: #64748b; color: #fff; font-size: 11px; line-height: 16px; text-align: center; display: none;
    }
    .ball:hover .close { display: block; }
    .sel-icon {
      position: fixed; z-index: 2147483647; width: 26px; height: 26px; border-radius: 6px;
      background: #4f46e5; color: #fff; display: flex; align-items: center; justify-content: center;
      font: 600 14px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .sel-icon:hover { background: #4338ca; }
    .panel {
      position: fixed; z-index: 2147483647; width: 380px; max-width: calc(100vw - 16px);
      max-height: 60vh; display: flex; flex-direction: column; background: #fff; color: #1f2937;
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.22); border: 1px solid #e5e7eb;
      font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; overflow: hidden;
    }
    .panel .hd {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #f8fafc;
      border-bottom: 1px solid #eef2f7; font-size: 12px; color: #64748b;
    }
    .panel .hd .langs { flex: 1; }
    .panel .hd button {
      border: 0; background: transparent; color: #64748b; cursor: pointer; padding: 2px 6px;
      border-radius: 4px; font-size: 12px;
    }
    .panel .hd button:hover { background: #e2e8f0; color: #1f2937; }
    .panel .bd { padding: 10px 12px 12px; overflow: auto; }
    .panel .src {
      color: #94a3b8; font-size: 12px; margin-bottom: 8px; display: -webkit-box;
      -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap;
    }
    .panel .out { white-space: pre-wrap; word-break: break-word; }
    .panel .err { color: #dc2626; }
    .panel .err a { color: #4f46e5; cursor: pointer; margin-left: 6px; }
    .dots::after { content: "…"; animation: blink 1s steps(3) infinite; }
    .toast {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 360px;
      background: #1f2937; color: #fff; padding: 10px 14px; border-radius: 8px;
      font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,.25);
    }
    .toast .detail { color: #cbd5e1; font-size: 12px; margin-top: 4px; word-break: break-all; }
    .toast a { color: #a5b4fc; cursor: pointer; margin-left: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes blink { 50% { opacity: .3; } }
  `;

  function ensureUI() {
    if (ui && uiHost.isConnected) return ui;
    uiHost = document.createElement('wt-ui');
    uiHost.setAttribute('translate', 'no');
    ui = uiHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    ui.appendChild(style);
    document.documentElement.appendChild(uiHost);
    return ui;
  }

  // ---------- 悬浮按钮 ----------
  let ballHiddenForPage = false;

  function renderBall() {
    if (!S.floatingBall || ballHiddenForPage) {
      if (ball) ball.remove();
      ball = null;
      return;
    }
    if (ball && ball.isConnected) return updateBall();
    const root = ensureUI();
    ball = document.createElement('div');
    ball.className = 'ball';
    ball.title = '翻译 / 还原此页面（拖动可调整位置）';
    ball.innerHTML = '<span class="txt">译</span><span class="close" title="本页隐藏">×</span>';
    ball.style.top = `${Math.min(92, Math.max(5, Number(S.ballTop) || 70))}%`;
    root.appendChild(ball);

    let startY = 0;
    let startTop = 0;
    let dragged = false;
    ball.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startY = e.clientY;
      startTop = ball.getBoundingClientRect().top;
      dragged = false;
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 3) dragged = true;
        if (dragged) {
          const top = Math.min(window.innerHeight - 44, Math.max(4, startTop + dy));
          ball.style.top = `${top}px`;
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        if (dragged) {
          const pct = Math.round((ball.getBoundingClientRect().top / window.innerHeight) * 100);
          C.saveSettings({ ballTop: pct }).catch(() => {});
        }
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
      e.preventDefault();
    });
    ball.addEventListener('click', (e) => {
      if (dragged) return;
      if (e.target.classList.contains('close')) {
        ballHiddenForPage = true;
        renderBall();
        return;
      }
      toggle();
    });
    updateBall();
  }

  function updateBall() {
    if (!ball) return;
    ball.classList.toggle('on', state.enabled);
    ball.classList.toggle('busy', state.enabled && state.pending > 0);
  }

  // ---------- 提示 ----------
  function toast(message, { detail = '', action = null, duration = 6000 } = {}) {
    const root = ensureUI();
    let el = root.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      root.appendChild(el);
    }
    el.textContent = message;
    if (action) {
      const a = document.createElement('a');
      a.textContent = action.label;
      a.addEventListener('click', action.onClick);
      el.appendChild(a);
    }
    if (detail) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      el.appendChild(d);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), duration);
  }

  let lastErrorToastAt = 0;
  function reportError(resp) {
    const now = Date.now();
    if (now - lastErrorToastAt < 5000) return;
    lastErrorToastAt = now;
    toast('翻译失败：' + (resp.error || '未知错误'), {
      detail: resp.detail || '',
      action: resp.invalidated ? null : { label: '打开设置', onClick: () => sendMessage({ type: 'openOptions' }) },
      duration: 8000
    });
  }

  // ---------- 划词翻译 ----------
  function hideSelIcon() {
    if (selIcon) selIcon.remove();
    selIcon = null;
  }

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    return { text, rect };
  }

  function showSelIcon(info, x, y) {
    const root = ensureUI();
    hideSelIcon();
    selIcon = document.createElement('div');
    selIcon.className = 'sel-icon';
    selIcon.textContent = '译';
    selIcon.title = '翻译选中文字';
    selIcon.style.left = `${Math.min(window.innerWidth - 34, x + 8)}px`;
    selIcon.style.top = `${Math.min(window.innerHeight - 34, y + 10)}px`;
    selIcon.addEventListener('mousedown', (e) => e.preventDefault()); // 保持选区
    selIcon.addEventListener('click', () => {
      hideSelIcon();
      openPanel(info.text, info.rect);
    });
    root.appendChild(selIcon);
  }

  async function openPanel(text, rect) {
    const root = ensureUI();
    closePanel();
    text = text.slice(0, 5000);
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="hd"><span class="langs"></span>
        <button class="copy" title="复制译文">复制</button>
        <button class="x" title="关闭 (Esc)">✕</button></div>
      <div class="bd"><div class="src"></div><div class="out"><span class="dots">翻译中</span></div></div>`;
    panel.querySelector('.src').textContent = text;
    root.appendChild(panel);

    // 定位：优先放在选区下方，空间不够放上方
    const w = Math.min(380, window.innerWidth - 16);
    const r = rect && rect.width + rect.height > 0 ? rect : { left: window.innerWidth / 2 - w / 2, bottom: 80, top: 80 };
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    panel.style.left = `${left}px`;
    const below = window.innerHeight - r.bottom;
    if (below > 220 || below > r.top) panel.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 120)}px`;
    else panel.style.bottom = `${window.innerHeight - r.top + 8}px`;

    const thisPanel = panel;
    thisPanel.querySelector('.x').addEventListener('click', closePanel);
    const out = thisPanel.querySelector('.out');
    let result = '';
    thisPanel.querySelector('.copy').addEventListener('click', async (e) => {
      if (!result) return;
      try {
        await navigator.clipboard.writeText(result);
        e.target.textContent = '已复制';
        setTimeout(() => (e.target.textContent = '复制'), 1200);
      } catch (_) {}
    });

    const d = await detectLang(text);
    const from = d.reliable && d.lang !== 'auto' ? d.lang : sourceLang();
    if (!panel || panel !== thisPanel) return;
    thisPanel.querySelector('.langs').textContent = `${L.langName(from)} → ${L.langName(S.targetLang)}`;
    const resp = await sendMessage({
      type: 'translate',
      segments: [text],
      from,
      to: S.targetLang,
      title: document.title,
      host: location.hostname
    });
    if (panel !== thisPanel) return;
    if (resp && resp.ok) {
      result = resp.translations[0];
      out.textContent = result;
    } else {
      out.innerHTML = '<span class="err"></span>';
      const err = out.querySelector('.err');
      err.textContent = '翻译失败：' + ((resp && resp.error) || '未知错误');
      if (resp && resp.detail) err.title = resp.detail;
      const a = document.createElement('a');
      a.textContent = '打开设置';
      a.addEventListener('click', () => sendMessage({ type: 'openOptions' }));
      err.appendChild(a);
    }
  }

  function inEditable(node) {
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!el) return false;
    return !!el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      if (uiHost && e.composedPath().includes(uiHost)) return;
      hideSelIcon();
      closePanel();
    },
    true
  );

  document.addEventListener(
    'mouseup',
    (e) => {
      if (S.selectionMode === 'off' || e.button !== 0) return;
      if (uiHost && e.composedPath().includes(uiHost)) return;
      setTimeout(() => {
        const info = selectionInfo();
        if (!info || inEditable(window.getSelection().anchorNode)) return;
        if (!HAS_LETTER.test(info.text)) return;
        if (S.selectionMode === 'direct') openPanel(info.text, info.rect);
        else showSelIcon(info, e.clientX, e.clientY);
      }, 10);
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSelIcon();
      closePanel();
    }
  });
  window.addEventListener('scroll', hideSelIcon, { passive: true });

  // ======================= 消息与设置变化 =======================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'ping':
        sendResponse({ ok: true });
        break;
      case 'getState':
        sendResponse(getState());
        break;
      case 'toggle':
        toggle();
        sendResponse(getState());
        break;
      case 'start':
        start();
        sendResponse(getState());
        break;
      case 'stop':
        stop();
        sendResponse(getState());
        break;
      case 'setSourceLang':
        state.sourceOverride = msg.lang && msg.lang !== 'auto' ? msg.lang : null;
        restart();
        sendResponse(getState());
        break;
      case 'toggleMode': {
        const mode = S.displayMode === 'replace' ? 'bilingual' : 'replace';
        C.saveSettings({ displayMode: mode });
        toast(mode === 'replace' ? '已切换为：仅显示译文' : '已切换为：双语对照', { duration: 2000 });
        sendResponse({ ok: true });
        break;
      }
      case 'translateSelection': {
        const info = selectionInfo();
        const text = (info && info.text) || msg.text;
        if (text) openPanel(text, info && info.rect);
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const old = S;
    S = Object.assign({}, C.DEFAULT_SETTINGS, changes.settings.newValue || {});
    if (!S.targetLang) S.targetLang = L.defaultTargetLang();
    if (
      old.targetLang !== S.targetLang ||
      old.activeProviderId !== S.activeProviderId ||
      old.customPrompt !== S.customPrompt
    ) {
      if (old.customPrompt !== S.customPrompt) pageCache.clear();
      restart();
    } else if (old.displayMode !== S.displayMode || old.transStyle !== S.transStyle) {
      rerenderAll();
    }
    if (old.floatingBall !== S.floatingBall) renderBall();
    if (S.selectionMode === 'off') hideSelIcon();
  });

  // ======================= 初始化 =======================
  (async function init() {
    try {
      S = await C.getSettings();
    } catch (_) {}
    state.detectedLang = await detectPageLang();
    renderBall();
    const host = location.hostname;
    if (host && S.autoSites.includes(host) && state.detectedLang !== S.targetLang) start();
  })();
})();
