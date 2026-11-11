/* 运行：node --test tests/llm.test.js  （Node 18+，无需安装依赖） */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

require('../src/shared/languages.js');
require('../src/background/llm.js');
const { buildEndpoint, parseArray, parseSingle, translateBatch, buildSystemPrompt, createArrayStreamParser, LIMITS } =
  globalThis.WT_LLM;

test('buildEndpoint 拼接接口地址', () => {
  const o = (baseURL) => buildEndpoint({ protocol: 'openai', baseURL });
  const a = (baseURL) => buildEndpoint({ protocol: 'anthropic', baseURL });
  assert.strictEqual(o('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(o('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(o('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.strictEqual(a('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(a('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic/v1/messages');
  assert.strictEqual(a('https://proxy.com/v1'), 'https://proxy.com/v1/messages');
  assert.strictEqual(a('https://proxy.com/v1/messages'), 'https://proxy.com/v1/messages');
  assert.throws(() => o(''));
});

test('parseArray 容错解析', () => {
  assert.deepStrictEqual(parseArray('["a","b"]', 2), ['a', 'b']);
  assert.deepStrictEqual(parseArray('```json\n["a","b"]\n```', 2), ['a', 'b']);
  assert.deepStrictEqual(parseArray('好的：\n["a","b"]\n以上', 2), ['a', 'b']);
  assert.deepStrictEqual(parseArray('<think>嗯</think>["a"]', 1), ['a']);
  assert.deepStrictEqual(parseArray('{"translations":["a","b"]}', 2), ['a', 'b']);
  assert.strictEqual(parseArray('["a"]', 2), null);
  assert.strictEqual(parseArray('not json', 1), null);
  assert.strictEqual(parseSingle('你好'), '你好');
  assert.strictEqual(parseSingle('["你好"]'), '你好');
});

test('buildSystemPrompt 包含语言与自定义要求', () => {
  const p = buildSystemPrompt({ from: 'ja', to: 'zh-CN', title: 'T', host: 'h.jp', customPrompt: '术语X' });
  assert.match(p, /from Japanese into Simplified Chinese/);
  assert.match(p, /术语X/);
  const auto = buildSystemPrompt({ from: 'auto', to: 'en' });
  assert.match(auto, /detect it automatically/);
});

// ---------------- 模拟服务端 ----------------
function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, JSON.parse(body || '{}'), res));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const fakeTranslate = (segs) => segs.map((s) => '译:' + s);

test('OpenAI 协议：请求格式与解析', async () => {
  let seen;
  const server = await startMock((req, body, res) => {
    seen = { url: req.url, auth: req.headers.authorization, body };
    const segs = JSON.parse(body.messages[1].content);
    send(res, 200, { choices: [{ message: { content: JSON.stringify(fakeTranslate(segs)) } }] });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = { protocol: 'openai', baseURL: base, apiKey: 'sk-1', model: 'm', temperature: '0.3', extraBody: '{"foo":1}' };
  const out = await translateBatch(provider, ['こんにちは', '世界'], { from: 'ja', to: 'zh-CN' });
  server.close();
  assert.deepStrictEqual(out, ['译:こんにちは', '译:世界']);
  assert.strictEqual(seen.url, '/chat/completions');
  assert.strictEqual(seen.auth, 'Bearer sk-1');
  assert.strictEqual(seen.body.model, 'm');
  assert.strictEqual(seen.body.temperature, 0.3);
  assert.strictEqual(seen.body.foo, 1);
  assert.strictEqual(seen.body.messages[0].role, 'system');
  assert.strictEqual(seen.body.stream, true, '默认请求流式输出');
});

test('Anthropic 协议：请求格式与解析', async () => {
  let seen;
  const server = await startMock((req, body, res) => {
    seen = { url: req.url, headers: req.headers, body };
    const segs = JSON.parse(body.messages[0].content);
    send(res, 200, {
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: JSON.stringify(fakeTranslate(segs)) }
      ],
      stop_reason: 'end_turn'
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = { protocol: 'anthropic', baseURL: base, apiKey: 'ak', model: 'claude-x', maxTokens: 4096, temperature: '' };
  const out = await translateBatch(provider, ['안녕하세요'], { from: 'ko', to: 'zh-CN' });
  server.close();
  assert.deepStrictEqual(out, ['译:안녕하세요']);
  assert.strictEqual(seen.url, '/v1/messages');
  assert.strictEqual(seen.headers['x-api-key'], 'ak');
  assert.strictEqual(seen.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(seen.body.max_tokens, 4096);
  assert.strictEqual(typeof seen.body.system, 'string');
  assert.ok(!('temperature' in seen.body), '留空时不应发送 temperature');
  assert.strictEqual(seen.body.stream, true, '默认请求流式输出');
});

test('返回条数不符时对半拆分重试', async () => {
  let calls = 0;
  const server = await startMock((req, body, res) => {
    calls++;
    const segs = JSON.parse(body.messages[1].content);
    // 多于 2 段时故意少返回一条
    const out = fakeTranslate(segs);
    if (segs.length > 2) out.pop();
    send(res, 200, { choices: [{ message: { content: JSON.stringify(out) } }] });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = await translateBatch({ protocol: 'openai', baseURL: base, model: 'm' }, ['a', 'b', 'c', 'd'], { to: 'zh-CN' });
  server.close();
  assert.deepStrictEqual(out, ['译:a', '译:b', '译:c', '译:d']);
  assert.strictEqual(calls, 3);
});

test('HTTP 错误转为中文提示，401 不重试', async () => {
  let calls = 0;
  const server = await startMock((req, body, res) => {
    calls++;
    send(res, 401, { error: { message: 'Authentication Fails' } });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    translateBatch({ protocol: 'openai', baseURL: base, model: 'm' }, ['a'], { to: 'zh-CN' }),
    (e) => /API Key 无效/.test(e.message) && e.detail === 'Authentication Fails'
  );
  server.close();
  assert.strictEqual(calls, 1);
});

// ---------------- 流式输出 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 逐条写出 SSE 事件，每条之间间隔 gap 毫秒 */
async function writeSSE(res, events, gap = 15) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': keep-alive\n\n');
  for (const ev of events) {
    await sleep(gap);
    if (res.destroyed) return;
    res.write(typeof ev === 'string' ? ev : `data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

/** 把一段文本切成小块，模拟模型逐步输出 */
function chunks(text, size = 3) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
const openaiDeltas = (text) => [
  ...chunks(text).map((c) => ({ choices: [{ delta: { content: c } }] })),
  'data: [DONE]\n\n'
];

test('流式解析器：逐字输入时逐条回调，支持转义、think 前缀与代码块', () => {
  const items = [];
  const partials = [];
  const p = createArrayStreamParser({
    onItem: (i, t) => items.push([i, t]),
    onPartial: (i, t) => partials.push([i, t])
  });
  const reply = '<think>先想一想 [不是数组]</think>\n```json\n["你好，\\"世界\\"", "a\\nb\\u4f60\\ud83d\\ude00", "<g0>链接</g0>"]\n```';
  for (const ch of reply) p.push(ch);
  assert.deepStrictEqual(items, [
    [0, '你好，"世界"'],
    [1, 'a\nb你😀'],
    [2, '<g0>链接</g0>']
  ]);
  assert.ok(partials.some(([i, t]) => i === 0 && t === '你好'), '元素未写完时应回调部分内容');

  const bail = [];
  const q = createArrayStreamParser({ onItem: (i, t) => bail.push(t) });
  q.push('[1, "a"]');
  assert.deepStrictEqual(bail, [], '非字符串数组时放弃流式解析');
});

test('OpenAI 协议流式输出：每译好一段立即回调，最终结果完整', async () => {
  const segs = ['one', 'two', 'three'];
  const server = await startMock((req, body, res) => writeSSE(res, openaiDeltas(JSON.stringify(fakeTranslate(segs)))));
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  let doneAt = 0;
  const t0 = Date.now();
  const out = await translateBatch({ protocol: 'openai', baseURL: base, model: 'm' }, segs, { to: 'zh-CN' }, {
    onItem: (i, t) => seen.push({ i, t, at: Date.now() - t0 })
  });
  doneAt = Date.now() - t0;
  server.close();
  assert.deepStrictEqual(out, fakeTranslate(segs));
  assert.deepStrictEqual(seen.map((x) => [x.i, x.t]), fakeTranslate(segs).map((t, i) => [i, t]));
  assert.ok(seen[0].at < doneAt - 50, `第一段应明显早于整批完成（${seen[0].at}ms vs ${doneAt}ms）`);
});

test('Anthropic 协议流式输出：忽略思考内容，只取正文', async () => {
  const segs = ['안녕', '세계'];
  const text = JSON.stringify(fakeTranslate(segs));
  const server = await startMock((req, body, res) =>
    writeSSE(res, [
      'event: message_start\n' + `data: ${JSON.stringify({ type: 'message_start', message: {} })}\n\n`,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '["不要"]' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'ping' },
      ...chunks(text).map((c) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } })),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' }
    ])
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  const out = await translateBatch(
    { protocol: 'anthropic', baseURL: base, model: 'c', maxTokens: 1024 },
    segs,
    { to: 'zh-CN' },
    { onItem: (i, t) => seen.push(t) }
  );
  server.close();
  assert.deepStrictEqual(out, fakeTranslate(segs));
  assert.deepStrictEqual(seen, fakeTranslate(segs));
});

test('取消请求：立即中止且不重试', async () => {
  let calls = 0;
  const server = await startMock((req, body, res) => {
    calls++;
    writeSSE(res, openaiDeltas(JSON.stringify(['很长的译文'.repeat(50)])), 30);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 80);
  const t0 = Date.now();
  await assert.rejects(
    translateBatch({ protocol: 'openai', baseURL: base, model: 'm' }, ['x'], { to: 'zh-CN' }, { signal: ctrl.signal }),
    (e) => e.cancelled === true
  );
  assert.ok(Date.now() - t0 < 1000, '取消后应立即返回');
  await sleep(50);
  server.close();
  assert.strictEqual(calls, 1);
});

test('超过空闲时间没有新内容时超时重试，模型持续输出时不超时', async () => {
  const saved = Object.assign({}, LIMITS);
  Object.assign(LIMITS, { idleTimeoutMs: 150, retryBaseMs: 10 });
  try {
    // 1) 每 60ms 输出一小段、总耗时远超 150ms：不应超时
    const slow = await startMock((req, body, res) => writeSSE(res, openaiDeltas(JSON.stringify(['慢慢输出的译文'])), 60));
    const out = await translateBatch(
      { protocol: 'openai', baseURL: `http://127.0.0.1:${slow.address().port}`, model: 'm' },
      ['x'],
      { to: 'zh-CN' }
    );
    slow.close();
    assert.deepStrictEqual(out, ['慢慢输出的译文']);

    // 2) 输出一段后卡住：超时并重试，最终报错
    let calls = 0;
    const stuck = await startMock((req, body, res) => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '["半' } }] })}\n\n`);
    });
    await assert.rejects(
      translateBatch({ protocol: 'openai', baseURL: `http://127.0.0.1:${stuck.address().port}`, model: 'm' }, ['x'], {
        to: 'zh-CN'
      }),
      (e) => /没有返回新内容/.test(e.message)
    );
    stuck.closeAllConnections();
    stuck.close();
    assert.strictEqual(calls, LIMITS.maxRetries + 1);
  } finally {
    Object.assign(LIMITS, saved);
  }
});

