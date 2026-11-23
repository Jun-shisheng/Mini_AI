import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server/index.mjs';

const ORIGIN = 'https://localhost';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ds-native-auth-test-'));
  const app = createApp({ dataDir, staticDir: join(dataDir, 'dist'), apiKey: '', demoDelayMs: 0, ...options });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert(resolve(dataDir).split(/[\\/]/).at(-1).startsWith('ds-native-auth-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (path, { method = 'GET', data, token, native = true, cookie, headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { ...(native ? { Origin: ORIGIN, 'X-Palm-Client': 'android' } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  async function register(username = 'android_user') {
    const response = await request('/api/native/auth/register', { method: 'POST', data: { username, password: 'password123' } });
    assert.equal(response.status, 201);
    return { ...(await response.json()), response };
  }
  return { app, base, dataDir, request, register };
}

function streamEvents(source) {
  return source.split('\n\n').filter((block) => block.startsWith('event: ')).map((block) => ({
    event: block.split('\n')[0].slice(7), data: JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6)),
  }));
}

test('native preflight allows only an exact origin, declared Android header and known methods/headers', async (t) => {
  const f = await fixture(t);
  const preflight = (headers = {}) => f.request('/api/native/auth/login', { method: 'OPTIONS', native: false,
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-palm-client,authorization', ...headers } });
  const accepted = await preflight();
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(accepted.headers.get('access-control-allow-credentials'), null);
  assert(accepted.headers.get('access-control-allow-headers').includes('Authorization'));
  assert.equal(accepted.headers.get('vary'), 'Origin');
  for (const origin of ['https://localhost.evil.example', 'https://localhost:444', 'http://localhost', 'null']) {
    const denied = await preflight({ Origin: origin });
    assert.equal(denied.status, 403, origin);
    assert.equal(denied.headers.get('access-control-allow-origin'), null, origin);
  }
  assert.equal((await preflight({ 'Access-Control-Request-Headers': 'content-type' })).status, 403);
  assert.equal((await preflight({ 'Access-Control-Request-Headers': 'x-palm-client,x-arbitrary' })).status, 403);
  const byok = await preflight({ 'Access-Control-Request-Headers': 'content-type,x-palm-client,x-palm-provider,x-palm-key,x-palm-model' });
  assert.equal(byok.status, 204);
  assert(byok.headers.get('access-control-allow-headers').includes('X-Palm-Key'));
  assert.equal((await preflight({ 'Access-Control-Request-Method': 'TRACE' })).status, 403);
});

test('native login issues a hashed, short-lived, revocable Bearer session without a cookie', async (t) => {
  const f = await fixture(t);
  const account = await f.register();
  assert.match(account.sessionToken, /^n1_[A-Za-z0-9_-]{43}$/u);
  assert.equal(account.response.headers.get('set-cookie'), null);
  assert.equal(account.response.headers.get('access-control-allow-origin'), ORIGIN);
  const remaining = Date.parse(account.expiresAt) - Date.now();
  assert(remaining > 86300 * 1000 && remaining <= 86400 * 1000);
  const stored = f.app.store.db.prepare('SELECT * FROM native_sessions').get();
  assert.notEqual(stored.token_hash, account.sessionToken);
  assert(!JSON.stringify(stored).includes(account.sessionToken));
  const me = await f.request('/api/auth/me', { token: account.sessionToken });
  assert.equal(me.status, 200); assert.equal((await me.json()).user.id, account.user.id);
  const logout = await f.request('/api/native/auth/logout', { method: 'POST', token: account.sessionToken });
  assert.equal(logout.status, 200);
  const revoked = await f.request('/api/auth/me', { token: account.sessionToken });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers.get('access-control-allow-origin'), ORIGIN);
});

test('native tokens are never returned to an untrusted origin or the Web auth route', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: 'https://attacker.example', 'X-Palm-Client': 'android' },
    { Origin: ORIGIN, 'X-Palm-Client': 'native' },
    { 'X-Palm-Client': 'android' },
    { Origin: ORIGIN },
  ]) {
    const response = await f.request('/api/native/auth/register', { method: 'POST', native: false, headers,
      data: { username: 'must_not_register', password: 'password123' } });
    assert.equal(response.status, 403);
    assert(!JSON.stringify(await response.json()).includes('sessionToken'));
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const wrongRoute = await f.request('/api/auth/register', { method: 'POST', data: { username: 'must_not_register', password: 'password123' } });
  assert.equal(wrongRoute.status, 403);
  assert.equal(f.app.store.findUser('must_not_register'), undefined);
});

