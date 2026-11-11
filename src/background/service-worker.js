/* 后台 service worker：负责调用大模型、快捷键、右键菜单 */
importScripts('/src/shared/languages.js', '/src/shared/config.js', '/src/background/llm.js');

const { getSettings, getProviders } = self.WT_CONFIG;
const { translateBatch, LLMError } = self.WT_LLM;

const PORT_NAME = 'wt-translate';
const PARTIAL_INTERVAL_MS = 100; // 划词面板逐字显示时，推送“部分译文”的最小间隔

// API Key 存在 storage.local 中，限制为仅扩展内部页面可访问，网页中的 content script 读不到
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

// ---------------- 并发控制（排队中的请求可随时取消） ----------------
let running = 0;
const waiters = []; // { limit, grant }

function releaseSlot() {
  running--;
  while (waiters.length && running < waiters[0].limit) {
    running++;
    waiters.shift().grant();
  }
}

function acquireSlot(limit, signal) {
  if (signal && signal.aborted) return Promise.reject(new LLMError('已取消', { cancelled: true }));
  if (running < limit && !waiters.length) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = waiters.indexOf(w);
      if (i !== -1) waiters.splice(i, 1);
      reject(new LLMError('已取消', { cancelled: true }));
    };
    const w = {
      limit,
      grant: () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(w);
  });
}

async function withSlot(limit, signal, fn) {
  await acquireSlot(limit, signal);
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

// 有请求进行时定期调用一次扩展 API，避免等待模型输出期间 service worker 被判定空闲而休眠
let activeRequests = 0;
let keepAliveTimer = null;
function beginRequest() {
  if (activeRequests++ === 0) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20 * 1000);
  }
}
function endRequest() {
  if (--activeRequests === 0) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---------------- 内存缓存（service worker 休眠后清空） ----------------
const CACHE_MAX = 5000;
const cache = new Map();
function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}
function cacheSet(key, v) {
  cache.set(key, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function getActiveProvider(settings) {
  const providers = await getProviders();
  return providers.find((p) => p.id === settings.activeProviderId) || providers[0];
}

/**
 * opts.onItem(i, text)   ：某一段译文可用时立即回调（缓存命中的段落会最先回调）
 * opts.onPartial(i, text)：某一段译文正在输出时回调已输出的部分
 * opts.signal            ：取消信号；取消后不再占用并发名额
 * opts.urgent            ：用户主动发起的单次翻译（划词、测试连接），不参与排队
 */
async function handleTranslate(msg, { signal, onItem, onPartial, urgent } = {}) {
  const settings = await getSettings();
  const provider = msg.provider || (await getActiveProvider(settings));
  const ctx = {
    from: msg.from || 'auto',
    to: msg.to || settings.targetLang,
    title: msg.title || '',
    host: msg.host || '',
    customPrompt: settings.customPrompt
  };
  const keyPrefix = [provider.id, provider.model, ctx.from, ctx.to, settings.customPrompt].join('|') + '|';
  const segments = msg.segments || [];
  const result = new Array(segments.length);
  const missIdx = [];
  segments.forEach((s, i) => {
    const hit = msg.noCache ? undefined : cacheGet(keyPrefix + s);
    if (hit !== undefined) {
      result[i] = hit;
      if (onItem) onItem(i, hit);
    } else missIdx.push(i);
  });
  if (missIdx.length) {
    const toSend = missIdx.map((i) => segments[i]);
    const run = () =>
      translateBatch(provider, toSend, ctx, {
        signal,
        onItem: onItem && ((k, t) => onItem(missIdx[k], t)),
        onPartial: onPartial && ((k, t) => onPartial(missIdx[k], t))
      });
    const limit = Math.max(1, Number(settings.concurrency) || 4);
    const translated = urgent ? await run() : await withSlot(limit, signal, run);
    missIdx.forEach((i, k) => {
      result[i] = translated[k];
      cacheSet(keyPrefix + segments[i], translated[k]);
    });
  }
  return result;
}

function errorPayload(e) {
  return {
    ok: false,
    error: e.message || String(e),
    detail: e instanceof LLMError ? e.detail : '',
    status: e.status
  };
}

// 只有扩展自己的页面（设置页“测试连接”）可以传入临时模型配置
function sanitize(msg, sender) {
  const fromExtensionPage = !sender.tab && sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage) delete msg.provider;
}

/**
 * 页面翻译与划词翻译走长连接：
 *  页面 → 后台：{ type: 'translate', segments, from, to, title, host, urgent?, partial? }
 *  后台 → 页面：{ type: 'item', index, text }（每译好一段立即推送）
 *              { type: 'partial', index, text }（仅 partial=true 时，正在输出的部分）
 *              { type: 'done', translations } / { type: 'error', error, detail, status }
 * 页面断开连接（关闭翻译、切换语言、关闭划词面板、刷新页面）时，立即中止对应的模型请求。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const ctrl = new AbortController();
  let started = false;
  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
    ctrl.abort();
  });
  const post = (m) => {
    if (closed) return;
    try {
      port.postMessage(m);
    } catch (_) {
      closed = true;
    }
  };
  port.onMessage.addListener((msg) => {
    if (started || !msg || msg.type !== 'translate') return;
    started = true;
    sanitize(msg, port.sender);
    let lastPartialAt = 0;
    beginRequest();
    handleTranslate(msg, {
      signal: ctrl.signal,
      urgent: !!msg.urgent,
      onItem: (index, text) => post({ type: 'item', index, text }),
      onPartial: msg.partial
        ? (index, text) => {
            const now = Date.now();
            if (now - lastPartialAt < PARTIAL_INTERVAL_MS) return;
            lastPartialAt = now;
            post({ type: 'partial', index, text });
          }
        : undefined
    })
      .then((translations) => post({ type: 'done', translations }))
      .catch((e) => {
        if (!ctrl.signal.aborted) post(Object.assign({ type: 'error' }, errorPayload(e)));
      })
      .finally(endRequest);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'translate') {
    // 一次性翻译（设置页“测试连接”）：不排队，结果整体返回
    sanitize(msg, sender);
    beginRequest();
    handleTranslate(msg, { urgent: true })
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((e) => sendResponse(errorPayload(e)))
      .finally(endRequest);
    return true; // 异步响应
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return;
  }
});

// ---------------- 与页面通信（必要时注入 content script） ----------------
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/shared/languages.js', 'src/shared/config.js', 'src/content/content.js']
      });
      return true;
    } catch (e) {
      return false; // chrome:// 页面、应用商店等无法注入
    }
  }
}

async function sendToTab(tabId, message) {
  if (!(await ensureContentScript(tabId))) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    return null;
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target || target.id === undefined) return;
  if (command === 'toggle-translate') sendToTab(target.id, { type: 'toggle' });
  if (command === 'toggle-mode') sendToTab(target.id, { type: 'toggleMode' });
});

// ---------------- 右键菜单 ----------------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'wt-selection', title: '翻译选中文字', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'wt-page', title: '翻译 / 还原此页面', contexts: ['page'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined) return;
  if (info.menuItemId === 'wt-selection') {
    sendToTab(tab.id, { type: 'translateSelection', text: info.selectionText || '' });
  } else if (info.menuItemId === 'wt-page') {
    sendToTab(tab.id, { type: 'toggle' });
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  createMenus();
  if (details.reason === 'install') {
    const providers = await getProviders();
    if (!providers.some((p) => p.apiKey)) chrome.runtime.openOptionsPage();
  }
});
