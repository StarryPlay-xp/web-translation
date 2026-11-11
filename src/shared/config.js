/* 默认配置与存储读写（content script / popup / options / service worker 共用）
 *
 * 存储划分：
 *  - chrome.storage.sync  key=settings  ：普通偏好（目标语言、显示模式、自动翻译网站等），可跨设备同步
 *  - chrome.storage.local key=providers ：模型配置（含 API Key），只保存在本机，且 service worker
 *    会把 storage.local 设为仅扩展内部页面可访问，网页里的 content script 读不到 API Key。
 */
(function (root) {
  const DEFAULT_SETTINGS = {
    targetLang: null, // null 表示首次使用，取浏览器界面语言
    displayMode: 'bilingual', // bilingual 双语对照 | replace 仅显示译文
    transStyle: 'faded', // 译文样式：plain | faded | dashed | highlight
    floatingBall: true, // 页面右侧悬浮按钮
    selectionMode: 'icon', // 划词翻译：icon 先显示图标 | direct 直接弹出 | off 关闭
    autoSites: [], // 总是自动翻译的网站（hostname）
    activeProviderId: 'deepseek',
    customPrompt: '', // 追加给模型的额外要求（术语表、风格等）
    batchChars: 2000, // 每次请求最多字符数
    batchItems: 30, // 每次请求最多段落数
    concurrency: 4, // 同时进行的请求数
    rootMargin: 600, // 提前翻译视口外多少像素的内容
    ballTop: 70 // 悬浮按钮垂直位置（视口高度百分比）
  };

  /** 新建模型配置时可选的模板 */
  const PROVIDER_PRESETS = [
    {
      key: 'deepseek',
      label: 'DeepSeek（OpenAI 协议）',
      protocol: 'openai',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    },
    {
      key: 'deepseek-anthropic',
      label: 'DeepSeek（Anthropic 协议）',
      protocol: 'anthropic',
      baseURL: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-chat'
    },
    {
      key: 'openai',
      label: 'OpenAI',
      protocol: 'openai',
      baseURL: 'https://api.openai.com/v1',
      model: ''
    },
    {
      key: 'anthropic',
      label: 'Anthropic Claude',
      protocol: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-opus-5-5'
    },
    {
      key: 'ollama',
      label: 'Ollama 本地模型',
      protocol: 'openai',
      baseURL: 'http://localhost:11434/v1',
      model: ''
    },
    { key: 'custom-openai', label: '自定义（OpenAI 兼容）', protocol: 'openai', baseURL: '', model: '' },
    { key: 'custom-anthropic', label: '自定义（Anthropic 兼容）', protocol: 'anthropic', baseURL: '', model: '' }
  ];

  const DEFAULT_PROVIDERS = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      protocol: 'openai',
      baseURL: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: '', // 留空 = 使用服务商默认值
      maxTokens: 8192,
      extraBody: '' // 追加到请求体的 JSON，例如 {"thinking":{"type":"disabled"}}
    }
  ];

  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage;
  }

  async function getSettings() {
    const data = hasChrome() ? await chrome.storage.sync.get('settings') : {};
    const s = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    if (!s.targetLang) s.targetLang = root.WT_LANG.defaultTargetLang();
    if (!Array.isArray(s.autoSites)) s.autoSites = [];
    return s;
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = Object.assign(cur, patch);
    await chrome.storage.sync.set({ settings: next });
    return next;
  }

  /** 仅扩展页面 / service worker 可用（content script 无权访问 storage.local） */
  async function getProviders() {
    const data = await chrome.storage.local.get('providers');
    const list = Array.isArray(data.providers) && data.providers.length ? data.providers : DEFAULT_PROVIDERS;
    return list.map((p) => Object.assign({ temperature: '', maxTokens: 8192, extraBody: '' }, p));
  }

  async function saveProviders(list) {
    await chrome.storage.local.set({ providers: list });
  }

  function genId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  root.WT_CONFIG = {
    DEFAULT_SETTINGS,
    PROVIDER_PRESETS,
    DEFAULT_PROVIDERS,
    getSettings,
    saveSettings,
    getProviders,
    saveProviders,
    genId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