test('native Bearer and Web cookie credentials cannot be substituted for each other', async (t) => {
  const f = await fixture(t);
  const web = await f.request('/api/auth/register', { method: 'POST', native: false,
    data: { username: 'shared_account', password: 'password123' } });
  assert.equal(web.status, 201);
  const cookie = web.headers.get('set-cookie').split(';')[0];
  const webToken = cookie.slice(cookie.indexOf('=') + 1);
  const login = await f.request('/api/native/auth/login', { method: 'POST', data: { username: 'shared_account', password: 'password123' } });
  assert.equal(login.status, 200);
  const native = await login.json();
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 401, 'native must not fall back to a valid Web cookie');
  assert.equal((await f.request('/api/auth/me', { token: webToken })).status, 401, 'Web session cannot authenticate a native request');
  assert.equal((await f.request('/api/auth/me', { native: false, token: native.sessionToken, cookie })).status, 401, 'Web cannot fall back to cookie when Bearer is supplied');
  assert.equal((await f.request('/api/auth/me', { native: false, cookie: `companion_session=${native.sessionToken}` })).status, 401);
  const foreignOrigin = await f.request('/api/auth/me', { token: native.sessionToken, headers: { Origin: 'https://attacker.example' } });
  assert.equal(foreignOrigin.status, 403); assert.equal(foreignOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal((await f.request('/api/conversations', { method: 'POST', cookie, data: { title: 'must not create' } })).status, 401);
  await f.request('/api/native/auth/logout', { method: 'POST', token: native.sessionToken });
  assert.equal((await f.request('/api/auth/me', { native: false, cookie })).status, 200, 'native logout does not revoke the Web session');
  const csrf = await f.request('/api/conversations', { method: 'POST', native: false, cookie,
    headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, data: { title: 'must not create' } });
  assert.equal(csrf.status, 403);
});

