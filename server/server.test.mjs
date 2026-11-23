import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from './index.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-companion-test-'));
  const app = createApp({ dataDir, staticDir: join(dataDir, 'dist'), apiKey: '', demoDelayMs: 0, ...options });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    // Only delete the isolated directory that this test just created.
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert(resolve(dataDir).split(/[\\/]/).at(-1).startsWith('ds-companion-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (path, { cookie, method = 'GET', data, origin, ...extra } = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(origin ? { Origin: origin } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), ...extra,
  });
  async function register(username = '测试用户', password = 'password123') {
    const response = await request('/api/auth/register', { method: 'POST', data: { username, password } });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user, response };
  }
  async function conversation(cookie, data = {}) {
    const response = await request('/api/conversations', { method: 'POST', cookie, data });
    assert.equal(response.status, 201);
    return (await response.json()).conversation;
  }
  return { app, base, dataDir, request, register, conversation };
}

function eventsFrom(source) {
  return source.split('\n\n').filter((block) => block.startsWith('event: ')).map((block) => ({
    event: block.split('\n')[0].slice(7), data: JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6)),
  }));
}

function upstreamResponse(frames, chunkSize = 7) {
  const bytes = new TextEncoder().encode(frames.map((value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('authentication uses protected cookies, rejects invalid credentials and cross-site writes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/me')).status, 401);
  assert.equal((await f.request('/api/auth/register', { method: 'POST', origin: 'https://attacker.example', data: { username: 'hacker', password: 'password123' } })).status, 403);
  const account = await f.register();
  const cookie = account.response.headers.get('set-cookie');
  assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Strict'));
  const me = await f.request('/api/auth/me', { cookie: account.cookie });
  assert.equal((await me.json()).user.id, account.user.id);
  const duplicate = await f.request('/api/auth/register', { method: 'POST', data: { username: '测试用户', password: 'password123' } });
  assert.equal(duplicate.status, 409);
  const wrong = await f.request('/api/auth/login', { method: 'POST', data: { username: '测试用户', password: 'wrongpass' } });
  assert.equal(wrong.status, 401);
  const login = await f.request('/api/auth/login', { method: 'POST', data: { username: '测试用户', password: 'password123' } });
  assert.equal(login.status, 200);
  const encoded = f.app.store.findUser('测试用户').password_hash;
  assert(!encoded.includes('password123'));
  await f.request('/api/auth/logout', { method: 'POST', cookie: account.cookie });
  assert.equal((await f.request('/api/auth/me', { cookie: account.cookie })).status, 401);
});

