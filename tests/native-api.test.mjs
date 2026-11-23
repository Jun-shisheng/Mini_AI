import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionManager, resolveConnectionInfo } from '../src/native.js';
import { createApiClient } from '../src/api.js';
import { createLocalChatStore } from '../src/local-chat-store.js';
import { saveByok, clearByok } from '../src/byok.js';
import { mockLocalVault } from './helpers/mock-local-vault.mjs';

const TOKEN = 'a'.repeat(64);
const base = 'https://companion.example.test';
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const nativeManager = (extra = {}) => createConnectionManager({ isNativePlatform: () => true, apiBaseUrl: base, ...extra });

async function usingFetch(stub, action) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); }
  finally { globalThis.fetch = previous; }
}

test('Web connections stay same-origin even when a native build address is configured', () => {
  const manager = createConnectionManager({ isNativePlatform: () => false, apiBaseUrl: 'http://unrelated.example.test' });
  assert.equal(manager.getConnectionInfo().configured, true);
  assert.equal(manager.getConnectionInfo().native, false);
  assert.deepEqual(manager.prepareRequest('/auth/login', { 'Content-Type': 'application/json' }), {
    url: '/api/auth/login', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
  });
  manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
  assert.equal(manager.getConnectionInfo().authenticated, false);
  assert.equal(manager.prepareRequest('/auth/me').headers.Authorization, undefined);
});

test('native server URLs normalize an optional api suffix and a trusted reverse-proxy prefix', () => {
  for (const [input, expected] of [
    [base, base + '/api'], [base + '/', base + '/api'],
    [base + '/api/', base + '/api'], [base + '/companion/', base + '/companion/api'],
  ]) {
    const info = resolveConnectionInfo({ native: true, apiBaseUrl: input });
    assert.equal(info.configured, true, input);
    assert.equal(info.baseUrl, expected);
    assert.equal(info.secure, true);
  }
  const missing = nativeManager({ apiBaseUrl: '' });
  assert.equal(missing.getConnectionInfo().configured, false);
  assert.equal(missing.getConnectionInfo().code, 'NATIVE_API_NOT_CONFIGURED');
  assert.throws(() => missing.prepareRequest('/config'), /尚未配置服务地址/u);
});

test('release connections require HTTPS; only an explicit debug flag allows a trusted HTTP address', () => {
  const address = 'http://172.168.6.40:8787';
  const release = resolveConnectionInfo({ native: true, apiBaseUrl: address });
  assert.equal(release.configured, false);
  assert.equal(release.code, 'NATIVE_API_HTTPS_REQUIRED');
  assert.equal(resolveConnectionInfo({ native: true, apiBaseUrl: 'http://localhost:8787' }).configured, false);
  assert.equal(resolveConnectionInfo({ native: true, apiBaseUrl: address, debug: 'true' }).configured, false, 'truthy strings do not enable the pure validator debug mode');
  const debug = resolveConnectionInfo({ native: true, apiBaseUrl: address, debug: true });
  assert.equal(debug.configured, true);
  assert.equal(debug.secure, false);
  assert.equal(debug.baseUrl, address + '/api');
  assert.equal(nativeManager({ apiBaseUrl: address, nativeDebug: true }).prepareRequest('/config').url, address + '/api/config');
});

test('native server configuration rejects credentials, query strings, fragments and dangerous paths', () => {
  for (const address of [
    'https://user:password@companion.example.test', 'https://@companion.example.test',
    base + '?token=secret', base + '#section', base + '?', base + '#',
    base + '/a/../api', base + '/a/%2e%2e/api', base + '/a%5c..%5capi',
    base + '/double//slash', base + '/back\\slash', base + '/broken%escape',
    'file:///private/app', 'javascript:alert(1)', '/api', 'https:companion.example.test', 'https:///companion.example.test',
  ]) {
    const info = resolveConnectionInfo({ native: true, apiBaseUrl: address, debug: true });
    assert.equal(info.configured, false, address);
    assert.equal(info.code, 'NATIVE_API_INVALID_URL', address);
  }
});

