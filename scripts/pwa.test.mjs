import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { finalizePwa } from './finalize-pwa.mjs';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://palm.example';
const htmlFor = (version) => `<html><script src="/assets/index-${version}.js"></script><link rel="stylesheet" href="/assets/index-${version}.css"><a href="/api/auth/me">API</a></html>`;

function createWorker(options = {}) {
  const handlers = new Map();
  const stores = options.stores || new Map();
  const fetched = [];
  const version = options.version || 'source-v2';
  let onlineVersion = options.onlineVersion || 'V1';
  let missingAsset = '';
  let offline = false;
  const keyOf = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(request, response) { store.set(keyOf(request), response.clone()); },
        async match(request) { return store.get(keyOf(request))?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    location: { origin },
    clients: { async claim() {} },
    addEventListener(type, callback) { handlers.set(type, callback); },
  };
  const files = options.files || [];
  const workerSource = source.replace(/\/\* PALM_BUILD_START \*\/[\s\S]*?\/\* PALM_BUILD_END \*\//,
    `/* PALM_BUILD_START */ ${JSON.stringify({ version, files })} /* PALM_BUILD_END */`);
  vm.runInNewContext(workerSource, {
    self, caches, URL, Set, Request, Response,
    fetch: async (request) => {
      if (offline) throw new TypeError('offline');
      fetched.push(request);
      const url = new URL(request.url || request, origin);
      if (url.pathname === missingAsset) return new Response('missing', { status: 404 });
      if (url.pathname === '/index.html' || url.pathname === '/') return new Response(
        htmlFor(onlineVersion), { headers: { 'Content-Type': 'text/html' } },
      );
      return new Response(`static ${url.pathname}`, { headers: { 'Content-Type': 'application/javascript' } });
    },
  });
  async function dispatch(type, event = {}) {
    let pending;
    handlers.get(type)({ ...event, waitUntil(value) { pending = value; } });
    await pending;
  }
  function request(path, options = {}) {
    let response;
    handlers.get('fetch')({
      request: { url: new URL(path, origin).href, method: 'GET', mode: 'cors', ...options },
      respondWith(value) { response = value; },
    });
    return response;
  }
  return { dispatch, request, fetched, stores,
    offline() { offline = true; },
    release(value) { onlineVersion = value; },
    missing(path) { missingAsset = path; },
  };
}

test('service worker never intercepts API, auth, cross-origin or non-static requests', () => {
  const worker = createWorker();
  for (const path of ['/api', '/api/config', '/api/auth/me', '/api/conversations/1/chat', '/assets/private.json', '/account', 'https://other.example/assets/app.js', '/icons/pet.png?private=1']) {
    assert.equal(worker.request(path), undefined, path);
  }
  assert.equal(worker.request('/assets/index-V1.js', { method: 'POST' }), undefined);
});

test('offline install only pre-caches the app shell and static references without credentials', async () => {
  const worker = createWorker();
  await worker.dispatch('install');
  const cache = worker.stores.get('palm-shell-source-v2');
  assert(cache.has(`${origin}/index.html`));
  assert(cache.has(`${origin}/assets/index-V1.js`));
  assert(cache.has(`${origin}/assets/index-V1.css`));
  assert(![...cache.keys()].some((url) => new URL(url).pathname.startsWith('/api')));
  assert(worker.fetched.every((request) => request.credentials === 'omit'));
});

