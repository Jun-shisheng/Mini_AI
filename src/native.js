import { Capacitor } from '@capacitor/core';
import { clearPersistedSession, loadPersistedSession, persistSession } from './session-store.js';

// VITE_* values are public build configuration. Never put an upstream API key here.
const buildEnvironment = import.meta.env ?? {};
const encodedApiBase = buildEnvironment.VITE_API_BASE64 || '';
const buildApiBaseUrl = encodedApiBase
  ? (() => { try { return atob(encodedApiBase); } catch { return ''; } })()
  : (buildEnvironment.VITE_API_BASE_URL || '');
const buildNativeDebug = buildEnvironment.VITE_NATIVE_DEBUG === 'true';

export class ConnectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

/** Validate a trusted build-time server address without consulting browser storage. */
export function resolveConnectionInfo({ native = false, apiBaseUrl = '', debug = false } = {}) {
  if (!native) return { native: false, configured: true, baseUrl: '', secure: globalThis.location?.protocol === 'https:', debug: false, error: null, code: null };
  const failure = (error, code) => ({ native: true, configured: false, baseUrl: '', secure: false, debug: debug === true, error, code });
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl.trim()) {
    return failure('此安装包尚未配置服务地址，请检查服务地址或重新构建安装包。', 'NATIVE_API_NOT_CONFIGURED');
  }
  const address = apiBaseUrl.trim();
  let parsed;
  try { parsed = new URL(address); }
  catch { return failure('安装包中的服务地址无效，请检查服务地址或重新构建安装包。', 'NATIVE_API_INVALID_URL'); }
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/]+)/iu.exec(address)?.[1] || '';
  const rawPath = address.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/iu, '');
  let decodedPath;
  try { decodedPath = decodeURIComponent(rawPath); }
  catch { return failure('安装包中的服务地址无效，请检查服务地址或重新构建安装包。', 'NATIVE_API_INVALID_URL'); }
  if (!/^https?:\/\//iu.test(address) || !authority || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || authority.includes('@')
    || /[?#\s\u0000-\u001f\u007f\\]/u.test(address) || /[\\\u0000-\u001f\u007f]/u.test(decodedPath)
    || decodedPath.split('/').some((part) => part === '.' || part === '..') || /\/{2,}/u.test(rawPath)) {
    return failure('服务地址只能包含可信服务器域名和普通路径，请检查服务地址或重新构建安装包。', 'NATIVE_API_INVALID_URL');
  }
  if (parsed.protocol !== 'https:' && debug !== true) {
    return failure('正式安装包需要安全的 HTTPS 服务地址，请检查服务地址或重新构建安装包。', 'NATIVE_API_HTTPS_REQUIRED');
  }
  const prefix = parsed.pathname.replace(/\/+$/u, '');
  const baseUrl = parsed.origin + (prefix.endsWith('/api') ? prefix : prefix + '/api');
  return { native: true, configured: true, baseUrl, secure: parsed.protocol === 'https:', debug: debug === true, error: null, code: null };
}

function copyHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

/**
 * The native session can be restored from the Android Keystore-backed store.
 * Browser localStorage/sessionStorage never hold native credentials.
 */
export function createConnectionManager({
  isNativePlatform = () => Capacitor.isNativePlatform(),
  apiBaseUrl = buildApiBaseUrl,
  nativeDebug = buildNativeDebug,
  now = () => Date.now(),
} = {}) {
  let sessionToken = '';
  let sessionExpiresAt = 0;
  const resetMemory = () => { sessionToken = ''; sessionExpiresAt = 0; };
  const clearSession = () => { resetMemory(); clearPersistedSession(); };
  const info = () => resolveConnectionInfo({ native: Boolean(isNativePlatform()), apiBaseUrl, debug: nativeDebug === true });
  function activeToken() {
    if (sessionToken && sessionExpiresAt <= now()) clearSession();
    return sessionToken;
  }
  return {
    getConnectionInfo() {
      const connection = info();
      const token = connection.native ? activeToken() : '';
      return { ...connection, authenticated: Boolean(token),
        expiresAt: token ? new Date(sessionExpiresAt).toISOString() : null };
    },
    clearSession,
    acceptSession(data) {
      if (!info().native) return;
      resetMemory();
      const token = data?.sessionToken;
      const expiry = typeof data?.expiresAt === 'number' ? data.expiresAt : Date.parse(data?.expiresAt);
      if (typeof token !== 'string' || token.length < 24 || token.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(token)
        || !Number.isFinite(expiry) || !Number.isFinite(new Date(expiry).getTime()) || expiry <= now()) {
        throw new ConnectionError('登录会话无效，请重新登录。', 'NATIVE_SESSION_INVALID');
      }
      sessionToken = token;
      sessionExpiresAt = expiry;
      // Keystore-backed only; browser storage is never used for native credentials.
      persistSession({ token, expiresAt: expiry, userId: typeof data?.user?.id === 'string' ? data.user.id : '' });
    },
    async restoreSession() {
      if (!info().native) return null;
      const saved = await loadPersistedSession();
      if (!saved) return null;
      if (typeof saved.token !== 'string' || saved.token.length < 24 || saved.token.length > 512
        || /[\s\u0000-\u001f\u007f]/u.test(saved.token) || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= now()) {
        clearSession();
        return null;
      }
      sessionToken = saved.token;
      sessionExpiresAt = saved.expiresAt;
      return saved;
    },
    prepareRequest(path, headers) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f#]/u.test(path)) {
        throw new ConnectionError('请求地址无效。', 'INVALID_API_PATH');
      }
      const connection = info();
      if (!connection.configured) throw new ConnectionError(connection.error, connection.code);
      const resultHeaders = copyHeaders(headers);
      if (!connection.native) return { url: '/api' + path, credentials: 'same-origin', headers: resultHeaders };
      for (const key of Object.keys(resultHeaders)) {
        if (['authorization', 'x-palm-client'].includes(key.toLowerCase())) delete resultHeaders[key];
      }
      resultHeaders['X-Palm-Client'] = 'android';
      const token = activeToken();
      if (token) resultHeaders.Authorization = 'Bearer ' + token;
      const endpoint = /^\/auth\/(?:register|login|logout)$/u.test(path) ? '/native' + path : path;
      return { url: connection.baseUrl + endpoint, credentials: 'omit', headers: resultHeaders };
    },
  };
}

export const nativeConnection = createConnectionManager();
export const getConnectionInfo = () => nativeConnection.getConnectionInfo();
export const clearNativeSession = () => nativeConnection.clearSession();
export const restoreNativeSession = () => nativeConnection.restoreSession();
