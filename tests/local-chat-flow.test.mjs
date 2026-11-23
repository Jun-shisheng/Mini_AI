import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalChatStore, LOCAL_CHAT_LIMITS } from '../src/local-chat-store.js';
import { createConnectionManager } from '../src/native.js';
import { createApiClient, buildNativeContext, mergeAbortSignals } from '../src/api.js';
import { mockLocalVault } from './helpers/mock-local-vault.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://own-service.example.test';
const TOKEN = 'b'.repeat(64);
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const eventResponse = (source) => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } });
const loginResponse = (id = OWNER) => Response.json({ user: { id, username: 'reader' }, sessionToken: TOKEN, expiresAt: new Date(Date.now() + 3600000).toISOString() });
async function usingFetch(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); } finally { globalThis.fetch = original; }
}
function fixture() {
  const vault = mockLocalVault();
  const store = createLocalChatStore({ vault });
  const connection = createConnectionManager({ isNativePlatform: () => true, apiBaseUrl: BASE });
  const client = createApiClient(connection, { store, checkpointMs: 5 });
  return { vault, store, connection, client };
}

test('native CRUD and imports use only the account vault; changing accounts cannot read another account history', async () => {
  const f = fixture();
  let owner = OWNER;
  const requests = [];
  await usingFetch(async (url) => {
    requests.push(url);
    if (url.endsWith('/native/auth/login')) return loginResponse(owner);
    if (url.endsWith('/native/auth/logout')) return Response.json({ ok: true });
    throw new Error('Unexpected network request: ' + url);
  }, async () => {
    await assert.rejects(() => f.client.api('/conversations'), (error) => error.status === 401);
    assert.equal(f.vault.calls.length, 0);
    await f.client.api('/auth/login', { method: 'POST', body: { username: 'reader', password: 'password123' } });
    const { conversation } = await f.client.api('/conversations', { method: 'POST', body: { title: '留在本机' } });
    await f.client.api('/conversations/' + conversation.id, { method: 'PATCH', body: { title: '只在我的手机' } });
    assert.equal((await f.client.api('/conversations/' + conversation.id)).conversation.title, '只在我的手机');
    const imported = await f.client.api('/import', { method: 'POST', body: { data: { conversations: [{ title: '旧记忆', messages: [{ role: 'user', content: '私密的回忆' }, { role: 'assistant', content: '我记着。' }] }] } } });
    assert.equal(imported.count, 1);
    assert.equal(imported.conversations[0].messages[0].source, 'import');
    assert.equal((await f.client.api('/conversations')).conversations.length, 2);
    await f.client.api('/conversations/' + conversation.id, { method: 'DELETE' });
    assert.equal((await f.client.api('/conversations')).conversations.length, 1);
    await f.client.api('/auth/logout', { method: 'POST' });
    owner = OTHER;
    await f.client.api('/auth/login', { method: 'POST', body: {} });
    assert.equal((await f.client.api('/conversations')).conversations.length, 0);
    await assert.rejects(() => f.client.api('/conversations/' + imported.conversations[0].id), (error) => error.code === 'LOCAL_DATA_MISSING');
    owner = OWNER;
    await f.client.api('/auth/login', { method: 'POST', body: {} });
    assert.equal((await f.client.api('/conversations')).conversations.length, 1);
  });
  assert(requests.every((url) => url.includes('/native/auth/')));
  assert([...f.vault.files.values()].some((data) => data.includes('私密的回忆')), 'the mock stores plaintext intentionally; real encryption is the native plugin responsibility');
});