test('offline navigation returns the shell while API requests still go directly to the network', async () => {
  const worker = createWorker();
  await worker.dispatch('install');
  worker.offline();
  const response = await worker.request('/', { mode: 'navigate' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /index-V1\.js/);
  assert.equal(worker.request('/api/conversations'), undefined);
  const staticAsset = await worker.request('/assets/index-V1.js');
  assert.equal(await staticAsset.text(), 'static /assets/index-V1.js');
});

test('a deployed update cannot mix a newer index into the active offline shell', async () => {
  const worker = createWorker({ version: 'build-v1' });
  await worker.dispatch('install');
  worker.release('V2');
  const onlineReload = await worker.request('/', { mode: 'navigate' });
  assert.match(await onlineReload.text(), /index-V1\.js/);
  worker.offline();
  const offlineReload = await worker.request('/', { mode: 'navigate' });
  assert.match(await offlineReload.text(), /index-V1\.js/);
  assert.equal((await worker.request('/assets/index-V1.js')).status, 200);
  assert.equal(worker.fetched.filter((r) => new URL(r.url).pathname === '/index.html').length, 1);
});

test('an incomplete new version rolls back without damaging the active version', async () => {
  const oldWorker = createWorker({ version: 'build-v1' });
  await oldWorker.dispatch('install');
  const newWorker = createWorker({ version: 'build-v2', onlineVersion: 'V2', stores: oldWorker.stores });
  newWorker.missing('/assets/index-V2.js');
  await assert.rejects(newWorker.dispatch('install'), /Missing app asset/);
  assert(!oldWorker.stores.has('palm-shell-build-v2'));
  assert(oldWorker.stores.has('palm-shell-build-v1'));
  oldWorker.offline();
  assert.match(await (await oldWorker.request('/', { mode: 'navigate' })).text(), /index-V1\.js/);
});

test('a complete new version includes lazy chunks, then activates without clearing another app cache', async () => {
  const oldWorker = createWorker({ version: 'build-v1' });
  await oldWorker.dispatch('install');
  const files = ['/index.html', '/assets/index-V2.js', '/assets/index-V2.css', '/assets/lazy-IMPORT.js']
    .map((path) => ({ path, integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }));
  const newWorker = createWorker({ version: 'build-v2', onlineVersion: 'V2', stores: oldWorker.stores, files });
  newWorker.stores.set('another-app-cache', new Map());
  await newWorker.dispatch('install');
  assert(newWorker.stores.get('palm-shell-build-v2').has(`${origin}/assets/lazy-IMPORT.js`));
  assert(newWorker.fetched.find((r) => new URL(r.url).pathname === '/assets/lazy-IMPORT.js').integrity);
  assert(newWorker.stores.has('palm-shell-build-v1'));
  await newWorker.dispatch('activate');
  assert(!newWorker.stores.has('palm-shell-build-v1'));
  assert(newWorker.stores.has('another-app-cache'));
  newWorker.offline();
  assert.match(await (await newWorker.request('/', { mode: 'navigate' })).text(), /index-V2\.js/);
  assert.equal((await newWorker.request('/assets/lazy-IMPORT.js')).status, 200);
});

test('build finalization changes worker version for changed assets and includes lazy chunks with integrity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'palm-pwa-'));
  try {
    await mkdir(join(temporary, 'icons'));
    await mkdir(join(temporary, 'assets'));
    for (const file of ['manifest.webmanifest', 'icons/pet.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']) {
      await writeFile(join(temporary, file), 'static');
    }
    await writeFile(join(temporary, 'index.html'), htmlFor('V1'));
    await writeFile(join(temporary, 'assets/index-V1.js'), 'main v1');
    await writeFile(join(temporary, 'assets/index-V1.css'), 'style');
    await writeFile(join(temporary, 'assets/lazy-IMPORT.js'), 'lazy');
    const first = await finalizePwa(temporary);
    const second = await finalizePwa(temporary);
    assert.equal(first.version, second.version);
    const output = await readFile(join(temporary, 'sw.js'), 'utf8');
    assert.match(output, /lazy-IMPORT\.js/);
    assert.match(output, /sha256-/);
    await writeFile(join(temporary, 'assets/lazy-IMPORT.js'), 'lazy v2');
    const third = await finalizePwa(temporary);
    assert.notEqual(first.version, third.version);
  } finally {
    const target = resolve(temporary);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert(basename(target).startsWith('palm-pwa-'));
    await rm(target, { recursive: true, force: true });
  }
});