test('输出中途收到服务繁忙错误时重试', async () => {
  const saved = Object.assign({}, LIMITS);
  LIMITS.retryBaseMs = 10;
  let calls = 0;
  const server = await startMock((req, body, res) => {
    calls++;
    if (calls === 1) {
      return writeSSE(res, [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '["半' } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      ]);
    }
    writeSSE(res, [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '["完整"]' } }]);
  });
  try {
    const out = await translateBatch(
      { protocol: 'anthropic', baseURL: `http://127.0.0.1:${server.address().port}`, model: 'c' },
      ['x'],
      { to: 'zh-CN' }
    );
    assert.deepStrictEqual(out, ['完整']);
    assert.strictEqual(calls, 2);
  } finally {
    server.close();
    Object.assign(LIMITS, saved);
  }
});

test('流式输出条数不符时，拆分重试的结果覆盖错位的临时结果', async () => {
  const server = await startMock((req, body, res) => {
    const segs = JSON.parse(body.messages[1].content);
    const out = fakeTranslate(segs);
    // 4 段时把第 2、3 段合并，导致后面的结果错位
    if (segs.length === 4) out.splice(1, 2, out[1] + out[2]);
    writeSSE(res, openaiDeltas(JSON.stringify(out)), 5);
  });
  const latest = [];
  const out = await translateBatch(
    { protocol: 'openai', baseURL: `http://127.0.0.1:${server.address().port}`, model: 'm' },
    ['a', 'b', 'c', 'd'],
    { to: 'zh-CN' },
    { onItem: (i, t) => (latest[i] = t) }
  );
  server.close();
  assert.deepStrictEqual(out, fakeTranslate(['a', 'b', 'c', 'd']));
  assert.deepStrictEqual(latest, out, '页面上最终显示的应是正确结果');
});