test('native streaming sends bounded context to the stateless gateway and persists final text without history downlink', async () => {
  const f = fixture();
  const requests = [];
  const events = [];
  await usingFetch(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/native/auth/login')) return loginResponse();
    assert.equal(url, BASE + '/api/chat');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.messages, [{ role: 'user', content: '今天想说一件小事。' }]);
    assert.equal(payload.thinking, true);
    assert.equal(payload.conversationId.length, 36);
    assert.equal(payload.requestId.length, 36);
    return eventResponse(frame('meta', { assistantMessage: { id: 'server-message', role: 'assistant', content: '', status: 'generating' } })
      + frame('reasoning', { text: '认真听。' }) + frame('delta', { text: '慢慢说，' }) + frame('delta', { text: '我在听。' })
      + frame('done', { message: { id: 'server-message', role: 'assistant', content: '慢慢说，我在听。', status: 'complete' }, usage: { inputTokens: 20 } }));
  }, async () => {
    await f.client.api('/auth/login', { method: 'POST', body: {} });
    const { conversation } = await f.client.api('/conversations', { method: 'POST', body: {} });
    await f.client.streamChat(conversation.id, { content: '今天想说一件小事。', thinking: true }, new AbortController().signal, (event, data) => events.push({ event, data }));
    const saved = (await f.client.api('/conversations/' + conversation.id)).conversation;
    assert.equal(saved.messages[0].content, '今天想说一件小事。');
    assert.equal(saved.messages[1].content, '慢慢说，我在听。');
    assert.equal(saved.messages[1].reasoning, '认真听。');
    assert.equal(saved.messages[1].status, 'complete');
    assert.equal(saved.messages[1].id, 'server-message');
    assert.equal(saved.title, '今天想说一件小事。');
  });
  assert.equal(requests.length, 2, 'only login and stateless generation went to the server');
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).data.conversation, undefined);
});

test('failed regeneration retains the previous answer and a local failed-version record', async () => {
  const f = fixture();
  const conversation = await f.store.create(OWNER, {});
  conversation.messages = [{ id: 'u1', role: 'user', content: '原来的问题', status: 'complete' }, { id: 'a1', role: 'assistant', content: '原来的好回答', status: 'complete' }];
  await f.store.save(OWNER, conversation);
  await usingFetch(async (url) => {
    if (url.endsWith('/native/auth/login')) return loginResponse();
    if (url.endsWith('/stop')) return Response.json({ ok: true, status: 'error' });
    return eventResponse(frame('error', { code: 'UPSTREAM_FAILED', message: '本次模型调用失败' }) + frame('done', { message: { role: 'assistant', content: '', status: 'error' }, usage: {} }));
  }, async () => {
    await f.client.api('/auth/login', { method: 'POST', body: {} });
    await assert.rejects(() => f.client.streamChat(conversation.id, { regenerate: true }, new AbortController().signal, () => {}), /本次模型调用失败/u);
    const saved = (await f.client.api('/conversations/' + conversation.id)).conversation;
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].content, '原来的好回答');
    assert.equal(saved.messages[1].status, 'complete');
    assert.equal(saved.messages[1].previousVersions.at(-1).status, 'error');
  });
});

