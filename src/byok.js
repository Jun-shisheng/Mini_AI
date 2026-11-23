import { Capacitor, registerPlugin } from '@capacitor/core';

const secretStore = registerPlugin('SecretStore');
const STORAGE_KEY = 'palm-byok-v1';
const PROVIDERS = new Set(['deepseek', 'openrouter']);
const KEY_PATTERN = /^[^\s\u0000-\u001f\u007f]{8,512}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9._:/@-]{0,120}$/u;

let cached = null;

function normalize(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = typeof value.provider === 'string' ? value.provider.trim().toLowerCase() : 'deepseek';
  const key = typeof value.key === 'string' ? value.key.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!PROVIDERS.has(provider) || !KEY_PATTERN.test(key) || !MODEL_PATTERN.test(model)) return null;
  return { provider, key, model };
}

/** Load the user's own provider key. Android stores it with Keystore AES-GCM. */
export async function loadByok() {
  if (cached) return cached;
  try {
    const saved = Capacitor.isNativePlatform()
      ? (await secretStore.load()).value
      : (typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY));
    const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
    cached = normalize(parsed);
  } catch { cached = null; }
  return cached;
}

export async function saveByok(value) {
  const normalized = normalize(value);
  if (!normalized) throw new Error('请选择服务商，并填写 8–512 位、不含空白的 API Key。');
  const serialized = JSON.stringify(normalized);
  if (Capacitor.isNativePlatform()) await secretStore.save({ value: serialized });
  else localStorage.setItem(STORAGE_KEY, serialized);
  cached = normalized;
  return normalized;
}

export async function clearByok() {
  if (Capacitor.isNativePlatform()) await secretStore.clear();
  else localStorage.removeItem(STORAGE_KEY);
  cached = null;
}

export function currentByok() { return cached; }

export function byokConfigured() { return Boolean(cached?.key); }

/** Headers for the self-hosted relay. Over HTTPS only; never added to other hosts. */
export function byokHeaders() {
  if (!cached?.key) return {};
  return {
    'X-Palm-Provider': cached.provider,
    'X-Palm-Key': cached.key,
    ...(cached.model ? { 'X-Palm-Model': cached.model } : {}),
  };
}