test('expired native sessions fail, and revoking one login leaves another login valid', async (t) => {
  const f = await fixture(t, { nativeSessionTtlSeconds: 600 });
  const first = await f.register();
  assert(Date.parse(first.expiresAt) - Date.now() <= 600000);
  const secondResponse = await f.request('/api/native/auth/login', { method: 'POST', data: { username: 'android_user', password: 'password123' } });
  const second = await secondResponse.json();
  await f.request('/api/native/auth/logout', { method: 'POST', token: first.sessionToken });
  assert.equal((await f.request('/api/auth/me', { token: second.sessionToken })).status, 200);
  f.app.store.db.prepare('UPDATE native_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal((await f.request('/api/auth/me', { token: second.sessionToken })).status, 401);
});

test('native local-first chat retains CORS, enforces ownership and cannot write legacy server history', async (t) => {
  const f = await fixture(t);
  const alice = await f.register('native_alice');
  const bob = await f.register('native_bob');
  const legacy = await f.request('/api/conversations', { method: 'POST', token: alice.sessionToken, data: { title: '禁止上传历史' } });
  assert.equal(legacy.status, 403); assert.equal((await legacy.json()).error.code, 'NATIVE_LOCAL_HISTORY');
  assert.equal((await f.request('/api/import', { method: 'POST', token: alice.sessionToken, data: { data: [] } })).status, 403);
  assert.equal((await f.request('/api/conversations', { token: alice.sessionToken })).status, 403);
  const requestId = 'native-local-request';
  const chat = await f.request('/api/chat', { method: 'POST', token: alice.sessionToken, data: {
    requestId, conversationId: 'native-local-only', messages: [{ role: 'user', content: '你好' }],
  } });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(chat.headers.get('access-control-allow-credentials'), null);
  assert.equal(chat.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const done = streamEvents(await chat.text()).at(-1).data;
  assert.equal(done.message.status, 'complete'); assert.equal(done.message.mode, 'demo');
  assert(!Object.hasOwn(done, 'conversation'));
  assert.equal((await f.request(`/api/chat/${requestId}`, { token: bob.sessionToken })).status, 404);
  assert.equal((await f.request(`/api/chat/${requestId}`, { token: alice.sessionToken })).status, 200);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
});

test('ordinary Flash conversations do not inject roleplay, including legacy empty persona defaults', async (t) => {
  const prompts = [];
  const f = await fixture(t, { apiKey: 'test-key', fetchImpl: async (url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, 'deepseek-flash');
    prompts.push(payload.messages[0].content);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，我可以帮你什么？' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } });
  const { sessionToken } = await f.register();
  const nativeResponse = await f.request('/api/chat', { method: 'POST', token: sessionToken, data: {
    requestId: 'ordinary-native-request', conversationId: 'local-id', messages: [{ role: 'user', content: '你好' }],
  } });
  assert.equal(streamEvents(await nativeResponse.text()).at(-1).data.message.status, 'complete');
  const webLogin = await f.request('/api/auth/login', { method: 'POST', native: false, data: { username: 'android_user', password: 'password123' } });
  const cookie = webLogin.headers.get('set-cookie').split(';')[0];
  for (const persona of [{ name: '新朋友' }, { name: '阿栖', systemPrompt: '请扮演书店店主。' }]) {
    const created = await f.request('/api/conversations', { method: 'POST', native: false, cookie, data: { persona } });
    const c = (await created.json()).conversation;
    const response = await f.request(`/api/conversations/${c.id}/chat`, { method: 'POST', native: false, cookie, data: { content: '你好' } });
    assert.equal(streamEvents(await response.text()).at(-1).data.message.status, 'complete');
  }
  assert(prompts[0].startsWith('你是 DeepSeek'));
  assert(!prompts[0].includes('角色')); assert(!prompts[0].includes('新朋友')); assert(!prompts[0].includes('虚构'));
  assert(!prompts[1].includes('角色')); assert(!prompts[1].includes('新朋友'));
  assert(prompts[2].includes('阿栖')); assert(prompts[2].includes('请扮演书店店主。'));
});

test('native origin configuration replaces defaults and accepts no wildcards or URL paths', async (t) => {
  const f = await fixture(t, { nativeAllowedOrigins: 'https://app.example,*,https://invalid.example/path' });
  assert.equal((await f.request('/api/config')).status, 403);
  const accepted = await f.request('/api/config', { headers: { Origin: 'https://app.example' } });
  assert.equal(accepted.status, 200); assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://app.example');
  const denied = await f.request('/api/config', { headers: { Origin: 'https://invalid.example' } });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('a per-request BYOK key overrides the server key without being stored', async (t) => {
  const seen = [];
  const f = await fixture(t, { apiKey: '', fetchImpl: async (url, init) => {
    seen.push({ url, authorization: init.headers.Authorization, payload: JSON.parse(init.body) });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '来自自备密钥' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } });
  const { sessionToken } = await f.register();
  const response = await f.request('/api/chat', { method: 'POST', token: sessionToken, headers: {
    'X-Palm-Provider': 'deepseek', 'X-Palm-Key': 'sk-user-own-key', 'X-Palm-Model': 'deepseek-reasoner',
  }, data: { requestId: 'byok-native-request', conversationId: 'local-id', messages: [{ role: 'user', content: '你好' }] } });
  assert.equal(response.status, 200);
  const events = streamEvents(await response.text());
  assert.equal(events[0].event, 'meta');
  assert.equal(events[0].data.mode, 'live');
  assert.equal(events[0].data.model, 'deepseek-reasoner');
  assert.equal(events.at(-1).data.message.content, '来自自备密钥');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen[0].authorization, 'Bearer sk-user-own-key');
  assert.equal(seen[0].payload.model, 'deepseek-reasoner');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM chat_requests').get().n, 1);
});
