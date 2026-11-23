import { nativeConnection } from './native.js';
import { localChatStore, LOCAL_CHAT_LIMITS } from './local-chat-store.js';
import { byokHeaders } from './byok.js';
export { getConnectionInfo, clearNativeSession } from './native.js';
export { flushLocalChats } from './local-chat-store.js';

const utf8 = new TextEncoder();
const copy = (value) => JSON.parse(JSON.stringify(value));
const fault = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

export function mergeAbortSignals(signals) {
  const sources = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(sources), cleanup() {} };
  const controller = new AbortController();
  const listeners = [];
  for (const signal of sources) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    listeners.push([signal, abort]);
  }
  return { signal: controller.signal, cleanup() { for (const [signal, abort] of listeners) signal.removeEventListener('abort', abort); } };
}

function responseError(response, data, fallback) {
  const message = data?.error?.message || (typeof data?.error === 'string' ? data.error : null) || data?.message || fallback;
  return fault(typeof message === 'string' ? message : fallback, data?.error?.code || (response.status === 401 ? 'UNAUTHORIZED' : 'REQUEST_FAILED'), response.status);
}

const FILE_ID = /^file-api-[A-Za-z0-9_-]{8,120}$/u;
const INLINE_IMAGE = /^data:image\/(?:jpeg|png|webp|gif);base64,/iu;
const INLINE_PDF = /^data:application\/pdf;base64,/iu;
export function attachmentOf(message) {
  if (!Array.isArray(message.attachments)) return [];
  return message.attachments.slice(0, 5).flatMap((file) => {
    if (!file) return [];
    const name = typeof file.name === 'string' ? file.name.slice(0, 160) : '';
    if (typeof file.fileId === 'string' && FILE_ID.test(file.fileId))
      return [{ fileId: file.fileId, name, kind: file.kind === 'image' ? 'image' : 'document' }];
    if (file.mode !== 'inline') return [];
    if (file.kind === 'image' && typeof file.dataUrl === 'string' && INLINE_IMAGE.test(file.dataUrl) && file.dataUrl.length <= 1_200_000)
      return [{ mode: 'inline', name, kind: 'image', dataUrl: file.dataUrl }];
    if (file.kind === 'document' && typeof file.dataUrl === 'string' && INLINE_PDF.test(file.dataUrl) && file.dataUrl.length <= 5_600_000)
      return [{ mode: 'inline', name, kind: 'document', dataUrl: file.dataUrl }];
    if (file.kind === 'document' && typeof file.text === 'string' && file.text.length <= 120000)
      return [{ mode: 'inline', name, kind: 'document', text: file.text }];
    return [];
  });
}
const toolCallsOf = (message) => Array.isArray(message.serverToolCalls) ? message.serverToolCalls : [];

/** Select whole recent turns without modifying the complete device history. */
export function buildNativeContext(conversation, { requestId, thinking = false, webSearch = false, readUrl = false } = {}) {
  const rounds = [];
  let skipped = false;
  for (const message of conversation.messages) {
    if (!['user', 'assistant'].includes(message.role) || !message.content || (message.role === 'assistant' && message.status === 'error' && !message.serverToolCalls)) { skipped = true; continue; }
    if (message.role === 'user') rounds.push([]);
    if (!rounds.length) { skipped = true; continue; }
    const entry = { role: message.role, content: message.content };
    if (message.role === 'user') {
      const attachments = attachmentOf(message);
      if (attachments.length) entry.attachments = attachments;
    } else {
      const serverToolCalls = toolCallsOf(message);
      if (serverToolCalls.length) entry.serverToolCalls = serverToolCalls;
    }
    rounds.at(-1).push(entry);
  }
  if (!rounds.length || rounds.at(-1).at(-1)?.role !== 'user') throw fault('没有可以发送的用户消息。', 'INVALID_CONTEXT');
  if (rounds.at(-1)[0].content.length > 60000) throw fault('这条消息过长，请缩短到 60,000 字符以内。', 'CONTEXT_TOO_LARGE');
  const usable = rounds.filter((round, index) => {
    if (index === rounds.length - 1 || round.every((message) => message.content.length <= 60000)) return true;
    skipped = true; return false;
  });
  let selected = usable;
  const title = ['新对话', '新的对话', '新的一页'].includes(conversation.title);
  while (true) {
    const payload = { requestId, conversationId: conversation.id, messages: selected.flat(), thinking: thinking === true,
      webSearch: webSearch === true, readUrl: readUrl === true, ...(title ? { title: true } : {}) };
    const characters = payload.messages.reduce((sum, message) => sum + message.content.length + (message.attachments?.length || 0) * 20, 0);
    const inline = payload.messages.some((message) => message.attachments?.some((file) => file.mode === 'inline'));
    const maximumBytes = inline ? 6 * 1024 * 1024 : 240 * 1024;
    if (payload.messages.length <= 300 && characters <= 80000 && utf8.encode(JSON.stringify(payload)).length <= maximumBytes) {
      return { payload, trimmed: skipped || selected.length !== rounds.length, contextMessages: payload.messages.length };
    }
    // Drop the oldest optional tool trace first, then whole old turns. Chat text is kept as long as possible.
    let removedToolTrace = false;
    for (const message of selected.flat()) {
      if (message.serverToolCalls) { delete message.serverToolCalls; removedToolTrace = true; break; }
    }
    if (removedToolTrace) continue;
    if (selected.length === 1) throw fault('当前消息编码后过大，请缩短后再发送。完整记录仍保存在本机。', 'CONTEXT_TOO_LARGE');
    selected = selected.slice(1);
  }
}