test('native login uses its dedicated route, stores only an in-memory app session and authenticates business requests', async () => {
  const manager = nativeManager();
  const client = createApiClient(manager);
  let calls = 0;
  await usingFetch(async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['X-Palm-Client'], 'android');
    if (calls++ === 0) {
      assert.equal(url, base + '/api/native/auth/login');
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { username: 'reader', password: 'example-password' });
      return Response.json({ user: { id: 'user-id', username: 'reader' }, sessionToken: TOKEN, expiresAt: future() });
    }
    assert.equal(url, base + '/api/auth/me');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    return Response.json({ user: { id: 'user-id' } });
  }, async () => {
    const login = await client.api('/auth/login', { method: 'POST', body: { username: 'reader', password: 'example-password' } });
    assert.equal(login.user.username, 'reader');
    assert.equal(login.sessionToken, undefined, 'the private session value is not returned to UI components');
    assert.equal(manager.getConnectionInfo().authenticated, true);
    assert.equal((await client.api('/auth/me')).user.id, 'user-id');
  });
  assert.equal(calls, 2);
  assert.equal(nativeManager().getConnectionInfo().authenticated, false, 'a new process/manager does not restore persistent credentials');
});

test('native registration also maps to the dedicated endpoint and ignores caller-supplied bearer overrides', async () => {
  const manager = nativeManager();
  const client = createApiClient(manager);
  await usingFetch(async (url, options) => {
    assert.equal(url, base + '/api/native/auth/register');
    assert.equal(options.headers['X-Palm-Client'], 'android');
    assert.equal(Object.keys(options.headers).some((key) => key.toLowerCase() === 'authorization'), false);
    return Response.json({ user: { id: 'new-user' }, sessionToken: TOKEN, expiresAt: future() }, { status: 201 });
  }, async () => {
    const result = await client.api('/auth/register', { method: 'POST', body: { username: 'reader', password: 'example-password' }, headers: { authorization: 'Bearer caller-value', 'x-palm-client': 'web' } });
    assert.equal(result.user.id, 'new-user');
  });
  assert.equal(manager.getConnectionInfo().authenticated, true);
});

test('native SSE uses the configured backend, bearer session, cookie omission and original event interface', async () => {
  const manager = nativeManager();
  manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
  const client = createApiClient(manager, { store: createLocalChatStore({ vault: mockLocalVault() }) });
  const events = [];
  const controller = new AbortController();
  await usingFetch(async (url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.headers['X-Palm-Client'], 'android');
    if (url === base + '/api/auth/me') return Response.json({ user: { id: 'test-user' } });
    assert.equal(url, base + '/api/chat');
    assert.deepEqual(JSON.parse(options.body).messages, [{ role: 'user', content: '你好' }]);
    assert.equal(options.signal.aborted, false);
    return new Response('event: delta\ndata: {"text":"你好"}\n\nevent: done\ndata: {"message":{"status":"complete"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }, async () => {
    await client.api('/auth/me');
    const { conversation } = await client.api('/conversations', { method: 'POST', body: {} });
    await client.streamChat(conversation.id, { content: '你好' }, controller.signal, (event, data) => events.push({ event, data }));
  });
  assert.deepEqual(events.map((event) => event.event), ['meta', 'delta', 'done']);
  assert.equal(events[1].data.text, '你好');
});

test('401 responses clear the native session for both JSON and streaming requests', async () => {
  const manager = nativeManager();
  const client = createApiClient(manager, { store: createLocalChatStore({ vault: mockLocalVault() }) });
  const rejected = async (url) => url === base + '/api/auth/me'
    ? Response.json({ user: { id: 'test-user' } })
    : Response.json({ error: { message: '登录已失效，请重新登录。', code: 'UNAUTHORIZED' } }, { status: 401 });
  manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
  await usingFetch(rejected, async () => {
    await assert.rejects(() => client.api('/usage'), (error) => error.status === 401 && error.code === 'UNAUTHORIZED');
    assert.equal(manager.getConnectionInfo().authenticated, false);
    manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
    await client.api('/auth/me');
    const { conversation } = await client.api('/conversations', { method: 'POST', body: {} });
    await assert.rejects(() => client.streamChat(conversation.id, { content: '你好' }, new AbortController().signal, () => {}), (error) => error.status === 401);
    assert.equal(manager.getConnectionInfo().authenticated, false);
  });
  assert.equal(manager.prepareRequest('/auth/me').headers.Authorization, undefined);
});

