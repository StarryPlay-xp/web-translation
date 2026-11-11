/* 大模型调用：兼容 OpenAI Chat Completions 协议与 Anthropic Messages 协议 */
(function (root) {
  const REQUEST_TIMEOUT_MS = 90 * 1000;
  const MAX_RETRIES = 2;

  class LLMError extends Error {
    constructor(message, { status, retryable, detail } = {}) {
      super(message);
      this.status = status;
      this.retryable = !!retryable;
      this.detail = detail || '';
    }
  }

  function trimSlash(s) {
    return (s || '').trim().replace(/\/+$/, '');
  }

  /**
   * 根据用户填写的 Base URL 拼出完整接口地址：
   *  OpenAI   ：https://api.deepseek.com → /chat/completions；已以 /chat/completions 结尾则原样使用
   *  Anthropic：https://api.anthropic.com → /v1/messages；以 /v1 结尾补 /messages；以 /messages 结尾原样使用
   *            （DeepSeek 的 https://api.deepseek.com/anthropic 会拼成 /anthropic/v1/messages）
   */
  function buildEndpoint(provider) {
    const base = trimSlash(provider.baseURL);
    if (!base) throw new LLMError('未填写接口地址（Base URL）');
    if (provider.protocol === 'anthropic') {
      if (/\/messages$/.test(base)) return base;
      if (/\/v\d+$/.test(base)) return base + '/messages';
      return base + '/v1/messages';
    }
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  function parseExtraBody(provider) {
    const raw = (provider.extraBody || '').trim();
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) {
      throw new LLMError('“额外请求参数”不是合法的 JSON：' + e.message);
    }
  }

  function parseTemperature(provider) {
    const t = provider.temperature;
    if (t === '' || t === null || t === undefined) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }

  function friendlyHttpError(status, bodyText) {
    let apiMsg = '';
    try {
      const j = JSON.parse(bodyText);
      apiMsg = (j.error && (j.error.message || j.error.type)) || j.message || j.msg || '';
      if (typeof apiMsg !== 'string') apiMsg = JSON.stringify(apiMsg);
    } catch (_) {
      apiMsg = (bodyText || '').slice(0, 200);
    }
    const map = {
      400: '请求参数有误（可能是模型名称或额外参数不被支持）',
      401: 'API Key 无效或未填写',
      402: '账户余额不足',
      403: '没有访问权限（API Key 权限不足或地区受限）',
      404: '接口地址或模型名称错误',
      408: '请求超时',
      413: '单次请求内容过大，请在设置中调小“每批最大字符数”',
      422: '请求参数有误',
      429: '请求过于频繁或额度已用尽，请稍后再试',
      529: '服务繁忙，请稍后再试'
    };
    let msg = map[status] || (status >= 500 ? '模型服务暂时不可用' : '请求失败');
    msg = `${msg}（HTTP ${status}）`;
    return new LLMError(msg, {
      status,
      retryable: status === 429 || status === 408 || status >= 500,
      detail: apiMsg
    });
  }

  async function postJSON(url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new LLMError('请求超时（超过 90 秒未响应）', { retryable: true });
      throw new LLMError('无法连接到接口地址：' + url, { retryable: true, detail: e.message });
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    if (!resp.ok) throw friendlyHttpError(resp.status, text);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new LLMError('接口返回的不是 JSON，请检查接口地址是否正确', { detail: text.slice(0, 200) });
    }
  }

  async function callOpenAI(provider, system, user) {
    const body = Object.assign(
      {
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: false
      },
      parseExtraBody(provider)
    );
    const temperature = parseTemperature(provider);
    if (temperature !== undefined) body.temperature = temperature;
    const headers = {};
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey.trim();

    const data = await postJSON(buildEndpoint(provider), headers, body);
    const choice = data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
    }
    if (typeof content !== 'string') {
      throw new LLMError('接口返回格式无法识别（缺少 choices[0].message.content）', {
        detail: JSON.stringify(data).slice(0, 200)
      });
    }
    return content;
  }

  async function callAnthropic(provider, system, user) {
    const body = Object.assign(
      {
        model: provider.model,
        max_tokens: Number(provider.maxTokens) || 8192,
        system,
        messages: [{ role: 'user', content: user }]
      },
      parseExtraBody(provider)
    );
    const temperature = parseTemperature(provider);
    if (temperature !== undefined) body.temperature = temperature;
    const headers = {
      'anthropic-version': '2023-06-01',
      // 浏览器环境直连 Anthropic API 需要此头，否则会因跨域被拒绝
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey.trim();

    const data = await postJSON(buildEndpoint(provider), headers, body);
    if (data.stop_reason === 'refusal') {
      throw new LLMError('模型拒绝翻译这段内容');
    }
    if (!Array.isArray(data.content)) {
      throw new LLMError('接口返回格式无法识别（缺少 content 数组）', {
        detail: JSON.stringify(data).slice(0, 200)
      });
    }
    return data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  async function callLLM(provider, system, user) {
    if (!provider) throw new LLMError('没有可用的模型配置，请先在设置页添加');
    if (!provider.model) throw new LLMError(`模型配置“${provider.name}”未填写模型名称`);
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return provider.protocol === 'anthropic'
          ? await callAnthropic(provider, system, user)
          : await callOpenAI(provider, system, user);
      } catch (e) {
        lastErr = e instanceof LLMError ? e : new LLMError(e.message || String(e));
        if (!lastErr.retryable || attempt === MAX_RETRIES) break;
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(3, attempt)));
      }
    }
    throw lastErr;
  }

  // ---------------- 翻译提示词与结果解析 ----------------

  function buildSystemPrompt({ from, to, title, host, customPrompt }) {
    const L = root.WT_LANG;
    const toName = L.langEnglishName(to) || to;
    const fromName = L.langEnglishName(from);
    const fromText = fromName ? fromName : 'the source language (detect it automatically)';
    const lines = [
      `You are a professional translator. Translate text segments taken from a web page from ${fromText} into ${toName}.`,
      '',
      'Rules:',
      `1. Translate accurately and fluently, using natural, idiomatic ${toName} that fits the context of the page. Do not translate word by word.`,
      '2. Keep names of people, products and brands, code, URLs, e-mail addresses, numbers and emoji as appropriate. Never add explanations, notes or romanization.',
      '3. Some segments contain markers like <g0>...</g0>, <g1>...</g1>. They mark links or formatted text. Keep every marker exactly once with the same number, put the corresponding translated words inside it, and do not add new markers.',
      `4. If a segment is already in ${toName}, or is a symbol / code that should not be translated, return it unchanged.`,
      '5. The input is a JSON array of strings. Reply with ONLY a JSON array of translated strings that has exactly the same number of items in the same order. No markdown code fences, no commentary.'
    ];
    if (title || host) {
      lines.push('', `Context: the page is "${(title || '').slice(0, 120)}"${host ? ' on ' + host : ''}. Use it only to resolve ambiguity.`);
    }
    if (customPrompt && customPrompt.trim()) {
      lines.push('', 'Additional instructions from the user:', customPrompt.trim());
    }
    return lines.join('\n');
  }

  function stripWrapper(text) {
    let t = (text || '').trim();
    // 部分推理模型会在正文里输出 <think>…</think>
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
    if (fence) t = fence[1].trim();
    return t;
  }

  function parseArray(text, expected) {
    const t = stripWrapper(text);
    const candidates = [t];
    const s = t.indexOf('[');
    const e = t.lastIndexOf(']');
    if (s !== -1 && e > s) candidates.push(t.slice(s, e + 1));
    for (const c of candidates) {
      try {
        let v = JSON.parse(c);
        if (v && !Array.isArray(v) && typeof v === 'object') {
          const arr = Object.values(v).find(Array.isArray);
          if (arr) v = arr;
        }
        if (Array.isArray(v) && v.length === expected) {
          return v.map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)));
        }
      } catch (_) {
        /* 尝试下一个候选 */
      }
    }
    return null;
  }

  /** 单段兜底：模型没按 JSON 返回时，把整段回复当作译文 */
  function parseSingle(text) {
    const arr = parseArray(text, 1);
    if (arr) return arr[0];
    let t = stripWrapper(text);
    if (/^".*"$/s.test(t)) {
      try {
        t = JSON.parse(t);
      } catch (_) {}
    }
    return t;
  }

  /**
   * 翻译一批文本段。模型返回条数不符时，对半拆分后重试，直到单段。
   * @returns {Promise<string[]>}
   */
  async function translateBatch(provider, segments, ctx, depth = 0) {
    const system = buildSystemPrompt(ctx);
    const reply = await callLLM(provider, system, JSON.stringify(segments));
    if (segments.length === 1) return [parseSingle(reply)];
    const arr = parseArray(reply, segments.length);
    if (arr) return arr;
    if (depth > 6) throw new LLMError('模型返回的格式无法解析', { detail: reply.slice(0, 200) });
    const mid = Math.ceil(segments.length / 2);
    const [a, b] = await Promise.all([
      translateBatch(provider, segments.slice(0, mid), ctx, depth + 1),
      translateBatch(provider, segments.slice(mid), ctx, depth + 1)
    ]);
    return a.concat(b);
  }

  root.WT_LLM = { LLMError, buildEndpoint, buildSystemPrompt, parseArray, parseSingle, translateBatch, callLLM };
})(typeof globalThis !== 'undefined' ? globalThis : self);