test('conversations and imports stay isolated; persisted payloads are encrypted', async (t) => {
  const f = await fixture(t);
  const alice = await f.register('alice');
  const bob = await f.register('bob');
  const c = await f.conversation(alice.cookie, { title: '私密标题', persona: { name: '阿栖', memory: '这是一段不应明文落盘的记忆' } });
  assert.equal((await f.request(`/api/conversations/${c.id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await f.request(`/api/conversations/${c.id}`, { method: 'PATCH', cookie: bob.cookie, data: { title: '恶意修改' } })).status, 404);
  assert.equal((await f.request(`/api/conversations/${c.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
  const raw = f.app.store.db.prepare('SELECT payload FROM conversations WHERE id=?').get(c.id).payload;
  assert(raw.startsWith('v1.')); assert(!raw.includes('阿栖')); assert(!raw.includes('私密标题')); assert(!raw.includes('记忆'));
  assert.equal((await readFile(join(f.dataDir, '.storage-key'))).length, 32);
  const imported = await f.request('/api/import', { method: 'POST', cookie: alice.cookie, data: { data: [{ title: '导入', messages: [{ role: 'user', content: '旧记忆' }, { role: 'assistant', content: '旧回复' }] }] } });
  assert.equal(imported.status, 201);
  const importedData = await imported.json();
  assert.equal(importedData.count, 1); assert.equal(importedData.conversations[0].messages.length, 2);
  assert(importedData.conversations[0].messages.every((message) => message.source === 'import'));
  const bobList = await f.request('/api/conversations', { cookie: bob.cookie });
  assert.deepEqual((await bobList.json()).conversations, []);
  const invalid = await f.request('/api/import', { method: 'POST', cookie: alice.cookie, data: { data: [{ messages: [{ role: 'tool', content: 'invalid' }] }] } });
  assert.equal(invalid.status, 400);
  const aliceList = await f.request('/api/conversations', { cookie: alice.cookie });
  assert.equal((await aliceList.json()).conversations.length, 2);
});

test('demo streams explicitly labeled text, saves history, and regenerates without duplicate user turns', async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.register();
  const c = await f.conversation(cookie);
  const response = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { content: '今天过得怎么样？' } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = eventsFrom(await response.text());
  assert.equal(events[0].event, 'meta'); assert.equal(events[0].data.mode, 'demo');
  assert(events.some((entry) => entry.event === 'delta'));
  const done = events.at(-1);
  assert.equal(done.event, 'done'); assert.equal(done.data.message.status, 'complete');
  assert.equal(done.data.message.mode, 'demo'); assert.equal(done.data.message.model, 'deepseek-flash');
  assert(done.data.message.content.includes('演示模式')); assert(done.data.message.content.includes('未调用 DeepSeek'));
  assert.equal(done.data.usage.inputTokens, 0); assert.equal(done.data.usage.source, 'demo');
  const regenerated = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { regenerate: true } });
  const next = eventsFrom(await regenerated.text()).at(-1).data;
  assert.equal(next.conversation.messages.length, 2); assert.notEqual(next.message.id, done.data.message.id);
  const usage = await f.request('/api/usage', { cookie });
  const summary = await usage.json();
  assert.equal(summary.totals.requests, 2); assert.equal(summary.totals.demoRequests, 2);
  assert.equal(summary.totals.inputTokens, 0);
});

test('live proxy fixes Flash, protects the key, handles fragmented SSE, and records provider usage', async (t) => {
  let captured;
  const f = await fixture(t, { apiKey: 'test-upstream-secret', fetchImpl: async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return upstreamResponse([
      { choices: [{ delta: { reasoning_content: '思考片段。' } }] },
      { choices: [{ delta: { content: '你好，世界。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 100 } }, '[DONE]',
    ], 3);
  } });
  const { cookie } = await f.register();
  const c = await f.conversation(cookie, { persona: { name: '阿栖', memory: '用户喜欢雨天' } });
  const response = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { content: '你好', thinking: true, model: 'deepseek-v4-pro', apiKey: 'attacker' } });
  const source = await response.text();
  assert(!source.includes('test-upstream-secret'));
  const result = eventsFrom(source).at(-1).data;
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.equal(typeof captured.body.user_id, 'string');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-upstream-secret');
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
  assert.deepEqual(captured.body.safety_check, { level: 'high' });
  assert.equal(captured.body.max_tokens, 4096);
  assert(captured.body.messages[0].content.includes('用户喜欢雨天'));
  assert.equal(result.message.content, '你好，世界。'); assert.equal(result.message.reasoning, '思考片段。');
  assert.equal(result.message.mode, 'live'); assert.equal(result.message.model, 'deepseek-flash');
  assert.equal(result.usage.inputTokens, 120); assert.equal(result.usage.outputTokens, 8);
  assert.equal(result.usage.cacheHitTokens, 100); assert.equal(result.usage.cacheMissTokens, 20); assert.equal(result.usage.source, 'provider');
});

test('interrupted upstream preserves partial text and marks usage estimates honestly', async (t) => {
  const f = await fixture(t, { apiKey: 'key', fetchImpl: async () => upstreamResponse([{ choices: [{ delta: { content: '已收到的一部分' } }] }]) });
  const { cookie } = await f.register();
  const c = await f.conversation(cookie);
  const response = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { content: '继续说' } });
  const events = eventsFrom(await response.text());
  const error = events.find((entry) => entry.event === 'error');
  assert.equal(error.data.code, 'UPSTREAM_INTERRUPTED');
  const done = events.at(-1).data;
  assert.equal(done.message.status, 'error'); assert.equal(done.message.content, '已收到的一部分');
  assert.equal(done.usage.source, 'estimate');
  const persisted = await f.request(`/api/conversations/${c.id}`, { cookie });
  assert.equal((await persisted.json()).conversation.messages.at(-1).status, 'error');
});