test('native logout clears memory even if the server is unavailable', async () => {
  const manager = nativeManager();
  manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
  const client = createApiClient(manager);
  await usingFetch(async (url, options) => {
    assert.equal(url, base + '/api/native/auth/logout');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    throw new TypeError('network unavailable');
  }, async () => {
    await assert.rejects(() => client.api('/auth/logout', { method: 'POST' }), /network unavailable/u);
  });
  assert.equal(manager.getConnectionInfo().authenticated, false);
});

test('native token expiry and malformed login responses cannot leave an authenticated session', async () => {
  let now = Date.now();
  const manager = nativeManager({ now: () => now });
  manager.acceptSession({ sessionToken: TOKEN, expiresAt: new Date(now + 1000).toISOString() });
  assert.equal(manager.getConnectionInfo().authenticated, true);
  now += 1001;
  assert.equal(manager.prepareRequest('/usage').headers.Authorization, undefined);
  assert.equal(manager.getConnectionInfo().authenticated, false);
  for (const session of [
    { token: TOKEN, expiresAt: future() },
    { sessionToken: 'short', expiresAt: future() },
    { sessionToken: TOKEN + '\r\nInjected: header', expiresAt: future() },
    { sessionToken: TOKEN, expiresAt: 'not-a-date' },
    { sessionToken: TOKEN, expiresAt: new Date(0).toISOString() },
  ]) {
    assert.throws(() => manager.acceptSession(session), /登录会话无效/u);
    assert.equal(manager.getConnectionInfo().authenticated, false);
  }
});

test('native sessions never consult or write browser local/session storage', async () => {
  const descriptors = new Map(['localStorage', 'sessionStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of descriptors.keys()) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('persistent storage must not be accessed'); } });
  try {
    const manager = nativeManager();
    manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
    assert.equal(manager.prepareRequest('/usage').headers.Authorization, 'Bearer ' + TOKEN);
    manager.clearSession();
    assert.equal(manager.getConnectionInfo().authenticated, false);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('an unconfigured native build fails before sending credentials to a WebView-relative endpoint', async () => {
  const client = createApiClient(nativeManager({ apiBaseUrl: '' }));
  let fetched = false;
  await usingFetch(async () => { fetched = true; throw new Error('should not fetch'); }, async () => {
    await assert.rejects(() => client.api('/auth/login', { method: 'POST', body: { username: 'reader', password: 'example-password' } }), (error) => error.code === 'NATIVE_API_NOT_CONFIGURED');
    await assert.rejects(() => client.streamChat('id', { content: '你好' }, new AbortController().signal, () => {}), (error) => error.code === 'NATIVE_API_NOT_CONFIGURED');
  });
  assert.equal(fetched, false);
});

test('streaming chat attaches the BYOK key headers only when a key is configured', async () => {
  const memory = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  } });
  try {
    await clearByok();
    await saveByok({ provider: 'openrouter', key: 'sk-or-test-key', model: 'openrouter/free' });
    const manager = nativeManager();
    manager.acceptSession({ sessionToken: TOKEN, expiresAt: future() });
    const client = createApiClient(manager, { store: createLocalChatStore({ vault: mockLocalVault() }) });
    await usingFetch(async (url, options) => {
      if (url === base + '/api/auth/me') return Response.json({ user: { id: 'test-user' } });
      assert.equal(url, base + '/api/chat');
      assert.equal(options.headers['X-Palm-Provider'], 'openrouter');
      assert.equal(options.headers['X-Palm-Key'], 'sk-or-test-key');
      assert.equal(options.headers['X-Palm-Model'], 'openrouter/free');
      assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
      return new Response('event: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {"message":{"status":"complete"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }, async () => {
      await client.api('/auth/me');
      const { conversation } = await client.api('/conversations', { method: 'POST', body: {} });
      await client.streamChat(conversation.id, { content: '你好' }, new AbortController().signal, () => {});
    });
  } finally {
    await clearByok();
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
});