test('pause flushes partial text, stops the server request and leaves a recoverable stopped local reply', async () => {
  const f = fixture();
  let controller;
  let request;
  let stopped = false;
  let deltaReceived;
  const received = new Promise((resolve) => { deltaReceived = resolve; });
  const encode = (value) => new TextEncoder().encode(value);
  await usingFetch(async (url, options) => {
    if (url.endsWith('/native/auth/login')) return loginResponse();
    if (url.endsWith('/stop')) {
      stopped = true;
      const onDisk = [...f.vault.files.values()].some((data) => data.includes('已经到达的部分'));
      assert(onDisk, 'partial data was flushed before requesting background cancellation');
      if (controller) { controller.enqueue(encode(frame('done', { message: { content: '已经到达的部分', role: 'assistant', status: 'stopped' }, usage: {} }))); controller.close(); controller = null; }
      return Response.json({ ok: true, status: 'stopped' });
    }
    request = JSON.parse(options.body);
    return new Response(new ReadableStream({ start(stream) {
      controller = stream;
      stream.enqueue(encode(frame('meta', { assistantMessage: { id: 'partial-id', role: 'assistant', content: '', status: 'generating' } })));
      stream.enqueue(encode(frame('delta', { text: '已经到达的部分' })));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, async () => {
    await f.client.api('/auth/login', { method: 'POST', body: {} });
    const { conversation } = await f.client.api('/conversations', { method: 'POST', body: {} });
    const generating = f.client.streamChat(conversation.id, { content: '继续吧' }, new AbortController().signal, (event) => { if (event === 'delta') deltaReceived(); });
    const settled = generating.catch((error) => { assert.equal(error.name, 'AbortError'); });
    await received;
    await assert.rejects(() => f.client.api('/conversations/' + conversation.id, { method: 'DELETE' }), (error) => error.code === 'GENERATION_ACTIVE');
    await f.client.handleAppPause();
    await settled;
    const saved = (await f.client.api('/conversations/' + conversation.id)).conversation;
    assert.equal(saved.messages.at(-1).status, 'stopped');
    assert.equal(saved.messages.at(-1).content, '已经到达的部分');
  });
  assert(stopped);
  assert(request.requestId);
});

test('a fresh local store recovers interrupted generation and rebuilds only a missing index', async () => {
  const vault = mockLocalVault();
  const first = createLocalChatStore({ vault });
  const conversation = await first.create(OWNER, { title: '暂停的故事' });
  conversation.messages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '已经保存的部分', status: 'generating' }];
  await first.save(OWNER, conversation);
  vault.files.delete(OWNER + '|index');
  const restarted = createLocalChatStore({ vault });
  const list = await restarted.list(OWNER);
  assert.equal(list.conversations.length, 1);
  assert(list.warnings.some((warning) => warning.includes('恢复列表索引')));
  const recovered = await restarted.get(OWNER, conversation.id, { recoverGenerating: true });
  assert.equal(recovered.messages.at(-1).status, 'stopped');
  assert.equal(recovered.messages.at(-1).content, '已经保存的部分');
  assert(vault.files.get(OWNER + '|conversation:' + conversation.id).includes('stopped'));
});

test('corrupt indexes remain untouched and readable chats open read-only; corrupt payloads are never replaced with empty data', async () => {
  const vault = mockLocalVault();
  const store = createLocalChatStore({ vault });
  const conversation = await store.create(OWNER, { title: '保留原文件' });
  vault.files.set(OWNER + '|index', '{broken-index');
  const restarted = createLocalChatStore({ vault });
  const list = await restarted.list(OWNER);
  assert.equal(list.conversations.length, 1);
  assert(list.warnings.some((warning) => warning.includes('只读')));
  assert.equal((await restarted.get(OWNER, conversation.id)).title, '保留原文件');
  await assert.rejects(() => restarted.update(OWNER, conversation.id, { title: '不能覆盖' }), (error) => error.code === 'LOCAL_READ_ONLY');
  assert.equal(vault.files.get(OWNER + '|index'), '{broken-index');
  vault.files.set(OWNER + '|conversation:' + conversation.id, '{broken-chat');
  const corrupt = createLocalChatStore({ vault });
  await assert.rejects(() => corrupt.list(OWNER), (error) => error.code === 'LOCAL_DATA_CORRUPTED');
  assert.equal(vault.files.get(OWNER + '|conversation:' + conversation.id), '{broken-chat');
});

test('Keystore/decryption errors fail closed without writing a new empty vault', async () => {
  const vault = mockLocalVault();
  vault.get = async () => { throw Object.assign(new Error('key invalidated'), { code: 'KEY_INVALIDATED' }); };
  const store = createLocalChatStore({ vault });
  await assert.rejects(() => store.create(OWNER, {}), (error) => error.code === 'KEY_INVALIDATED');
  assert.equal(vault.calls.filter((call) => call.method === 'set').length, 0);
});

test('a failed multi-conversation import rolls back new files while preserving old chats', async () => {
  const vault = mockLocalVault();
  const store = createLocalChatStore({ vault });
  const existing = await store.create(OWNER, { title: '原来的聊天' });
  const before = new Map(vault.files);
  const set = vault.set;
  let newConversations = 0;
  vault.set = async (args) => {
    if (args.key.startsWith('conversation:') && ++newConversations === 2) throw Object.assign(new Error('disk full'), { code: 'WRITE_FAILED' });
    return set(args);
  };
  await assert.rejects(() => store.import(OWNER, { conversations: ['一', '二'].map((title) => ({ title, messages: [{ role: 'user', content: title }] })) }), (error) => error.code === 'WRITE_FAILED');
  assert.deepEqual(vault.files, before);
  assert.equal((await store.get(OWNER, existing.id)).title, '原来的聊天');
});

test('oversized local conversations fail before overwriting their prior committed snapshot', async () => {
  const vault = mockLocalVault();
  const store = createLocalChatStore({ vault });
  const conversation = await store.create(OWNER, {});
  const previous = vault.files.get(OWNER + '|conversation:' + conversation.id);
  conversation.messages = Array.from({ length: 44 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(200000) }));
  await assert.rejects(() => store.save(OWNER, conversation), (error) => error.code === 'LOCAL_STORAGE_LIMIT');
  assert.equal(vault.files.get(OWNER + '|conversation:' + conversation.id), previous);
  assert.equal(LOCAL_CHAT_LIMITS.conversationBytes, 8 * 1024 * 1024);
});

test('context selection preserves whole recent turns, enforces real encoded size and leaves full local history unchanged', () => {
  const messages = [];
  for (let index = 0; index < 5; index += 1) messages.push({ role: 'user', content: '问'.repeat(20000) }, { role: 'assistant', content: '答'.repeat(20000) });
  messages.push({ role: 'user', content: '最新消息' });
  const conversation = { id: '33333333-3333-4333-8333-333333333333', messages };
  const selected = buildNativeContext(conversation, { requestId: '44444444-4444-4444-8444-444444444444' });
  assert(selected.trimmed);
  assert.equal(selected.payload.messages[0].role, 'user');
  assert.equal(selected.payload.messages.at(-1).content, '最新消息');
  assert(new TextEncoder().encode(JSON.stringify(selected.payload)).length <= 240 * 1024);
  assert.equal(conversation.messages.length, 11);
  assert.throws(() => buildNativeContext({ ...conversation, messages: [{ role: 'user', content: '\u0001'.repeat(50000) }] }, { requestId: 'r' }), (error) => error.code === 'CONTEXT_TOO_LARGE');
});

test('AbortSignal.any fallback forwards cancellation and removes its listeners on cleanup', () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  try {
    const one = new AbortController();
    const two = new AbortController();
    let removed = 0;
    const remove = one.signal.removeEventListener.bind(one.signal);
    one.signal.removeEventListener = (...args) => { removed += 1; return remove(...args); };
    const merged = mergeAbortSignals([one.signal, two.signal]);
    assert.equal(merged.signal.aborted, false);
    two.abort(new Error('paused'));
    assert.equal(merged.signal.aborted, true);
    merged.cleanup();
    assert.equal(removed, 1);
    assert.equal(mergeAbortSignals([two.signal]).signal.aborted, true);
  } finally { Object.defineProperty(AbortSignal, 'any', descriptor); }
});

test('local history search matches message content, not only titles', async () => {
  const store = createLocalChatStore({ vault: mockLocalVault() });
  const apple = await store.create(OWNER, { title: '苹果' });
  await store.save(OWNER, { ...apple, messages: [
    { role: 'user', content: '今天天气很好', status: 'complete' },
    { role: 'assistant', content: '我们去公园看樱花', status: 'complete' },
  ] });
  const banana = await store.create(OWNER, { title: '香蕉' });
  await store.save(OWNER, { ...banana, messages: [{ role: 'user', content: '另一个话题', status: 'complete' }] });
  const result = await store.list(OWNER, '樱花');
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].title, '苹果');
  assert.match(result.conversations[0].snippet, /樱花/);
  assert.equal((await store.list(OWNER, '不存在')).conversations.length, 0);
});

test('a per-conversation avatar is stored with the local history and listed in summaries', async () => {
  const store = createLocalChatStore({ vault: mockLocalVault() });
  const conversation = await store.create(OWNER, {});
  const avatar = 'data:image/jpeg;base64,AAAA';
  const saved = await store.update(OWNER, conversation.id, { avatar });
  assert.equal(saved.avatar, avatar);
  const list = await store.list(OWNER);
  assert.equal(list.conversations.find((item) => item.id === conversation.id).avatar, avatar);
  const cleared = await store.update(OWNER, conversation.id, { avatar: 'not-an-image' });
  assert.equal(cleared.avatar, '');
});