test('regeneration failure restores the previous reply and archives the failed attempt', async (t) => {
  let attempts = 0;
  const f = await fixture(t, { apiKey: 'key', fetchImpl: async () => {
    attempts += 1;
    return attempts === 1 ? upstreamResponse([
      { choices: [{ delta: { content: '上一版完整回复' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]',
    ]) : upstreamResponse([{ choices: [{ delta: { content: '未完成的新版本' } }] }]);
  } });
  const { cookie } = await f.register();
  const c = await f.conversation(cookie);
  const first = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { content: '你好' } });
  const original = eventsFrom(await first.text()).at(-1).data.message;
  const second = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { regenerate: true } });
  const events = eventsFrom(await second.text());
  assert.equal(events.find((entry) => entry.event === 'error').data.restoredPrevious, true);
  const result = events.at(-1).data;
  assert.equal(result.message.id, original.id);
  assert.equal(result.message.content, '上一版完整回复');
  assert.equal(result.message.status, 'complete');
  assert.equal(result.message.previousVersions.at(-1).content, '未完成的新版本');
  assert.equal(result.message.previousVersions.at(-1).status, 'error');
  assert.equal(result.usage.status, 'error');
  assert.equal(result.conversation.messages.length, 2);
});

test('imports strip system instructions and failures and require explicit persona settings', async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.register();
  const response = await f.request('/api/import', { method: 'POST', cookie, data: { data: [{
    title: '旧对话', persona: { systemPrompt: '偷偷注入的指令' }, messages: [
      { role: 'system', content: '记录中隐藏的系统指令' },
      { role: 'user', content: '需要迁移的正文' },
      { role: 'assistant', content: '有效回复' },
    ],
  }], persona: { name: '主动设置的角色', systemPrompt: '明确设定' } } });
  assert.equal(response.status, 201);
  const result = await response.json();
  const c = result.conversations[0];
  assert.equal(c.messages.length, 2);
  assert(c.messages.every((message) => message.role !== 'system'));
  assert.equal(c.persona.name, '主动设置的角色');
  assert.equal(c.persona.systemPrompt, '明确设定');
  assert(result.warnings.length > 0);
});

test('restart preserves sessions and encrypted conversations and recovers interrupted generations', async (t) => {
  const f = await fixture(t);
  const { cookie, user } = await f.register();
  const c = await f.conversation(cookie, { title: '重启前的对话' });
  c.messages.push({ id: 'interrupted-message', role: 'assistant', content: '服务器关闭前收到的部分', status: 'generating', createdAt: new Date().toISOString() });
  f.app.store.saveConversation(user.id, c);
  const keyBefore = await readFile(join(f.dataDir, '.storage-key'));
  await f.app.close();
  const restarted = createApp({ dataDir: f.dataDir, apiKey: '', demoDelayMs: 0 });
  try {
    const address = await restarted.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations/${c.id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const restored = (await response.json()).conversation;
    assert.equal(restored.title, '重启前的对话');
    assert.equal(restored.messages[0].status, 'stopped');
    assert.equal(restored.messages[0].content, '服务器关闭前收到的部分');
    assert.deepEqual(await readFile(join(f.dataDir, '.storage-key')), keyBefore);
  } finally { await restarted.close(); }
});

test('stop saves partial generation and enforces a single active request per account', async (t) => {
  const f = await fixture(t, { demoDelayMs: 20 });
  const { cookie } = await f.register();
  const c = await f.conversation(cookie);
  const response = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { content: '等一下' } });
  const second = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { content: '同时发第二条' } });
  assert.equal(second.status, 409);
  const stop = await f.request(`/api/conversations/${c.id}/stop`, { method: 'POST', cookie });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).conversation.messages.at(-1).status, 'stopped');
  const immediate = await f.request(`/api/conversations/${c.id}`, { cookie });
  assert.equal((await immediate.json()).conversation.messages.at(-1).status, 'stopped');
  const done = eventsFrom(await response.text()).at(-1).data;
  assert.equal(done.message.status, 'stopped');
  assert.equal(done.conversation.messages.length, 2);
  const again = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { regenerate: true } });
  assert.equal(eventsFrom(await again.text()).at(-1).data.message.status, 'complete');
});