async function consumeStream(response, onEvent, { deferErrors = false } = {}) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务器未返回对话流');
  if (!response.body) throw new Error('服务器返回了空的对话流，请重试');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let completed = false;
  let deferredError;
  function emit(block) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const raw = data.join('\n');
    if (raw === '[DONE]') { completed = true; return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('对话流格式异常，请重新打开此对话'); }
    if (event === 'done') completed = true;
    if (event === 'error') {
      const error = fault(parsed.message || parsed.error || '生成中断，请重试', parsed.code || 'GENERATION_FAILED', 502);
      if (deferErrors) { deferredError = error; return; }
      throw error;
    }
    onEvent(event, parsed);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      pending = pending.replace(/\r\n/g, '\n');
      let index;
      while ((index = pending.indexOf('\n\n')) !== -1) { emit(pending.slice(0, index)); pending = pending.slice(index + 2); }
      if (done) break;
    }
    if (pending.trim()) emit(pending);
    if (deferredError) throw deferredError;
    if (!completed) throw new Error('连接已中断，已生成的内容会保留');
  } finally { reader.releaseLock(); }
}

export function createApiClient(connection = nativeConnection, { store = localChatStore, now = () => new Date().toISOString(), makeId = () => crypto.randomUUID(), checkpointMs = 1500 } = {}) {
  let accountId = null;
  let activeGeneration = null;
  let configuration = {};
  const native = () => connection.getConnectionInfo().native;
  function clearAccount() {
    const previous = accountId;
    accountId = null;
    connection.clearSession();
    if (previous && activeGeneration?.accountId !== previous) store.forget(previous);
  }
  function localAccount() {
    const info = connection.getConnectionInfo();
    if (info.native && !info.configured) throw fault(info.error, info.code);
    if (!info.native || !info.authenticated || !accountId) throw fault('请先登录后再读取本机聊天记录。', 'UNAUTHORIZED', 401);
    return accountId;
  }
  async function remoteApi(path, options = {}) {
    const hasBody = options.body !== undefined && options.body !== null;
    const request = connection.prepareRequest(path, options.headers);
    const headers = { ...request.headers };
    if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    try {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 20000);
      const merged = mergeAbortSignals([options.signal, timeout.signal]);
      let response;
      try {
        response = await fetch(request.url, { ...options, signal: merged.signal, credentials: request.credentials,
          headers, body: hasBody ? JSON.stringify(options.body) : undefined });
      } catch (error) {
        if (timeout.signal.aborted) throw fault('请求超时，请检查网络后重试。', 'TIMEOUT', 0);
        if (error.name === 'AbortError') throw error;
        const detail = error?.message && !/failed to fetch/iu.test(error.message) ? '：' + error.message : '';
        throw fault('网络连接失败，请检查网络后重试。' + detail, 'NETWORK_ERROR', 0);
      } finally {
        clearTimeout(timer);
        merged.cleanup();
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) clearAccount();
        throw responseError(response, data, '操作未完成，请稍后重试');
      }
      if (native() && ['/auth/register', '/auth/login', '/auth/me'].includes(path)) {
        if (typeof data.user?.id !== 'string' || !/^[\w-]{1,128}$/u.test(data.user.id)) throw fault('登录信息无效，请重试。', 'INVALID_SESSION', 401);
        if (path !== '/auth/me') connection.acceptSession(data);
        if (accountId && accountId !== data.user.id) store.forget(accountId);
        accountId = data.user.id;
        const { sessionToken: privateToken, ...publicData } = data;
        return publicData;
      }
      if (path === '/config') {
        configuration = data;
        if (native()) return { ...data, storageMode: 'device-encrypted', historyOnDevice: true, localLimits: LOCAL_CHAT_LIMITS };
      }
      return data;
    } finally { if (native() && path === '/auth/logout') clearAccount(); }
  }
  async function remoteStream(path, body, signal, onEvent, options) {
    // The self-hosted Node relay accepts a per-request BYOK key on /chat.
    const request = connection.prepareRequest(path, { 'Content-Type': 'application/json',
      ...(path === '/chat' ? byokHeaders() : {}) });
    let response;
    try {
      response = await fetch(request.url, { method: 'POST', credentials: request.credentials, headers: request.headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const detail = error?.message && !/failed to fetch/iu.test(error.message) ? '：' + error.message : '';
      throw fault('网络连接失败，请检查网络后重试。' + detail, 'NETWORK_ERROR', 0);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) clearAccount();
      throw responseError(response, data, '暂时无法发送，请重试');
    }
    return consumeStream(response, onEvent, options);
  }
  async function multipart(path, file, fields = {}) {
    const request = connection.prepareRequest(path);
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
    form.append('file', file, (file?.name || 'upload').slice(0, 160));
    let response;
    try {
      response = await fetch(request.url, { method: 'POST', headers: request.headers, body: form, credentials: request.credentials });
    } catch (error) {
      const detail = error?.message && !/failed to fetch/iu.test(error.message) ? '：' + error.message : '';
      throw fault('网络连接失败，请检查网络后重试。' + detail, 'NETWORK_ERROR', 0);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw responseError(response, data, '上传失败，请稍后重试');
    return data;
  }
  async function speechTts(text, voiceId = 'stella') {
    const request = connection.prepareRequest('/speech/tts');
    const headers = { ...request.headers, 'Content-Type': 'application/json' };
    let response;
    try {
      response = await fetch(request.url, { method: 'POST', headers, credentials: request.credentials,
        body: JSON.stringify({ text, voiceId }) });
    } catch (error) {
      const detail = error?.message && !/failed to fetch/iu.test(error.message) ? '：' + error.message : '';
      throw fault('网络连接失败，请检查网络后重试。' + detail, 'NETWORK_ERROR', 0);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw responseError(response, data, '朗读失败，请稍后重试');
    }
    return response.blob();
  }
  const uploadFile = (file, purpose) => multipart('/files', file, { purpose });
  const speechAsr = (file) => multipart('/speech/asr', file);
  async function stopNative(work, { abort = false } = {}) {
    if (!work) return { ok: true, status: 'stopped' };
    work.stopping = true;
    let result;
    try { result = await remoteApi('/chat/' + work.requestId + '/stop', { method: 'POST', body: {} }); }
    catch (error) { work.controller.abort(); if (error.status !== 404) work.stopError = error; }
    if (abort) work.controller.abort();
    await work.done;
    return result || { ok: true, status: 'stopped' };
  }
  async function api(path, options = {}) {
    if (!native()) return remoteApi(path, options);
    if (path === '/auth/logout') {
      if (activeGeneration) await stopNative(activeGeneration, { abort: true });
      return remoteApi(path, options);
    }
    if (path === '/import') return store.import(localAccount(), options.body?.data);
    if (path.startsWith('/conversations')) {
      const owner = localAccount();
      const method = (options.method || 'GET').toUpperCase();
      const [routePath, queryString] = path.split('?');
      const searchQuery = new URLSearchParams(queryString || '').get('q') || '';
      if (routePath === '/conversations') {
        if (method === 'GET') return store.list(owner, searchQuery);
        if (method === 'POST') return { conversation: await store.create(owner, options.body || {}) };
      }
      const match = /^\/conversations\/([\da-f-]{36})(?:\/(stop))?$/iu.exec(routePath);
      if (!match) throw fault('本机会话操作无效。', 'NOT_FOUND', 404);
      const [, id, action] = match;
      const work = activeGeneration?.accountId === owner && activeGeneration.conversationId === id ? activeGeneration : null;
      if (action === 'stop' && method === 'POST') return stopNative(work);
      if (!action && method === 'GET') return { conversation: work?.conversation ? copy(work.conversation) : await store.get(owner, id, { recoverGenerating: true }) };
      if (work) throw fault('请先停止正在生成的回复。', 'GENERATION_ACTIVE', 409);
      if (!action && method === 'PATCH') return { conversation: await store.update(owner, id, options.body || {}) };
      if (!action && method === 'DELETE') return store.remove(owner, id);
      throw fault('本机会话操作无效。', 'NOT_FOUND', 404);
    }
    return remoteApi(path, options);
  }

  async function streamChat(id, body, callerSignal, onEvent) {
    if (!native()) return remoteStream('/conversations/' + encodeURIComponent(id) + '/chat', body, callerSignal, onEvent);
    const owner = localAccount();
    if (activeGeneration) throw fault('已有回复正在生成，请先停止或等待完成。', 'GENERATION_ACTIVE', 409);
    let resolveDone;
    const work = { accountId: owner, conversationId: id, requestId: makeId(), controller: new AbortController(), stopping: false,
      done: new Promise((resolve) => { resolveDone = resolve; }), conversation: null };
    activeGeneration = work;
    let timer = null;
    let checkpoints = Promise.resolve();
    let unregister = () => {};
    let previousReply;
    let assistant;
    let failure;
    let requestSent = false;
    let prepared = false;
    let cleanupSignals = () => {};
    const persistSnapshot = () => {
      if (!work.conversation) return Promise.resolve();
      const snapshot = copy(work.conversation);
      checkpoints = checkpoints.catch(() => {}).then(() => store.save(owner, snapshot));
      return checkpoints;
    };
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; persistSnapshot().catch((error) => { work.storageError = error; work.controller.abort(); }); }, checkpointMs);
    };
    try {
      const conversation = await store.get(owner, id, { recoverGenerating: true });
      work.conversation = conversation;
      let userMessage;
      if (body.regenerate === true) {
        const index = conversation.messages.findLastIndex((message) => message.role === 'user');
        if (index < 0) throw fault('还没有可以重新生成的消息。', 'INVALID_CONTEXT');
        userMessage = conversation.messages[index];
        previousReply = conversation.messages.slice(index + 1).findLast((message) => message.role === 'assistant');
        conversation.messages = conversation.messages.slice(0, index + 1);
      } else {
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content || content.length > 60000) throw fault('请输入不超过 60,000 字符的消息。', 'INVALID_MESSAGE');
        const attachments = attachmentOf({ attachments: body.attachments }).map((file) => {
          const original = Array.isArray(body.attachments) ? body.attachments.find((item) => item
            && (item.fileId === file.fileId || (item.mode === 'inline' && item.name === file.name && item.kind === file.kind))) : null;
          return { ...file, size: Number.isSafeInteger(original?.size) ? original.size : 0,
            ...(typeof original?.preview === 'string' && original.preview.startsWith('data:image/') && original.preview.length <= 200000 ? { preview: original.preview } : {}) };
        });
        userMessage = { id: makeId(), role: 'user', content, status: 'complete', createdAt: now(),
          ...(attachments.length ? { attachments } : {}) };
        conversation.messages.push(userMessage);
        if (['新对话', '新的对话', '新的一页'].includes(conversation.title)) conversation.title = content.replace(/\s+/gu, ' ').slice(0, 26);
      }
      const context = buildNativeContext(conversation, { requestId: work.requestId, thinking: body.thinking,
        webSearch: body.webSearch, readUrl: body.readUrl });
      assistant = { id: makeId(), requestId: work.requestId, role: 'assistant', content: '', reasoning: '', status: 'generating', createdAt: now(),
        mode: configuration.mode || 'live', model: configuration.model || 'deepseek-flash' };
      if (previousReply) {
        const { previousVersions = [], ...version } = previousReply;
        assistant.previousVersions = [...previousVersions, version].slice(-10);
      }
      conversation.messages.push(assistant);
      conversation.updatedAt = now();
      await store.save(owner, conversation);
      prepared = true;
      unregister = store.registerFlusher(persistSnapshot);
      onEvent('meta', { requestId: work.requestId, conversationId: id, userMessage, assistantMessage: copy(assistant),
        contextTrimmed: context.trimmed, contextMessages: context.contextMessages, storageMode: 'device-encrypted' });
      requestSent = true;
      const combined = mergeAbortSignals([callerSignal, work.controller.signal]);
      const signal = combined.signal;
      cleanupSignals = combined.cleanup;
      await remoteStream('/chat', context.payload, signal, (event, data) => {
        if (event === 'meta') {
          assistant = { ...assistant, ...data.assistantMessage, requestId: work.requestId };
          conversation.messages[conversation.messages.length - 1] = assistant;
          onEvent('meta', { ...data, userMessage, assistantMessage: copy(assistant),
            contextTrimmed: Boolean(context.trimmed || data.contextTrimmed), contextMessages: context.contextMessages });
        } else if (event === 'delta' || event === 'reasoning') {
          const key = event === 'delta' ? 'content' : 'reasoning';
          assistant[key] = (assistant[key] || '') + (data.text || data.content || '');
          conversation.updatedAt = now(); schedule();
          onEvent(event, data);
        } else if (event === 'tool') {
          const call = data.call || {};
          const sources = Array.isArray(call.sources) ? call.sources : [];
          const existing = new Map((assistant.sources || []).map((source) => [source.url, source]));
          for (const source of sources) if (source?.url) existing.set(source.url, source);
          assistant.sources = [...existing.values()].slice(-30);
          assistant.toolStatus = data.phase === 'done' ? '' :
            call.action?.type === 'read_link' || call.kind === 'read_link' ? '正在阅读链接…' :
              call.kind?.includes('image') ? '正在搜索图片…' : '正在联网搜索…';
          conversation.messages[conversation.messages.length - 1] = assistant;
          schedule();
          onEvent('tool', data);
        } else if (event === 'citation') {
          assistant.citations = [...(assistant.citations || []), data].slice(-100);
          conversation.messages[conversation.messages.length - 1] = assistant;
          schedule();
          onEvent('citation', data);
        } else if (event === 'title') {
          if (typeof data.title === 'string' && data.title.trim()) {
            assistant.title = data.title.trim().slice(0, 120);
            conversation.title = assistant.title;
            conversation.messages[conversation.messages.length - 1] = assistant;
            schedule();
          }
          onEvent('title', data);
        } else if (event === 'done') {
          assistant = { ...assistant, ...data.message, requestId: work.requestId };
          if (!assistant.content && data.message?.content) assistant.content = data.message.content;
          if (assistant.refused) assistant.status = 'error';
          if (assistant.title) conversation.title = assistant.title;
          conversation.messages[conversation.messages.length - 1] = assistant;
          onEvent('done', { ...data, message: copy(assistant) });
        } else onEvent(event, data);
      }, { deferErrors: true });
      if (assistant.status === 'generating') assistant.status = work.stopping ? 'stopped' : 'complete';
    } catch (error) {
      failure = work.storageError || error;
      if (prepared && assistant) {
        const stopped = error.name === 'AbortError' || work.stopping || work.controller.signal.aborted;
        assistant.status = stopped ? 'stopped' : 'error';
        if (!stopped) assistant.error = failure.message;
        if (!stopped && previousReply?.content) {
          const { previousVersions: omitted, ...failedVersion } = assistant;
          assistant = { ...previousReply, previousVersions: [...(previousReply.previousVersions || []), failedVersion].slice(-10) };
          work.conversation.messages[work.conversation.messages.length - 1] = assistant;
        }
      }
      work.controller.abort();
      // A rejected preflight has no upstream generation to cancel.
      if (requestSent && !['DEEPSEEK_TRIAL_EXHAUSTED', 'DEEPSEEK_TRIAL_PENDING'].includes(error.code)) {
        try { await remoteApi('/chat/' + work.requestId + '/stop', { method: 'POST', body: {} }); } catch {}
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
      cleanupSignals();
      if (prepared) {
        work.conversation.updatedAt = now();
        try { await persistSnapshot(); } catch (error) { failure = error; }
      }
      unregister();
      if (activeGeneration === work) activeGeneration = null;
      if (accountId !== owner) store.forget(owner);
      resolveDone();
    }
    if (failure) throw failure;
  }

  async function handleAppPause() {
    if (!native()) return;
    const work = activeGeneration;
    let storageError;
    try { await store.flush(); } catch (error) { storageError = error; }
    if (work) await stopNative(work, { abort: true });
    await store.flush();
    if (storageError) throw storageError;
  }
  return { api, streamChat, handleAppPause, uploadFile, speechAsr, speechTts };
}

const client = createApiClient();
export const api = (path, options) => client.api(path, options);
export const streamChat = (id, body, signal, onEvent) => client.streamChat(id, body, signal, onEvent);
export const handleAppPause = () => client.handleAppPause();
export const uploadFile = (file, purpose) => client.uploadFile(file, purpose);
export const speechAsr = (file) => client.speechAsr(file);
export const speechTts = (text, voiceId) => client.speechTts(text, voiceId);
