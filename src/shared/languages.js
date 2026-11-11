/* 语言列表与语言代码规范化工具（content script / popup / options / service worker 共用） */
(function (root) {
  const LANGUAGES = [
    { code: 'zh-CN', name: '简体中文', en: 'Simplified Chinese' },
    { code: 'zh-TW', name: '繁體中文', en: 'Traditional Chinese' },
    { code: 'en', name: '英语', en: 'English' },
    { code: 'ja', name: '日语', en: 'Japanese' },
    { code: 'ko', name: '韩语', en: 'Korean' },
    { code: 'fr', name: '法语', en: 'French' },
    { code: 'de', name: '德语', en: 'German' },
    { code: 'es', name: '西班牙语', en: 'Spanish' },
    { code: 'pt', name: '葡萄牙语', en: 'Portuguese' },
    { code: 'it', name: '意大利语', en: 'Italian' },
    { code: 'ru', name: '俄语', en: 'Russian' },
    { code: 'uk', name: '乌克兰语', en: 'Ukrainian' },
    { code: 'pl', name: '波兰语', en: 'Polish' },
    { code: 'nl', name: '荷兰语', en: 'Dutch' },
    { code: 'tr', name: '土耳其语', en: 'Turkish' },
    { code: 'ar', name: '阿拉伯语', en: 'Arabic' },
    { code: 'hi', name: '印地语', en: 'Hindi' },
    { code: 'th', name: '泰语', en: 'Thai' },
    { code: 'vi', name: '越南语', en: 'Vietnamese' },
    { code: 'id', name: '印尼语', en: 'Indonesian' },
    { code: 'ms', name: '马来语', en: 'Malay' }
  ];

  const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

  /** 把 ja-JP / zh-Hant / ZH_tw 等各种写法统一为列表中的代码；无法识别返回 'auto' */
  function normalizeLang(raw) {
    if (!raw || typeof raw !== 'string') return 'auto';
    const s = raw.trim().replace(/_/g, '-').toLowerCase();
    if (!s || s === 'und' || s === 'auto') return 'auto';
    if (s.startsWith('zh')) {
      return /(hant|tw|hk|mo)/.test(s) ? 'zh-TW' : 'zh-CN';
    }
    const primary = s.split('-')[0];
    if (primary === 'in') return 'id'; // 旧代码
    if (primary === 'iw') return 'he';
    return primary;
  }

  function langName(code) {
    if (!code || code === 'auto') return '自动检测';
    const l = byCode.get(code);
    return l ? l.name : code;
  }

  /** 给大模型看的英文语言名 */
  function langEnglishName(code) {
    if (!code || code === 'auto') return null;
    const l = byCode.get(code);
    return l ? l.en : code;
  }

  function defaultTargetLang() {
    const ui = normalizeLang((root.navigator && root.navigator.language) || 'zh-CN');
    return byCode.has(ui) ? ui : 'zh-CN';
  }

  root.WT_LANG = { LANGUAGES, normalizeLang, langName, langEnglishName, defaultTargetLang };
})(typeof globalThis !== 'undefined' ? globalThis : self);