test('client disconnect followed immediately by GET settles the saved generation state', async (t) => {
  const f = await fixture(t, { demoDelayMs: 20 });
  const { cookie } = await f.register();
  const c = await f.conversation(cookie);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const controller = new AbortController();
    const response = await f.request(`/api/conversations/${c.id}/chat`, {
      method: 'POST', cookie, signal: controller.signal, data: attempt ? { regenerate: true } : { content: '验证断线后的状态' },
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    const immediate = await f.request(`/api/conversations/${c.id}`, { cookie });
    const saved = (await immediate.json()).conversation;
    assert.equal(saved.messages.at(-1).status, 'stopped', `attempt ${attempt + 1}`);
  }
  const resume = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', cookie, data: { regenerate: true } });
  assert.equal(resume.status, 200);
  assert.equal(eventsFrom(await resume.text()).at(-1).data.message.status, 'complete');
});

test('native Xuye backup restores explicit persona and memory after server-side revalidation', async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.register();
  const persona = { name: '阿栖', description: '雨天的书店店主', systemPrompt: '温和、简洁地交谈。', memory: '用户喜欢乌龙茶。' };
  const response = await f.request('/api/import', { method: 'POST', cookie, data: { data: {
    format: 'palm-history', version: 1, conversations: [{ title: '书店', persona, messages: [
      { role: 'user', content: '我又来了。' }, { role: 'assistant', content: '欢迎回来。' },
    ] }],
  } } });
  assert.equal(response.status, 201);
  const imported = (await response.json()).conversations[0];
  assert.deepEqual(imported.persona, persona);
  const saved = await f.request(`/api/conversations/${imported.id}`, { cookie });
  assert.deepEqual((await saved.json()).conversation.persona, persona);
});

