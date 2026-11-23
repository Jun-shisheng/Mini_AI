import test from 'node:test';
import assert from 'node:assert/strict';
import { api, streamChat } from '../src/api.js';

async function usingFetch(stub, action) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); }
  finally { globalThis.fetch = previous; }
}

function eventResponse(source, chunkSize = 1, type = 'text/event-stream; charset=utf-8') {
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
      controller.close();
    },
  }), { headers: { 'Content-Type': type } });
}

const frame = (event, data, separator = '\n') => `event: ${event}${separator}data: ${JSON.stringify(data)}${separator}${separator}`;
const ask = (onEvent = () => {}) => streamChat('conversation-id', { content: '你好', thinking: false }, new AbortController().signal, onEvent);

test('API requests serialize JSON, use same-origin cookies and surface server messages', async () => {
  await usingFetch(async (url, options) => {
    assert.equal(url, '/api/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { username: 'reader', password: 'example-password' });
    return Response.json({ user: { username: 'reader' } });
  }, async () => {
    const result = await api('/auth/login', { method: 'POST', body: { username: 'reader', password: 'example-password' } });
    assert.equal(result.user.username, 'reader');
  });
  await usingFetch(async () => Response.json({ error: { message: '请先登录。' } }, { status: 401 }), async () => {
    await assert.rejects(() => api('/usage'), /请先登录/u);
  });
});

test('one-byte SSE chunks preserve Chinese UTF-8, event order, reasoning, deltas and terminal metadata', async () => {
  const controller = new AbortController();
  const events = [];
  const source = ': keepalive\n\n' + frame('meta', { conversationId: 'id' })
    + frame('reasoning', { text: '先想一想。' }) + frame('delta', { text: '你好，' })
    + frame('delta', { text: '我在听。' }) + frame('done', { message: { content: '你好，我在听。', status: 'complete' } });
  await usingFetch(async (url, options) => {
    assert.equal(url, '/api/conversations/id%2Fwith%20space/chat');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), { content: '你好' });
    return eventResponse(source);
  }, () => streamChat('id/with space', { content: '你好' }, controller.signal, (event, data) => events.push({ event, data })));
  assert.deepEqual(events.map((event) => event.event), ['meta', 'reasoning', 'delta', 'delta', 'done']);
  assert.equal(events.filter((event) => event.event === 'delta').map((event) => event.data.text).join(''), '你好，我在听。');
  assert.equal(events.at(-1).data.message.status, 'complete');
});

test('CRLF delimiters split between byte chunks are handled as complete SSE frames', async () => {
  const events = [];
  const source = frame('delta', { text: '完整的一句。' }, '\r\n') + frame('done', { message: { status: 'complete' } }, '\r\n');
  await usingFetch(async () => eventResponse(source), () => ask((event, data) => events.push({ event, data })));
  assert.deepEqual(events.map((event) => event.event), ['delta', 'done']);
  assert.equal(events[0].data.text, '完整的一句。');
});

test('a multiline data frame and final frame without trailing blank line are parsed', async () => {
  const events = [];
  const source = 'event: delta\ndata: {\ndata: "text": "多行帧"\ndata: }\n\n' + 'event: done\ndata: {"message":{"status":"complete"}}';
  await usingFetch(async () => eventResponse(source, 7), () => ask((event, data) => events.push({ event, data })));
  assert.equal(events[0].data.text, '多行帧');
  assert.equal(events.at(-1).event, 'done');
});

test('provider-style DONE marker terminates a stream without inventing a done payload', async () => {
  const events = [];
  await usingFetch(async () => eventResponse(frame('delta', { text: '已有正文' }) + 'data: [DONE]\n\n', 5), () => ask((event, data) => events.push({ event, data })));
  assert.deepEqual(events, [{ event: 'delta', data: { text: '已有正文' } }]);
});

test('an SSE error rejects with its user-facing message after preserving received events', async () => {
  const events = [];
  await usingFetch(async () => eventResponse(frame('delta', { text: '已收到的部分。' }) + frame('error', { code: 'UPSTREAM_FAILED', message: '模型服务暂时不可用。' })), async () => {
    await assert.rejects(() => ask((event, data) => events.push({ event, data })), /模型服务暂时不可用/u);
  });
  assert.deepEqual(events, [{ event: 'delta', data: { text: '已收到的部分。' } }]);
});

test('a truncated stream rejects instead of marking partial output complete', async () => {
  const events = [];
  await usingFetch(async () => eventResponse(frame('meta', { conversationId: 'id' }) + frame('delta', { text: '只收到一半' })), async () => {
    await assert.rejects(() => ask((event, data) => events.push({ event, data })), /连接已中断/u);
  });
  assert.deepEqual(events.map((event) => event.event), ['meta', 'delta']);
});

test('non-SSE responses, invalid frame JSON and HTTP failures use actionable errors', async () => {
  await usingFetch(async () => new Response('<html>proxy failure</html>', { headers: { 'Content-Type': 'text/html' } }), async () => {
    await assert.rejects(() => ask(), /服务器未返回对话流/u);
  });
  await usingFetch(async () => eventResponse('event: delta\ndata: {"text":\n\n'), async () => {
    await assert.rejects(() => ask(), /对话流格式异常/u);
  });
  await usingFetch(async () => Response.json({ error: { message: '已有回复正在生成，请先停止。' } }, { status: 409 }), async () => {
    await assert.rejects(() => ask(), /已有回复正在生成/u);
  });
});

test('fetch abort errors preserve their AbortError identity for stop handling', async () => {
  await usingFetch(async () => { throw new DOMException('The request was aborted', 'AbortError'); }, async () => {
    await assert.rejects(() => ask(), (error) => error.name === 'AbortError');
  });
});
