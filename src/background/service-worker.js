/* 后台 service worker：负责调用大模型、快捷键、右键菜单 */
importScripts('/src/shared/languages.js', '/src/shared/config.js', '/src/background/llm.js');

const { getSettings, getProviders } = self.WT_CONFIG;
const { translateBatch, LLMError } = self.WT_LLM;

// API Key 存在 storage.local 中，限制为仅扩展内部页面可访问，网页中的 content script 读不到
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

// ---------------- 并发控制 ----------------
let running = 0;
const waiters = [];
async function withLimit(limit, fn) {
  while (running >= limit) await new Promise((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiters.shift();
    if (next) next();
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

async function handleTranslate(msg) {
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
    if (hit !== undefined) result[i] = hit;
    else missIdx.push(i);
  });
  if (missIdx.length) {
    const toSend = missIdx.map((i) => segments[i]);
    const translated = await withLimit(Math.max(1, Number(settings.concurrency) || 4), () =>
      translateBatch(provider, toSend, ctx)
    );
    missIdx.forEach((i, k) => {
      result[i] = translated[k];
      cacheSet(keyPrefix + segments[i], translated[k]);
    });
  }
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'translate') {
    // 只有扩展自己的页面（设置页“测试连接”）可以传入临时模型配置
    const fromExtensionPage = !sender.tab && sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
    if (!fromExtensionPage) delete msg.provider;
    handleTranslate(msg)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e.message || String(e),
          detail: e instanceof LLMError ? e.detail : '',
          status: e.status
        })
      );
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