test('static hosting serves dist only, uses SPA fallback, and hides private paths', async (t) => {
  const f = await fixture(t);
  const staticDir = join(f.dataDir, 'dist');
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<html><body>test-app</body></html>');
  await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log("app")');
  const base = f.base;
  assert((await (await fetch(`${base}/`)).text()).includes('test-app'));
  assert((await (await fetch(`${base}/chat/example`)).text()).includes('test-app'));
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/server/index.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%5c.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/no-such-endpoint`)).status, 401);
});

test('local-first chat authenticates, persists metadata only, and never sends an entire conversation back', async (t) => {
  const f = await fixture(t);
  const requestId = 'local-request-privacy';
  const secret = '本机历史私密正文-unique-local-secret';
  const body = { requestId, conversationId: 'local-conversation', messages: [{ role: 'user', content: secret }] };
  assert.equal((await f.request('/api/chat', { method: 'POST', data: body })).status, 401);
  const { cookie } = await f.register();
  const response = await f.request('/api/chat', { method: 'POST', cookie, data: body });
  assert.equal(response.status, 200);
  const events = eventsFrom(await response.text());
  const meta = events[0].data;
  const result = events.at(-1).data;
  assert.equal(meta.requestId, requestId);
  assert.equal(result.message.id, meta.assistantMessage.id);
  assert.equal(result.message.status, 'complete'); assert.equal(result.message.mode, 'demo');
  assert.equal(result.usage.requestId, requestId); assert.equal(result.usage.source, 'demo');
  assert(!Object.hasOwn(result, 'conversation')); assert(!Object.hasOwn(meta, 'conversation'));
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  for (const table of ['chat_requests', 'usage']) {
    const stored = JSON.stringify(f.app.store.db.prepare(`SELECT * FROM ${table}`).all());
    assert(!stored.includes(secret)); assert(!stored.includes(result.message.content));
  }
  const status = await f.request(`/api/chat/${requestId}`, { cookie });
  const persisted = await status.json();
  assert.equal(persisted.status, 'complete'); assert.equal(persisted.usage.requestId, requestId);
  assert(!JSON.stringify(persisted).includes(secret)); assert(!Object.hasOwn(persisted, 'message'));
  const duplicate = await f.request('/api/chat', { method: 'POST', cookie, data: body });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'REQUEST_ALREADY_USED');
  const summary = await (await f.request('/api/usage', { cookie })).json();
  assert.equal(summary.totals.requests, 1);
});

test('local-first live proxy fixes Flash and server limits and records upstream usage without storing text', async (t) => {
  let payload;
  const privateInput = 'do-not-store-input-private';
  const privateOutput = 'do-not-store-output-private';
  const f = await fixture(t, { apiKey: 'upstream-private-key', fetchImpl: async (url, init) => {
    payload = JSON.parse(init.body);
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    return upstreamResponse([
      { choices: [{ delta: { content: privateOutput } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 200, completion_tokens: 15, prompt_cache_hit_tokens: 20 } }, '[DONE]',
    ]);
  } });
  const { cookie } = await f.register();
  const response = await f.request('/api/chat', { method: 'POST', cookie, data: {
    requestId: 'live-local-request', conversationId: 'local-only-id',
    messages: [{ role: 'assistant', content: '旧助手正文' }, { role: 'user', content: privateInput }],
    thinking: false, max_tokens: 999999, model: 'deepseek-v4-pro', balance: 999999,
  } });
  const result = eventsFrom(await response.text()).at(-1).data;
  assert.equal(payload.model, 'deepseek-flash'); assert.equal(payload.max_tokens, 4096);
  assert.deepEqual(payload.thinking, { type: 'disabled' });
  assert.equal(payload.messages[0].role, 'system'); assert(payload.messages[0].content.startsWith('你是 DeepSeek'));
  assert.equal(payload.messages.at(-1).content, privateInput);
  assert.equal(result.message.content, privateOutput); assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.outputTokens, 15); assert.equal(result.usage.cacheHitTokens, 20); assert.equal(result.usage.source, 'provider');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  const stored = JSON.stringify(f.app.store.db.prepare('SELECT * FROM chat_requests').all())
    + JSON.stringify(f.app.store.db.prepare('SELECT * FROM usage').all());
  assert(!stored.includes(privateInput)); assert(!stored.includes(privateOutput)); assert(!stored.includes('upstream-private-key'));
});

test('local-first context and payload limits reject rather than silently clipping or accepting privileged roles', async (t) => {
  const f = await fixture(t, { contextCharLimit: 32000 });
  const { cookie } = await f.register();
  const send = (messages, extra = {}) => f.request('/api/chat', { method: 'POST', cookie, data: {
    requestId: 'bounded-request', conversationId: 'local-only', messages, ...extra,
  } });
  assert.equal((await send([{ role: 'system', content: 'do not allow system' }, { role: 'user', content: 'hello' }])).status, 400);
  assert.equal((await send(Array.from({ length: 301 }, () => ({ role: 'user', content: 'x' })))).status, 400);
  assert.equal((await send([{ role: 'user', content: 'x'.repeat(60001) }])).status, 400);
  const context = await send([{ role: 'user', content: 'x'.repeat(16000) }, { role: 'assistant', content: 'y'.repeat(16000) }, { role: 'user', content: '继续' }]);
  assert.equal(context.status, 400); assert.equal((await context.json()).error.code, 'CONTEXT_LIMIT');
  assert.equal((await send([{ role: 'assistant', content: 'not a final user turn' }])).status, 400);
  assert.equal((await send([{ role: 'user', content: '   ' }])).status, 400);
  assert.equal((await send([{ role: 'user', content: '有效正文' }], { requestId: '../unsafe' })).status, 400);
  assert.equal((await send([{ role: 'user', content: '大'.repeat(60000) }, { role: 'user', content: '大'.repeat(60000) }])).status, 413);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM chat_requests').get().n, 0);
});

test('local-first stop waits for metadata settlement; account/global concurrency and request ownership are enforced', async (t) => {
  const f = await fixture(t, { demoDelayMs: 20, maxConcurrentGenerations: 1 });
  const alice = await f.register('alice_local');
  const bob = await f.register('bob_local');
  const requestId = 'stop-local-request';
  const data = { requestId, conversationId: 'alice-local', messages: [{ role: 'user', content: 'stop me' }] };
  const response = await f.request('/api/chat', { method: 'POST', cookie: alice.cookie, data });
  assert.equal((await f.request('/api/chat', { method: 'POST', cookie: alice.cookie, data: { ...data, requestId: 'alice-parallel' } })).status, 409);
  const full = await f.request('/api/chat', { method: 'POST', cookie: bob.cookie, data: { ...data, requestId: 'bob-parallel' } });
  assert.equal(full.status, 429); assert.equal((await full.json()).error.code, 'SERVER_BUSY');
  assert.equal((await f.request(`/api/chat/${requestId}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await f.request(`/api/chat/${requestId}/stop`, { method: 'POST', cookie: bob.cookie })).status, 404);
  const stop = await f.request(`/api/chat/${requestId}/stop`, { method: 'POST', cookie: alice.cookie });
  const stopped = await stop.json();
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.usage.status, 'stopped');
  assert.equal(eventsFrom(await response.text()).at(-1).data.message.status, 'stopped');
  const saved = await f.request(`/api/chat/${requestId}`, { cookie: alice.cookie });
  assert.equal((await saved.json()).status, 'stopped');
  // The same client ID is allowed for another user, but not retried for its owner.
  const other = await f.request('/api/chat', { method: 'POST', cookie: bob.cookie, data });
  assert.equal(other.status, 200); await other.text();
  const duplicate = await f.request('/api/chat', { method: 'POST', cookie: alice.cookie, data });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'REQUEST_ALREADY_USED');
});

