/* 大模型调用：兼容 OpenAI Chat Completions 协议与 Anthropic Messages 协议（流式输出） */
(function (root) {
  /** 超时与重试参数（导出以便测试调整） */
  const LIMITS = {
    connectTimeoutMs: 90 * 1000, // 发出请求后，等待服务端开始响应的最长时间
    idleTimeoutMs: 60 * 1000, // 开始响应后，连续多久收不到任何数据才算超时；模型持续输出时不会触发
    maxRetries: 2,
    retryBaseMs: 1000 // 重试等待：1 秒、3 秒……
  };

  class LLMError extends Error {
    constructor(message, { status, retryable, detail, cancelled } = {}) {
      super(message);
      this.status = status;
      this.retryable = !!retryable;
      this.detail = detail || '';
      this.cancelled = !!cancelled; // 调用方主动取消（关闭翻译、切换语言、关闭划词面板等）
    }
  }

  const cancelledError = () => new LLMError('已取消', { cancelled: true });

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

  /** 流式输出过程中服务端发来的错误事件 */
  function streamError(err) {
    const type = String((err && (err.type || err.code)) || '');
    const message = String((err && err.message) || (typeof err === 'string' ? err : JSON.stringify(err)));
    return new LLMError('模型服务在输出过程中出错', {
      retryable: /overload|server|internal|timeout|rate|busy|unavailable/i.test(type + ' ' + message),
      detail: message.slice(0, 200)
    });
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(cancelledError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(cancelledError());
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 发送请求并读取响应。
   *  - 服务端返回 SSE 流（以 data: / event: / : 开头）时，每条事件的 JSON 交给 onEvent，函数返回 null；
   *  - 服务端忽略了 stream 参数、返回普通 JSON 时，整体解析后返回该对象。
   * 超时分两段：等待开始响应最多 connectTimeoutMs；开始响应后连续 idleTimeoutMs 收不到数据才算超时。
   */
  async function requestLLM(url, headers, body, { signal, onEvent }) {
    if (signal && signal.aborted) throw cancelledError();
    const ctrl = new AbortController();
    let timeoutMsg = '';
    let timer = null;
    const arm = (ms, msg) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timeoutMsg = msg;
        ctrl.abort();
      }, ms);
    };
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      arm(LIMITS.connectTimeoutMs, `请求超时（超过 ${Math.round(LIMITS.connectTimeoutMs / 1000)} 秒未响应）`);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
      } catch (e) {
        throw new LLMError('无法连接到接口地址：' + url, { retryable: true, detail: e.message });
      }

      const idleMsg = `请求超时（模型超过 ${Math.round(LIMITS.idleTimeoutMs / 1000)} 秒没有返回新内容）`;
      arm(LIMITS.idleTimeoutMs, idleMsg);
      if (!resp.ok) throw friendlyHttpError(resp.status, await resp.text());

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let mode = null; // null 尚未判断 | 'sse' 流式事件 | 'json' 普通 JSON
      let pending = ''; // 判断格式前收到的内容 / SSE 中尚未凑成整行的内容
      let raw = ''; // JSON 模式下的完整响应
      let finished = false;

      // 返回 true 表示收到结束标记
      const handleLine = (line) => {
        if (!line.startsWith('data:')) return false; // event: 行、: 开头的心跳注释、空行
        const data = line.slice(5).trim();
        if (data === '[DONE]') return true;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch (_) {
          return false;
        }
        onEvent(ev);
        return false;
      };

      while (!finished) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          throw new LLMError('读取模型返回内容时连接中断', { retryable: true, detail: e.message });
        }
        arm(LIMITS.idleTimeoutMs, idleMsg);
        let text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        if (mode === null) {
          pending += text;
          const head = pending.trimStart();
          if (!head) {
            if (chunk.done) break;
            continue; // DeepSeek 等服务排队时会先发送空行保持连接
          }
          mode = head[0] === '{' || head[0] === '[' ? 'json' : 'sse';
          text = pending;
          pending = '';
        }
        if (mode === 'json') {
          raw += text;
          if (chunk.done) finished = true;
          continue;
        }
        pending += text;
        let nl;
        while ((nl = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, nl).replace(/\r$/, '');
          pending = pending.slice(nl + 1);
          if (handleLine(line)) {
            finished = true;
            break;
          }
        }
        if (chunk.done && !finished) {
          if (pending) handleLine(pending.replace(/\r$/, ''));
          finished = true;
        }
      }

      if (mode === 'json') {
        try {
          return JSON.parse(raw);
        } catch (_) {
          throw new LLMError('接口返回的不是 JSON，请检查接口地址是否正确', { detail: raw.slice(0, 200) });
        }
      }
      if (mode === null) throw new LLMError('接口返回了空内容', { retryable: true });
      return null;
    } catch (e) {
      // 被调用方取消或超时导致的连接中断，换成对应的提示
      if (signal && signal.aborted) throw cancelledError();
      if (timeoutMsg) throw new LLMError(timeoutMsg, { retryable: true });
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      ctrl.abort(); // 释放连接（已读完时无副作用；提前收到结束标记时丢弃剩余内容）
    }
  }

  function joinParts(content) {
    return content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  }

  async function callOpenAI(provider, system, user, { signal, onDelta } = {}) {
    const body = Object.assign(
      {
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: true
      },
      parseExtraBody(provider)
    );
    const temperature = parseTemperature(provider);
    if (temperature !== undefined) body.temperature = temperature;
    const headers = {};
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey.trim();

    let text = '';
    const data = await requestLLM(buildEndpoint(provider), headers, body, {
      signal,
      onEvent(ev) {
        if (ev.error) throw streamError(ev.error);
        const choice = ev.choices && ev.choices[0];
        const delta = choice && (choice.delta || choice.message);
        let piece = delta && delta.content; // 思考过程在 reasoning_content 中，直接忽略
        if (Array.isArray(piece)) piece = joinParts(piece);
        if (typeof piece === 'string' && piece) {
          text += piece;
          if (onDelta) onDelta(piece);
        }
      }
    });
    if (!data) return text;

    // 服务端不支持流式、直接返回了完整 JSON
    const choice = data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) content = joinParts(content);
    if (typeof content !== 'string') {
      throw new LLMError('接口返回格式无法识别（缺少 choices[0].message.content）', {
        detail: JSON.stringify(data).slice(0, 200)
      });
    }
    return content;
  }

  async function callAnthropic(provider, system, user, { signal, onDelta } = {}) {
    const body = Object.assign(
      {
        model: provider.model,
        max_tokens: Number(provider.maxTokens) || 8192,
        system,
        messages: [{ role: 'user', content: user }],
        stream: true
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

    let text = '';
    let stopReason = '';
    const data = await requestLLM(buildEndpoint(provider), headers, body, {
      signal,
      onEvent(ev) {
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          const piece = ev.delta.text || '';
          text += piece;
          if (onDelta && piece) onDelta(piece);
        } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
          stopReason = ev.delta.stop_reason;
        } else if (ev.type === 'error') {
          throw streamError(ev.error);
        }
      }
    });
    if (!data) {
      if (stopReason === 'refusal') throw new LLMError('模型拒绝翻译这段内容');
      return text;
    }

    // 服务端不支持流式、直接返回了完整 JSON
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

  /**
   * 调用模型并返回完整回复文本。
   * opts.signal   ：AbortSignal，取消后立即中止请求且不再重试
   * opts.onDelta  ：每收到一小段输出时回调
   * opts.onAttempt：每次（重新）发起请求前回调，用于重置流式解析状态
   */
  async function callLLM(provider, system, user, opts = {}) {
    if (!provider) throw new LLMError('没有可用的模型配置，请先在设置页添加');
    if (!provider.model) throw new LLMError(`模型配置“${provider.name}”未填写模型名称`);
    let lastErr;
    for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt++) {
      if (opts.onAttempt) opts.onAttempt(attempt);
      try {
        return provider.protocol === 'anthropic'
          ? await callAnthropic(provider, system, user, opts)
          : await callOpenAI(provider, system, user, opts);
      } catch (e) {
        lastErr = e instanceof LLMError ? e : new LLMError(e.message || String(e));
        if (lastErr.cancelled || !lastErr.retryable || attempt === LIMITS.maxRetries) break;
        await sleep(LIMITS.retryBaseMs * Math.pow(3, attempt), opts.signal);
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

  const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

  /**
   * 流式解析模型逐步输出的 JSON 字符串数组：
   *  - 每解析完一个元素回调 onItem(index, text)；
   *  - 某个元素还没写完时回调 onPartial(index, 已写出的部分)。
   * 数组前的 <think>…</think>、```json、说明文字会被跳过；遇到非字符串元素时停止流式解析，
   * 最终结果仍以完整回复的解析为准。
   */
  function createArrayStreamParser({ onItem, onPartial } = {}) {
    let text = '';
    let pos = 0;
    let phase = 'seek'; // seek 寻找数组开头 | value 等待下一个元素 | string 元素内 | end 结束 | bail 放弃
    let thinkChecked = false;
    let index = 0;
    let cur = '';
    let partialLen = 0;

    function seek() {
      if (!thinkChecked) {
        const start = pos + /^\s*/.exec(text.slice(pos))[0].length;
        const rest = text.slice(start, start + 7);
        if (rest.length < 7 && '<think>'.startsWith(rest)) return false; // 内容还不够判断
        if (rest === '<think>') {
          const end = text.indexOf('</think>', start + 7);
          if (end === -1) return false;
          pos = end + 8;
        }
        thinkChecked = true;
      }
      const b = text.indexOf('[', pos);
      if (b === -1) {
        pos = text.length;
        return false;
      }
      pos = b + 1;
      phase = 'value';
      return true;
    }

    function step() {
      while (pos < text.length) {
        if (phase === 'seek') {
          if (!seek()) return;
          continue;
        }
        if (phase === 'end' || phase === 'bail') return;
        const ch = text[pos];
        if (phase === 'value') {
          if (ch === '"') {
            phase = 'string';
            cur = '';
            partialLen = 0;
            pos++;
          } else if (ch === ']') {
            phase = 'end';
          } else if (ch === ',' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
            pos++;
          } else {
            phase = 'bail';
          }
          continue;
        }
        // phase === 'string'
        if (ch === '"') {
          if (onItem) onItem(index, cur);
          index++;
          cur = '';
          phase = 'value';
          pos++;
        } else if (ch === '\\') {
          if (pos + 1 >= text.length) return; // 等待转义字符
          const e = text[pos + 1];
          if (e === 'u') {
            if (pos + 6 > text.length) return;
            const hex = text.slice(pos + 2, pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              phase = 'bail';
              return;
            }
            cur += String.fromCharCode(parseInt(hex, 16));
            pos += 6;
          } else {
            cur += ESCAPES[e] !== undefined ? ESCAPES[e] : e;
            pos += 2;
          }
        } else {
          let j = pos;
          while (j < text.length && text[j] !== '"' && text[j] !== '\\') j++;
          cur += text.slice(pos, j);
          pos = j;
        }
      }
    }

    return {
      push(chunk) {
        text += chunk;
        step();
        if (phase === 'string' && onPartial && cur.length > partialLen) {
          partialLen = cur.length;
          onPartial(index, cur);
        }
      }
    };
  }

  /**
   * 翻译一批文本段，返回与输入等长的译文数组。
   * opts.onItem(i, text)   ：某一段译文可用时立即回调（流式阶段先回调，最终结果不同时会再次回调覆盖）
   * opts.onPartial(i, text)：某一段译文正在输出时回调已输出的部分（用于划词面板逐字显示）
   * opts.signal            ：AbortSignal，用于取消
   * 模型返回条数不符时，对半拆分后重试，直到单段。
   * @returns {Promise<string[]>}
   */
  async function translateBatch(provider, segments, ctx, opts = {}, depth = 0) {
    const n = segments.length;
    const onItem = opts.onItem;
    const onPartial = opts.onPartial;
    const sent = new Array(n); // 已回调过的译文，避免重复回调相同内容
    const emit = (i, t) => {
      if (i >= n || sent[i] === t) return;
      sent[i] = t;
      if (onItem) onItem(i, t);
    };
    let parser = null;
    const reply = await callLLM(provider, buildSystemPrompt(ctx), JSON.stringify(segments), {
      signal: opts.signal,
      onAttempt: () => {
        parser = createArrayStreamParser({
          onItem: emit,
          onPartial: onPartial && ((i, t) => i < n && onPartial(i, t))
        });
      },
      onDelta: (chunk) => parser.push(chunk)
    });

    const result = n === 1 ? [parseSingle(reply)] : parseArray(reply, n);
    if (result) {
      result.forEach((t, i) => emit(i, t));
      return result;
    }
    if (depth > 6) throw new LLMError('模型返回的格式无法解析', { detail: reply.slice(0, 200) });
    // 条数不符：流式阶段回调过的结果可能错位，拆分重试后的结果会覆盖它们
    const mid = Math.ceil(n / 2);
    const part = (from, segs) =>
      translateBatch(
        provider,
        segs,
        ctx,
        {
          signal: opts.signal,
          onItem: (i, t) => emit(from + i, t),
          onPartial: onPartial && ((i, t) => onPartial(from + i, t))
        },
        depth + 1
      );
    const [a, b] = await Promise.all([part(0, segments.slice(0, mid)), part(mid, segments.slice(mid))]);
    return a.concat(b);
  }

  root.WT_LLM = {
    LLMError,
    LIMITS,
    buildEndpoint,
    buildSystemPrompt,
    parseArray,
    parseSingle,
    createArrayStreamParser,
    translateBatch,
    callLLM
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
