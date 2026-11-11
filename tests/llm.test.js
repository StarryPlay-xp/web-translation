/* 运行：node --test tests/llm.test.js  （Node 18+，无需安装依赖） */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

require('../src/shared/languages.js');
require('../src/background/llm.js');
const { buildEndpoint, parseArray, parseSingle, translateBatch, buildSystemPrompt } = globalThis.WT_LLM;

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