test('local-first interrupted replies record estimates and restart recovers metadata without a transcript', async (t) => {
  const f = await fixture(t, { apiKey: 'key', fetchImpl: async () => upstreamResponse([{ choices: [{ delta: { content: 'partial-output-not-stored' } }] }]) });
  const { cookie, user } = await f.register();
  const response = await f.request('/api/chat', { method: 'POST', cookie, data: {
    requestId: 'interrupted-local', conversationId: 'local-only', messages: [{ role: 'user', content: 'private-input-not-stored' }],
  } });
  const events = eventsFrom(await response.text());
  assert.equal(events.find((entry) => entry.event === 'error').data.code, 'UPSTREAM_INTERRUPTED');
  const result = events.at(-1).data;
  assert.equal(result.message.status, 'error'); assert.equal(result.usage.source, 'estimate');
  assert(!JSON.stringify(f.app.store.chatRequest(user.id, 'interrupted-local')).includes('partial-output-not-stored'));
  f.app.store.beginChatRequest(user.id, { requestId: 'restart-local-id', conversationId: 'local-only', messageId: 'message-id', mode: 'live', model: 'deepseek-flash', inputCharacters: 100 });
  await f.app.close();
  const restarted = createApp({ dataDir: f.dataDir, apiKey: 'key' });
  try {
    const recovered = restarted.store.chatRequest(user.id, 'restart-local-id');
    assert.equal(recovered.status, 'stopped'); assert.equal(recovered.usage.source, 'estimate');
    assert.equal(recovered.usage.inputTokens, 50);
    assert.equal(restarted.store.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  } finally { await restarted.close(); }
});

test('production can disable legacy Web history while keeping authenticated stateless chat available', async (t) => {
  const f = await fixture(t, { enableLegacyHistory: false });
  const { cookie } = await f.register();
  for (const path of ['/api/conversations', '/api/import']) {
    const response = await f.request(path, { method: 'POST', cookie, data: {} });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'LEGACY_HISTORY_DISABLED');
  }
  const chat = await f.request('/api/chat', { method: 'POST', cookie, data: {
    requestId: 'disabled-legacy-chat', conversationId: 'local-only', messages: [{ role: 'user', content: '你好' }],
  } });
  assert.equal(chat.status, 200); await chat.text();
  const config = await (await f.request('/api/config')).json();
  assert.equal(config.legacyHistoryEnabled, false); assert.equal(config.nativeLocalOnly, true);
});

