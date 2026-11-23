import test from 'node:test';
import assert from 'node:assert/strict';
import { saveByok, loadByok, clearByok, currentByok, byokHeaders } from '../src/byok.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};

test('BYOK keys persist locally, produce relay headers, and can be cleared', async () => {
  await clearByok();
  await assert.rejects(() => saveByok({ provider: 'deepseek', key: '', model: '' }), /API Key/u);
  await assert.rejects(() => saveByok({ provider: 'openai', key: 'sk-12345678', model: '' }), /API Key/u);
  await assert.rejects(() => saveByok({ provider: 'deepseek', key: 'sk-has space', model: '' }), /API Key/u);
  const saved = await saveByok({ provider: 'openrouter', key: 'sk-or-user-key', model: 'openrouter/free' });
  assert.deepEqual(saved, { provider: 'openrouter', key: 'sk-or-user-key', model: 'openrouter/free' });
  assert.deepEqual(currentByok(), saved);
  assert.deepEqual(byokHeaders(), { 'X-Palm-Provider': 'openrouter', 'X-Palm-Key': 'sk-or-user-key', 'X-Palm-Model': 'openrouter/free' });
  assert.deepEqual(await loadByok(), saved);
  await clearByok();
  assert.equal(currentByok(), null);
  assert.deepEqual(byokHeaders(), {});
});