test('metadata maintenance prunes old finished requests and expired sessions, retaining recent and running metadata', async (t) => {
  const f = await fixture(t, { metadataRetentionDays: 90 });
  const { user, cookie } = await f.register();
  const oldDate = new Date(Date.now() - 91 * 86400000).toISOString();
  const addRequest = (requestId, finish) => {
    f.app.store.beginChatRequest(user.id, { requestId, conversationId: 'local-only', messageId: `message-${requestId}`,
      mode: 'live', model: 'deepseek-flash', inputCharacters: 40 });
    if (finish) f.app.store.finishChatRequest(user.id, requestId, { conversationId: 'local-only', messageId: `message-${requestId}`,
      mode: 'live', status: 'complete', inputTokens: 20, outputTokens: 10, cacheHitTokens: 0, cacheMissTokens: 20, source: 'provider' });
  };
  addRequest('old-finished-request', true);
  addRequest('recent-finished-request', true);
  addRequest('old-start-new-settlement', true);
  addRequest('old-running-request', false);
  f.app.store.db.prepare("UPDATE chat_requests SET created_at=? WHERE request_id IN ('old-finished-request','old-running-request')").run(oldDate);
  f.app.store.db.prepare("UPDATE usage SET created_at=? WHERE request_id='old-finished-request'").run(oldDate);
  f.app.store.db.prepare("UPDATE chat_requests SET created_at=? WHERE request_id='old-start-new-settlement'").run(oldDate);
  f.app.store.addSession('expired-web-token-hash', user.id, Date.now() - 1000);
  f.app.store.addNativeSession('expired-native-token-hash', user.id, Date.now() - 1000);
  const cleaned = f.app.store.pruneMetadata(90);
  assert.equal(cleaned.usage, 1); assert.equal(cleaned.requests, 1);
  assert.equal(cleaned.webSessions, 1); assert.equal(cleaned.nativeSessions, 1);
  assert.equal(f.app.store.chatRequest(user.id, 'old-finished-request'), null);
  assert.equal(f.app.store.chatRequest(user.id, 'recent-finished-request').status, 'complete');
  assert.equal(f.app.store.chatRequest(user.id, 'old-start-new-settlement').status, 'complete');
  assert.equal(f.app.store.chatRequest(user.id, 'old-running-request').status, 'running');
  const usage = await (await f.request('/api/usage', { cookie })).json();
  assert.equal(usage.retentionDays, 90); assert.equal(usage.totals.requests, 2);
});
