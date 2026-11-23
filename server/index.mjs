import { parseSSE } from '../shared/provider-stream.mjs';
import { finalToolPayload, latestReminder, sourcesFromCalls, toWireToolCalls, toolEventsFromChunk } from '../shared/deepseek-events.mjs';
import http from 'node:http';
import { scrypt, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, extname, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatProvider } from './provider.mjs';
import { openStore } from './store.mjs';
import { normalizeImport, ImportError } from '../shared/import.mjs';

const scryptAsync = promisify(scrypt);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_DAYS = 30;
const COOKIE = 'companion_session';
const ASSISTANT_PROMPT = '你是 DeepSeek，一个有帮助、准确的 AI 助手。请自然、清晰地回答用户的问题，默认使用中文，并尊重用户指定的语言。';
const BODY_LIMIT = 256 * 1024;
const IMPORT_LIMIT = 24 * 1024 * 1024;
const stamp = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds, signal) => new Promise((resolvePromise, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timeout = setTimeout(() => { signal.removeEventListener('abort', aborted); resolvePromise(); }, milliseconds);
  const aborted = () => { clearTimeout(timeout); reject(signal.reason); };
  signal.addEventListener('abort', aborted, { once: true });
});

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function passwordMatches(password, encoded) {
  const [salt, expected] = encoded.split(':');
  const actual = await scryptAsync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function sessionToken(request) {
  const cookie = request.headers.cookie || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}

async function bodyJson(request, limit = BODY_LIMIT) {
  const type = request.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 JSON 格式发送请求。');
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, '内容超过大小限制，请拆分后重试。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '内容超过大小限制，请拆分后重试。');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Object required');
    return parsed;
  } catch { throw new HttpError(400, 'JSON 内容无法解析。'); }
}

function text(value, name, maximum, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, `${name}必须是文字。`);
  if (value.length > maximum) throw new HttpError(400, `${name}过长，最多 ${maximum.toLocaleString('zh-CN')} 个字符。`);
  return value;
}

function personaInput(value, previous = {}) {
  if (value === undefined) value = previous;
  if (value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '角色设定格式不正确。');
  return {
    name: text(value.name, '角色名称', 80, previous.name || '').trim(),
    description: text(value.description, '角色简介', 2000, previous.description || ''),
    systemPrompt: text(value.systemPrompt, '角色设定', 16000, previous.systemPrompt || ''),
    memory: text(value.memory, '重要记忆', 16000, previous.memory || ''),
  };
}

function conversationInput(data) {
  return { title: text(data.title, '对话标题', 120, '新的对话').trim() || '新的对话', persona: personaInput(data.persona) };
}

function importInput(data) {
  const { conversations, warnings } = normalizeImport(data);
  if (!Array.isArray(conversations) || !conversations.length || conversations.length > 200) {
    throw new HttpError(400, '一次可导入 1 至 200 段对话。');
  }
  let messageCount = 0;
  const records = conversations.map((item) => {
    if (!item || typeof item !== 'object' || !Array.isArray(item.messages)) throw new HttpError(400, '导入的对话缺少消息列表。');
    const conversation = conversationInput(item);
    conversation.messages = item.messages.map((message) => {
      messageCount += 1;
      if (messageCount > 40000) throw new HttpError(400, '一次最多导入 40,000 条消息，请拆分文件。');
      if (!message || !['user', 'assistant'].includes(message.role)) throw new HttpError(400, '消息角色无法识别。');
      const content = text(message.content, '消息', 200000);
      const reasoning = text(message.reasoning, '思考内容', 200000);
      const parsedDate = message.createdAt && Date.parse(message.createdAt);
      return { id: randomUUID(), role: message.role, content, source: 'import', ...(reasoning ? { reasoning } : {}),
        status: 'complete', createdAt: parsedDate ? new Date(parsedDate).toISOString() : stamp() };
    });
    return conversation;
  });
  return { records, warnings };
}

function buildContext(conversation, limit, prompt) {
  const persona = conversation.persona || {};
  // Earlier local previews used 新朋友 as an empty default. It must not turn an
  // ordinary assistant conversation into roleplay after upgrading that data.
  const customName = persona.name && !['新朋友', 'DeepSeek', 'DeepSeek Flash'].includes(persona.name.trim()) ? persona.name : '';
  const hasPersona = Boolean(customName || persona.description || persona.systemPrompt || persona.memory);
  const system = [
    prompt,
    hasPersona && '当前对话包含用户主动设置的可选对话偏好：',
    customName && `称呼或角色名称：${customName}`, persona.description && `简介：${persona.description}`,
    persona.systemPrompt && `用户设置的对话偏好：\n${persona.systemPrompt}`,
    persona.memory && `用户保存的重要记忆（可能不完整）：\n${persona.memory}`,
  ].filter(Boolean).join('\n\n');
  const messages = conversation.messages.filter((message) => ['user', 'assistant'].includes(message.role)
    && (message.role !== 'assistant' || (message.content && !['error', 'failed', 'generating'].includes(message.status))))
    .map((message) => ({ role: message.role, content: message.content }));
  const selected = [];
  let size = system.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (size + message.content.length > limit && selected.length) break;
    if (size + message.content.length > limit) throw new HttpError(400, '当前消息过长，请缩短内容或角色记忆。');
    selected.unshift(message); size += message.content.length;
  }
  // Starting on an assistant response makes a truncated conversation ambiguous.
  while (selected[0]?.role === 'assistant') selected.shift();
  return { messages: [{ role: 'system', content: system }, ...selected], trimmed: selected.length !== messages.length, characters: size };
}

function usageValue(usage, key) {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(usage?.[key]) || 0)));
}

function providerUsage(usage, context, assistant, mode) {
  if (mode === 'demo') return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, source: 'demo' };
  if (usage && typeof usage === 'object') {
    const inputTokens = usageValue(usage, 'prompt_tokens');
    const cacheHitTokens = Math.min(inputTokens, usageValue(usage, 'prompt_cache_hit_tokens'));
    return { inputTokens, outputTokens: usageValue(usage, 'completion_tokens'), cacheHitTokens,
      cacheMissTokens: inputTokens - cacheHitTokens, source: 'provider' };
  }
  // Deliberately marked as estimates; provider-side accounting can differ, especially after cancellation.
  const inputTokens = Math.ceil(context.characters / 2);
  return { inputTokens, outputTokens: Math.ceil((assistant.content.length + (assistant.reasoning || '').length) / 2),
    cacheHitTokens: 0, cacheMissTokens: inputTokens, source: 'estimate' };
}

export function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(ROOT, 'data'));
  const staticDir = resolve(options.staticDir || join(ROOT, 'dist'));
  const provider = chatProvider(options);
  const { model: MODEL, mode } = provider;
  const systemPrompt = provider.name === 'openrouter' ? ASSISTANT_PROMPT.replace('DeepSeek，', '') : ASSISTANT_PROMPT;
  const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
  // A server-side key is optional: users may instead supply their own key from
  // the app (BYOK). Without either, the app stays in demo mode.
  const maxOutputTokens = Math.floor(Math.max(256, Math.min(16384, Number(options.maxOutputTokens ?? process.env.MAX_OUTPUT_TOKENS) || 4096)));
  const contextCharLimit = Math.floor(Math.max(32000, Math.min(800000, Number(options.contextCharLimit ?? process.env.MAX_CONTEXT_CHARS) || 180000)));
  const maxConcurrentGenerations = Math.floor(Math.max(1, Math.min(32,
    Number(options.maxConcurrentGenerations ?? process.env.SERVER_MAX_CONCURRENT ?? process.env.MAX_CONCURRENT_GENERATIONS) || 4)));
  const upstreamTimeoutMs = Number(options.upstreamTimeoutMs) || 180000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const demoDelayMs = options.demoDelayMs ?? 25;
  const store = openStore(dataDir);
  const active = new Map();
  const rateLimits = new Map();
  const origins = new Set((options.allowedOrigins || process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((value) => value.trim()).filter(Boolean));
  const nativeOrigins = new Set((options.nativeAllowedOrigins ?? process.env.NATIVE_ALLOWED_ORIGINS ?? 'https://localhost')
    .split(',').map((value) => value.trim()).filter((value) => {
      try {
        const parsed = new URL(value);
        return ['https:', 'http:'].includes(parsed.protocol) && parsed.origin === value;
      } catch { return false; }
    }));
  const nativeSessionSeconds = Math.floor(Math.max(300, Math.min(86400,
    Number(options.nativeSessionTtlSeconds ?? process.env.NATIVE_SESSION_TTL_SECONDS) || 86400)));
  const allowRegistration = options.allowRegistration ?? process.env.ALLOW_REGISTRATION !== 'false';
  const enableLegacyHistory = options.enableLegacyHistory ?? process.env.ENABLE_LEGACY_HISTORY !== 'false';
  const metadataRetentionDays = Math.floor(Math.max(1, Math.min(3650,
    Number(options.metadataRetentionDays ?? process.env.METADATA_RETENTION_DAYS) || 90)));
  store.pruneMetadata(metadataRetentionDays);
  const maintenance = setInterval(() => {
    try { store.pruneMetadata(metadataRetentionDays); }
    catch (error) { console.error('[maintenance]', error.code || error.name || 'MaintenanceError'); }
  }, 86400000);
  maintenance.unref();
  let closed = false;
  let closePromise;

  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }

  function rateLimit(request, key, maximum, duration) {
    const id = `${key}:${request.socket.remoteAddress}`;
    const current = rateLimits.get(id);
    const record = current && current.expires > Date.now() ? current : { count: 0, expires: Date.now() + duration };
    record.count += 1;
    rateLimits.set(id, record);
    if (rateLimits.size > 10000) for (const [entryId, entry] of rateLimits) if (entry.expires < Date.now()) rateLimits.delete(entryId);
    if (record.count > maximum) throw new HttpError(429, '尝试次数过多，请稍后重试。', 'RATE_LIMITED');
  }

  function sameOrigin(request) {
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不允许跨站请求。');
    if (origin) {
      let parsed;
      try { parsed = new URL(origin); } catch { throw new HttpError(403, '请求来源无效。'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.host !== request.headers.host && !origins.has(parsed.origin))) {
        throw new HttpError(403, '请求来源未获允许。');
      }
    }
  }

  function nativeCors(request, response) {
    const origin = request.headers.origin;
    const isPreflight = request.method === 'OPTIONS';
    const client = request.headers['x-palm-client'];
    if (!client && !isPreflight) return false;
    if (!origin || !nativeOrigins.has(origin) || (!isPreflight && client !== 'android')) {
      throw new HttpError(403, '原生客户端请求来源未获允许。', 'NATIVE_ORIGIN_DENIED');
    }
    if (isPreflight) {
      const requestedMethod = (request.headers['access-control-request-method'] || '').toUpperCase();
      const requestedHeaders = String(request.headers['access-control-request-headers'] || '').toLowerCase()
        .split(',').map((value) => value.trim()).filter(Boolean);
      const allowedHeaders = new Set(['authorization', 'content-type', 'x-palm-client', 'x-palm-provider', 'x-palm-key', 'x-palm-model']);
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(requestedMethod) || !requestedHeaders.includes('x-palm-client')
        || requestedHeaders.some((header) => !allowedHeaders.has(header))) {
        throw new HttpError(403, '原生客户端预检请求未获允许。', 'NATIVE_PREFLIGHT_DENIED');
      }
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    // Deliberately no Access-Control-Allow-Credentials: native requests use only
    // their separate Bearer session, never cross-origin Web cookies.
    if (isPreflight) {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Palm-Client, X-Palm-Provider, X-Palm-Key, X-Palm-Model');
      response.setHeader('Access-Control-Max-Age', '600');
      response.writeHead(204); response.end();
    }
    return true;
  }

  // Users can bring their own provider key from the app. The key is used for
  // this request only: it is never logged, stored, or echoed back.
  function byokProvider(request) {
    const rawKey = request.headers['x-palm-key'];
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) return null;
    if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(key)) {
      throw new HttpError(400, '自备模型密钥格式无效。', 'BYOK_INVALID');
    }
    const name = String(request.headers['x-palm-provider'] || 'deepseek').trim().toLowerCase();
    if (!['deepseek', 'openrouter'].includes(name)) {
      throw new HttpError(400, '自备密钥仅支持 deepseek 或 openrouter。', 'BYOK_INVALID');
    }
    const rawModel = request.headers['x-palm-model'];
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (model && (model.length > 120 || /[^\w.:/@-]/u.test(model))) {
      throw new HttpError(400, '模型名称格式无效。', 'BYOK_INVALID');
    }
    try {
      return chatProvider({ provider: name, apiKey: key, model: model || undefined });
    } catch (error) {
      throw new HttpError(400, error.message || '自备模型配置无效。', 'BYOK_INVALID');
    }
  }

  function nativeBearer(request) {
    const authorization = request.headers.authorization || '';
    if (!/^Bearer n1_[A-Za-z0-9_-]{43}$/u.test(authorization)) {
      throw new HttpError(401, '请在 App 中重新登录。', 'UNAUTHENTICATED');
    }
    return authorization.slice(7);
  }

  function currentUser(request, native = false) {
    if (native) {
      const user = store.nativeSessionUser(hash(nativeBearer(request)));
      if (!user) throw new HttpError(401, 'App 登录已过期，请重新登录。', 'UNAUTHENTICATED');
      return user;
    }
    if (request.headers.authorization) throw new HttpError(401, '此会话需要在 App 中使用。', 'UNAUTHENTICATED');
    const token = sessionToken(request);
    if (!token || token.length > 256) throw new HttpError(401, '请先登录。', 'UNAUTHENTICATED');
    const user = store.sessionUser(hash(token));
    if (!user) throw new HttpError(401, '登录已过期，请重新登录。', 'UNAUTHENTICATED');
    return user;
  }

  function startSession(request, response, userId) {
    const token = randomBytes(32).toString('base64url');
    const seconds = SESSION_DAYS * 86400;
    store.addSession(hash(token), userId, Date.now() + seconds * 1000);
    const secure = production || (options.secureCookies ?? Boolean(request.socket.encrypted || process.env.COOKIE_SECURE === 'true'));
    response.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  }

  function startNativeSession(userId) {
    const token = `n1_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Date.now() + nativeSessionSeconds * 1000;
    store.addNativeSession(hash(token), userId, expiresAt);
    return { sessionToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function requireConversation(user, id) {
    const conversation = store.getConversation(id, user.id);
    if (!conversation) throw new HttpError(404, '对话不存在。', 'NOT_FOUND');
    return conversation;
  }

  async function settleDisconnectedGeneration(userId, conversationId, allowDisconnectGrace = false) {
    let work = active.get(userId);
    if (!work || (conversationId && work.conversationId !== conversationId)) return;
    // An aborted fetch and its follow-up GET can arrive on different sockets. Let
    // queued close notifications run before returning a persisted status snapshot.
    if (allowDisconnectGrace && !work.controller.signal.aborted && !work.response.destroyed) {
      await new Promise((done) => setTimeout(done, 20));
      work = active.get(userId);
      if (!work || (conversationId && work.conversationId !== conversationId)) return;
    }
    if (work.response.destroyed || work.response.socket?.destroyed) {
      work.controller.abort(new Error('CLIENT_DISCONNECTED'));
    }
    if (work.controller.signal.aborted) await work.done;
  }

  async function statelessChat(request, response, user) {
    const assertAvailable = () => {
      if (active.has(user.id)) throw new HttpError(409, '已有回复正在生成，请先停止或等待完成。', 'GENERATION_ACTIVE');
      if (active.size >= maxConcurrentGenerations) throw new HttpError(429, '当前同时请求较多，请稍后重试。', 'SERVER_BUSY');
    };
    assertAvailable();
    const keyProvider = byokProvider(request);
    const activeProvider = keyProvider || provider;
    const activeMode = keyProvider ? 'live' : mode;
    const activeModel = keyProvider?.model || MODEL;
    const activePrompt = activeProvider.name === 'openrouter' ? ASSISTANT_PROMPT.replace('DeepSeek，', '') : ASSISTANT_PROMPT;
    const data = await bodyJson(request);
    const requestId = text(data.requestId, '请求标识', 128);
    const conversationId = text(data.conversationId, '对话标识', 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(conversationId)) {
      throw new HttpError(400, '请求或对话标识无效。');
    }
    for (const key of ['thinking', 'webSearch', 'readUrl', 'title']) {
      if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new HttpError(400, '生成参数无效。');
    }
    if (!Array.isArray(data.messages) || !data.messages.length || data.messages.length > 300) {
      throw new HttpError(400, '一次请求需要 1 至 300 条上下文消息。', 'CONTEXT_LIMIT');
    }
    // Keep references to validated text, rather than copying a whole conversation
    // into another state object or persisting it. Privileged roles are not accepted.
    const messages = [{ role: 'system', content: activePrompt }];
    let characters = activePrompt.length;
    for (const item of data.messages) {
      if (!item || !['user', 'assistant'].includes(item.role)) throw new HttpError(400, '上下文仅支持用户与助手正文。', 'INVALID_MESSAGE_ROLE');
      const content = text(item.content, '单条消息', 60000);
      if (!/\S/u.test(content)) throw new HttpError(400, '上下文消息不能为空。');
      if (item.attachments !== undefined) throw new HttpError(400, '当前服务未启用文件输入，仅支持文字对话。', 'FEATURE_DISABLED');
      characters += content.length;
      if (characters > contextCharLimit) throw new HttpError(400, '上下文超过服务端限制，请减少旧消息后重试。', 'CONTEXT_LIMIT');
      const entry = { role: item.role, content };
      if (item.role === 'assistant' && Array.isArray(item.serverToolCalls)) {
        const wire = toWireToolCalls(item.serverToolCalls);
        if (wire.length) entry.server_tool_calls = wire;
      }
      messages.push(entry);
    }
    if (messages.at(-1).role !== 'user') throw new HttpError(400, '上下文最后一条需要是用户消息。');
    if (activeProvider.name === 'deepseek') messages.splice(messages.length - 1, 0, { role: 'latest_reminder', content: latestReminder() });
    assertAvailable();
    const assistant = { id: randomUUID(), role: 'assistant', content: '', status: 'generating', mode: activeMode, model: activeModel, createdAt: stamp() };
    if (!store.beginChatRequest(user.id, { requestId, conversationId, messageId: assistant.id, mode: activeMode, model: activeModel, inputCharacters: characters }, false)) {
      throw new HttpError(409, '这次请求已经提交，请查询请求状态或明确发起新的生成。', 'REQUEST_ALREADY_USED');
    }
    const controller = new AbortController();
    let finishWork;
    const done = new Promise((finish) => { finishWork = finish; });
    const work = { requestId, conversationId, controller, response, done };
    active.set(user.id, work);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const send = (event, value) => { if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('CLIENT_DISCONNECTED')); };
    response.once('close', disconnect);
    send('meta', { requestId, conversationId, assistantMessage: assistant, mode: activeMode, model: activeModel });
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
    const upstreamController = new AbortController();
    const timeout = setTimeout(() => upstreamController.abort(new Error('UPSTREAM_TIMEOUT')), upstreamTimeoutMs);
    const signal = AbortSignal.any([controller.signal, upstreamController.signal]);
    let usage;
    let providerStarted = false;
    let generationError;
    let serverToolCalls = [], annotations = [], title = '', refused = false;
    try {
      if (activeMode === 'demo') {
        const latest = messages.at(-1).content;
        const reply = `【演示模式 · 未调用模型】\n\n你刚才说：“${latest.slice(0, 120)}${latest.length > 120 ? '…' : ''}”\n\n这里用于体验流式回复。请在应用设置中填入自己的 API Key，或在服务端 .env 配置密钥；聊天正文保存在你的设备中。`;
        for (const chunk of reply.match(/.{1,12}|\n/gus) || []) {
          await sleep(demoDelayMs, signal);
          assistant.content += chunk; send('delta', { text: chunk });
        }
        assistant.finishReason = 'stop';
      } else {
        const options = {
          thinking: data.thinking === true,
          webSearch: activeProvider.features.webSearch === true && data.webSearch === true,
          readUrl: activeProvider.features.readUrl === true && data.readUrl === true,
          title: activeProvider.features.title === true && data.title === true,
          safety: activeProvider.features.safety === true,
          reasoning: activeProvider.name === 'openrouter' ? (data.thinking === true ? 'on' : 'off') : undefined,
        };
        const upstream = await activeProvider.generate(fetchImpl, messages, user.id, options, maxOutputTokens, signal);
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          if ([401, 403].includes(upstream.status)) throw new HttpError(502, '模型服务密钥无效或权限不足，请检查 API Key。', 'UPSTREAM_AUTH');
          if (upstream.status === 402) throw new HttpError(502, '模型服务余额不足，请检查账户。', 'UPSTREAM_BALANCE');
          if (upstream.status === 429) throw new HttpError(502, '模型服务繁忙，请稍后重试。', 'UPSTREAM_RATE_LIMIT');
          throw new HttpError(502, '模型服务暂时不可用，请稍后重试。', 'UPSTREAM_FAILED');
        }
        providerStarted = true;
        let receivedFinish = false;
        for await (const chunk of parseSSE(upstream.body)) {
          if (signal.aborted) throw signal.reason;
          if (chunk.error) throw new HttpError(502, '模型服务返回错误，请稍后重试。', 'UPSTREAM_FAILED');
          if (chunk.usage) usage = chunk.usage;
          for (const mapped of toolEventsFromChunk(chunk)) send(mapped.event, mapped.data);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const reasoningText = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta?.reasoning === 'string' ? delta.reasoning : '';
          if (reasoningText) {
            assistant.reasoning = (assistant.reasoning || '') + reasoningText;
            send('reasoning', { text: reasoningText });
          }
          if (typeof delta?.content === 'string') { assistant.content += delta.content; send('delta', { text: delta.content }); }
          if (choice?.finish_reason) {
            assistant.finishReason = choice.finish_reason; receivedFinish = true;
            const final = finalToolPayload(delta);
            if (final.serverToolCalls.length) {
              serverToolCalls = final.serverToolCalls;
              assistant.serverToolCalls = serverToolCalls;
              assistant.sources = sourcesFromCalls(serverToolCalls);
            }
            annotations = final.annotations;
            if (annotations.length) assistant.annotations = annotations;
            if (final.title) { title = final.title; assistant.title = title; send('title', { title }); }
            for (const citation of annotations) send('citation', citation);
            if (choice.finish_reason === 'content_filter') refused = true;
          }
        }
        if (refused) throw new HttpError(502, '这段内容未能通过模型安全校验，请调整后重试。', 'CONTENT_FILTERED');
        if (!receivedFinish) throw new HttpError(502, '连接提前中断，可明确发起重新生成。', 'UPSTREAM_INTERRUPTED');
        if (!assistant.content.trim()) throw new HttpError(502, '模型未返回正文，请重试。', 'EMPTY_RESPONSE');
      }
      assistant.status = 'complete';
    } catch (error) {
      if (controller.signal.aborted) assistant.status = 'stopped';
      else {
        assistant.status = 'error';
        const timedOut = upstreamController.signal.aborted;
        generationError = { code: timedOut ? 'UPSTREAM_TIMEOUT' : error.code || 'UPSTREAM_FAILED',
          message: timedOut ? '模型响应超时，请重试。' : error instanceof HttpError ? error.message : '连接暂时中断，请重试。' };
        assistant.error = generationError.message;
      }
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat);
      response.removeListener('close', disconnect);
      try {
        const normalizedUsage = activeMode === 'live' && !providerStarted ? {
          inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, source: 'estimate',
        } : providerUsage(usage, { characters }, assistant, activeMode);
        const entry = store.finishChatRequest(user.id, requestId, {
          conversationId, messageId: assistant.id, mode: activeMode, status: assistant.status, ...normalizedUsage,
        }, false);
        if (generationError) send('error', generationError);
        // Only this generated response is returned. No complete conversation is
        // materialized, stored, or sent back by the local-first API.
        send('done', { message: assistant, usage: entry });
        if (!response.destroyed) response.end();
      } finally {
        if (active.get(user.id) === work) active.delete(user.id);
        finishWork();
      }
    }
  }

  async function chat(request, response, user, id) {
    if (active.has(user.id)) throw new HttpError(409, '已有回复正在生成，请先停止或等待完成。', 'GENERATION_ACTIVE');
    if (active.size >= maxConcurrentGenerations) throw new HttpError(429, '当前同时请求较多，请稍后重试。', 'SERVER_BUSY');
    const data = await bodyJson(request);
    if (data.thinking !== undefined && typeof data.thinking !== 'boolean') throw new HttpError(400, '思考模式参数无效。');
    const conversation = requireConversation(user, id);
    if (active.has(user.id)) throw new HttpError(409, '已有回复正在生成。', 'GENERATION_ACTIVE');
    if (active.size >= maxConcurrentGenerations) throw new HttpError(429, '当前同时请求较多，请稍后重试。', 'SERVER_BUSY');
    let userMessage;
    let previousReply;
    if (data.regenerate === true) {
      const lastUserIndex = conversation.messages.findLastIndex((message) => message.role === 'user');
      if (lastUserIndex < 0) throw new HttpError(400, '还没有可以重新生成的消息。');
      userMessage = conversation.messages[lastUserIndex];
      previousReply = conversation.messages.slice(lastUserIndex + 1).findLast((message) => message.role === 'assistant');
      conversation.messages = conversation.messages.slice(0, lastUserIndex + 1);
    } else {
      const content = text(data.content, '消息', 60000).trim();
      if (!content) throw new HttpError(400, '请输入消息。');
      userMessage = { id: randomUUID(), role: 'user', content, status: 'complete', createdAt: stamp() };
      conversation.messages.push(userMessage);
      if (['新的对话', '新对话', '新的一页'].includes(conversation.title)) conversation.title = content.replace(/\s+/g, ' ').slice(0, 26);
    }
    const context = buildContext(conversation, contextCharLimit, systemPrompt);
    let assistant = { id: randomUUID(), role: 'assistant', content: '', status: 'generating',
      mode, model: MODEL, createdAt: stamp() };
    if (previousReply) {
      const { previousVersions = [], ...version } = previousReply;
      assistant.previousVersions = [...previousVersions, version].slice(-10);
    }
    conversation.messages.push(assistant);
    conversation.updatedAt = stamp();
    store.saveConversation(user.id, conversation);
    const controller = new AbortController();
    let finishWork;
    const done = new Promise((finish) => { finishWork = finish; });
    const work = { conversationId: id, controller, response, done };
    active.set(user.id, work);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const send = (event, value) => { if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('CLIENT_DISCONNECTED')); };
    response.once('close', disconnect);
    send('meta', { conversationId: id, userMessage, assistantMessage: assistant, mode, model: MODEL,
      contextTrimmed: context.trimmed, contextMessages: context.messages.length - 1 });
    let usage;
    let providerStarted = false;
    let generationError;
    let lastCheckpoint = Date.now();
    const checkpoint = () => {
      if (Date.now() - lastCheckpoint > 500) { store.saveConversation(user.id, conversation); lastCheckpoint = Date.now(); }
    };
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
    const upstreamController = new AbortController();
    const timeout = setTimeout(() => upstreamController.abort(new Error('UPSTREAM_TIMEOUT')), upstreamTimeoutMs);
    const signal = AbortSignal.any([controller.signal, upstreamController.signal]);
    try {
      if (mode === 'demo') {
        const name = conversation.persona.name || 'DeepSeek Flash';
        const reply = `【演示模式 · 未调用 DeepSeek】\n\n${name}的对话窗口已经准备好了。\n\n你刚才说：“${userMessage.content.slice(0, 160)}${userMessage.content.length > 160 ? '…' : ''}”\n\n这段文字用于体验流式回复、历史保存与角色切换，不是真实模型生成。在服务端 .env 或应用「模型与密钥」中配置 API Key 后，这里会使用 Flash 模型继续对话。`;
        for (const chunk of reply.match(/.{1,12}|\n/gus) || []) {
          await sleep(demoDelayMs, signal);
          assistant.content += chunk; send('delta', { text: chunk }); checkpoint();
        }
        assistant.finishReason = 'stop';
      } else {
        const upstream = await provider.generate(fetchImpl, context.messages, user.id, data.thinking === true, maxOutputTokens, signal);
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          if (upstream.status === 401 || upstream.status === 403) throw new HttpError(502, '模型服务密钥无效或权限不足，请检查 API Key。', 'UPSTREAM_AUTH');
          if (upstream.status === 402) throw new HttpError(502, '模型服务余额不足，请检查账户。', 'UPSTREAM_BALANCE');
          if (upstream.status === 429) throw new HttpError(502, '模型服务繁忙，请稍后重试。', 'UPSTREAM_RATE_LIMIT');
          throw new HttpError(502, '模型服务暂时不可用，请稍后重试。', 'UPSTREAM_FAILED');
        }
        providerStarted = true;
        let receivedFinish = false;
        for await (const chunk of parseSSE(upstream.body)) {
          if (signal.aborted) throw signal.reason;
          if (chunk.error) throw new HttpError(502, '模型服务返回错误，请稍后重试。', 'UPSTREAM_FAILED');
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const reasoningText = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta?.reasoning === 'string' ? delta.reasoning : '';
          if (reasoningText) {
            assistant.reasoning = (assistant.reasoning || '') + reasoningText;
            send('reasoning', { text: reasoningText });
          }
          if (typeof delta?.content === 'string') { assistant.content += delta.content; send('delta', { text: delta.content }); }
          if (choice?.finish_reason) {
            assistant.finishReason = choice.finish_reason; receivedFinish = true;
            if (choice.finish_reason === 'content_filter') throw new HttpError(502, '这段内容未能通过模型安全校验，请调整后重试。', 'CONTENT_FILTERED');
          }
          checkpoint();
        }
        if (!receivedFinish) throw new HttpError(502, '连接提前中断，已保存收到的内容，可重新生成。', 'UPSTREAM_INTERRUPTED');
        if (!assistant.content.trim()) throw new HttpError(502, '模型未返回正文，已保存收到的内容，请重试。', 'EMPTY_RESPONSE');
      }
      assistant.status = 'complete';
    } catch (error) {
      if (controller.signal.aborted) assistant.status = 'stopped';
      else {
        assistant.status = 'error';
        const timedOut = upstreamController.signal.aborted;
        generationError = { code: timedOut ? 'UPSTREAM_TIMEOUT' : error.code || 'UPSTREAM_FAILED',
          message: timedOut ? '模型响应超时，已保存收到的内容，请重试。' : error instanceof HttpError ? error.message : '连接暂时中断，已保存收到的内容，请重试。' };
        assistant.error = generationError.message;
      }
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat);
      response.removeListener('close', disconnect);
      try {
        const normalizedUsage = mode === 'live' && !providerStarted ? {
          inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, source: 'estimate',
        } : providerUsage(usage, context, assistant, mode);
        const generatedMessageId = assistant.id;
        const generatedStatus = assistant.status;
        if (generationError && previousReply?.content) {
          const { previousVersions: ignored, ...failedVersion } = assistant;
          assistant = { ...previousReply, previousVersions: [...(previousReply.previousVersions || []), failedVersion].slice(-10) };
          conversation.messages[conversation.messages.length - 1] = assistant;
          generationError.restoredPrevious = true;
          generationError.message += ' 已保留上一版回复。';
        }
        conversation.updatedAt = stamp();
        store.saveConversation(user.id, conversation);
        const entry = store.addUsage(user.id, { conversationId: id, messageId: generatedMessageId, mode, status: generatedStatus, ...normalizedUsage });
        if (generationError) send('error', generationError);
        send('done', { message: assistant, usage: entry, conversation });
        if (!response.destroyed) response.end();
      } finally {
        if (active.get(user.id) === work) active.delete(user.id);
        finishWork();
      }
    }
  }

  async function serveStatic(request, response, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '请求方法不支持。');
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, '路径无法解析。'); }
    if (decoded.includes('\0') || decoded.split(/[\\/]/).some((part) => part.startsWith('.'))) throw new HttpError(404, '页面不存在。');
    let file = resolve(staticDir, `.${decoded}`);
    const within = relative(staticDir, file);
    if (within.startsWith('..') || isAbsolute(within)) throw new HttpError(404, '页面不存在。');
    let info;
    try { info = await stat(file); } catch { /* SPA fallback below. */ }
    if (info?.isDirectory()) { file = join(file, 'index.html'); try { info = await stat(file); } catch { info = null; } }
    if (!info?.isFile()) {
      if (extname(decoded) && decoded !== '/') throw new HttpError(404, '文件不存在。');
      file = join(staticDir, 'index.html');
      try { info = await stat(file); } catch { info = null; }
    }
    if (!info?.isFile()) throw new HttpError(404, '前端尚未构建，请先运行 npm run build，或使用开发服务器。');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size, 'Cache-Control': decoded.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (closed) throw new HttpError(503, '服务正在关闭。');
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;
      if (!pathname.startsWith('/api/')) return await serveStatic(request, response, pathname);
      const native = nativeCors(request, response);
      if (request.method === 'OPTIONS') return;
      if (!native && !['GET', 'HEAD'].includes(request.method)) sameOrigin(request);
      if (pathname === '/api/config' && request.method === 'GET') return json(response, 200, {
        appName: 'PalmChat', byok: true, provider: provider.name, mode, model: MODEL, allowRegistration, contextCharLimit, maxOutputTokens,
        features: mode === 'live' ? { ...provider.features, fileInput:false, imageInput:false, asr:false, tts:false } : { fileInput:false, imageInput:false, asr:false, tts:false },
        maxUploadBytes: 20 * 1024 * 1024, maxAudioSeconds: 120,
        chatLimits: { maxMessages: 300, maxMessageCharacters: 60000, maxBodyBytes: BODY_LIMIT, maxConcurrent: maxConcurrentGenerations },
        nativeLocalOnly: true, legacyHistoryEnabled: enableLegacyHistory, metadataRetentionDays,
      });
      if (pathname === '/api/health' && request.method === 'GET') return json(response, 200, { ok: true, mode });
      if (['/api/auth/register', '/api/auth/login', '/api/native/auth/register', '/api/native/auth/login'].includes(pathname) && request.method === 'POST') {
        const nativeAuth = pathname.startsWith('/api/native/');
        if (nativeAuth !== native) throw new HttpError(403, '请使用当前客户端对应的登录接口。', 'AUTH_CLIENT_MISMATCH');
        rateLimit(request, 'auth', 30, 15 * 60 * 1000);
        const data = await bodyJson(request, 8192);
        const username = text(data.username, '用户名', 32).trim();
        const password = text(data.password, '密码', 128);
        if (!/^[\p{L}\p{N}_.-]{2,32}$/u.test(username)) throw new HttpError(400, '用户名需为 2–32 个中文、字母、数字、点、横线或下划线。');
        if (password.length < 8) throw new HttpError(400, '密码至少需要 8 个字符。');
        let user;
        if (pathname.endsWith('/register')) {
          if (!allowRegistration) throw new HttpError(403, '当前未开放注册。');
          rateLimit(request, 'register', 10, 60 * 60 * 1000);
          const encoded = await passwordHash(password);
          try { user = store.createUser(username, encoded); }
          catch (error) {
            if (error.code?.startsWith('ERR_SQLITE') || error.message.includes('UNIQUE')) throw new HttpError(409, '这个用户名已被使用。');
            throw error;
          }
        } else {
          const row = store.findUser(username);
          if (!row) throw new HttpError(401, '账号不存在，请检查用户名。', 'USER_NOT_FOUND');
          const encoded = row.password_hash || '00000000000000000000000000000000:' + '0'.repeat(128);
          const valid = await passwordMatches(password, encoded);
          if (!valid) throw new HttpError(401, '密码不正确，请重试。', 'PASSWORD_INCORRECT');
          user = { id: row.id, username: row.username, createdAt: row.created_at };
        }
        if (nativeAuth) return json(response, pathname.endsWith('/register') ? 201 : 200, { user, ...startNativeSession(user.id) });
        startSession(request, response, user.id);
        return json(response, pathname.endsWith('/register') ? 201 : 200, { user });
      }
      if (pathname === '/api/native/auth/logout' && request.method === 'POST') {
        if (!native) throw new HttpError(403, '请使用 App 的退出登录接口。', 'AUTH_CLIENT_MISMATCH');
        store.deleteNativeSession(hash(nativeBearer(request)));
        return json(response, 200, { ok: true });
      }
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        if (native || request.headers.authorization) throw new HttpError(403, '请使用 App 的退出登录接口。', 'AUTH_CLIENT_MISMATCH');
        store.deleteSession(hash(sessionToken(request)));
        response.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return json(response, 200, { ok: true });
      }
      const user = currentUser(request, native);
      if (pathname === '/api/auth/me' && request.method === 'GET') return json(response, 200, { user });
      if (/^\/api\/(?:conversations(?:\/|$)|import(?:\/|$))/u.test(pathname)) {
        if (native) throw new HttpError(403, 'App 的聊天记录仅保存在设备中，请使用本地历史功能。', 'NATIVE_LOCAL_HISTORY');
        if (!enableLegacyHistory) throw new HttpError(403, '当前服务未启用旧版云端聊天记录。', 'LEGACY_HISTORY_DISABLED');
      }
      if (pathname === '/api/chat' && request.method === 'POST') return await statelessChat(request, response, user);
      const chatMatch = /^\/api\/chat\/([A-Za-z0-9_-]{8,128})(?:\/(stop))?$/.exec(pathname);
      if (chatMatch && ['GET', 'POST'].includes(request.method)) {
        const [, requestId, action] = chatMatch;
        if ((!action && request.method !== 'GET') || (action && request.method !== 'POST')) throw new HttpError(405, '请求方法不支持。');
        const record = store.chatRequest(user.id, requestId);
        if (!record) throw new HttpError(404, '请求不存在。', 'NOT_FOUND');
        const work = active.get(user.id);
        if (work?.requestId === requestId) {
          if (action === 'stop') { work.controller.abort(new Error('USER_STOPPED')); await work.done; }
          else await settleDisconnectedGeneration(user.id, work.conversationId, true);
        }
        const result = store.chatRequest(user.id, requestId);
        return json(response, 200, action === 'stop' ? { ok: true, requestId, status: result.status, usage: result.usage } : result);
      }
      if (pathname === '/api/usage' && request.method === 'GET') return json(response, 200, {
        model: MODEL, mode, retentionDays: metadataRetentionDays, ...store.usage(user.id),
      });
      if (pathname === '/api/conversations' && request.method === 'GET') {
        await settleDisconnectedGeneration(user.id);
        return json(response, 200, { conversations: store.listConversations(user.id) });
      }
      if (pathname === '/api/conversations' && request.method === 'POST') {
        const data = conversationInput(await bodyJson(request));
        return json(response, 201, { conversation: store.createConversation(user.id, data) });
      }
      if (pathname === '/api/import' && request.method === 'POST') {
        const data = await bodyJson(request, IMPORT_LIMIT);
        const normalized = importInput(data.data);
        const records = data.persona === undefined ? normalized.records
          : normalized.records.map((record) => ({ ...record, persona: personaInput(data.persona) }));
        const conversations = store.importConversations(user.id, records);
        return json(response, 201, { count: conversations.length, conversations, warnings: normalized.warnings });
      }
      const match = /^\/api\/conversations\/([\da-f-]{36})(?:\/(chat|stop))?$/.exec(pathname);
      if (match) {
        const [, id, action] = match;
        if (action === 'chat' && request.method === 'POST') return await chat(request, response, user, id);
        if (action === 'stop' && request.method === 'POST') {
          requireConversation(user, id);
          const work = active.get(user.id);
          if (work?.conversationId === id) {
            work.controller.abort(new Error('USER_STOPPED'));
            await work.done;
          }
          return json(response, 200, { ok: true, conversation: requireConversation(user, id) });
        }
        if (!action && request.method === 'GET') {
          requireConversation(user, id);
          await settleDisconnectedGeneration(user.id, id, true);
          return json(response, 200, { conversation: requireConversation(user, id) });
        }
        if (!action && ['PATCH', 'DELETE'].includes(request.method)) {
          if (active.get(user.id)?.conversationId === id) throw new HttpError(409, '请先停止正在生成的回复。', 'GENERATION_ACTIVE');
          let conversation = requireConversation(user, id);
          if (request.method === 'DELETE') { store.deleteConversation(id, user.id); return json(response, 200, { ok: true }); }
          const data = await bodyJson(request);
          if (active.get(user.id)?.conversationId === id) throw new HttpError(409, '请先停止正在生成的回复。', 'GENERATION_ACTIVE');
          conversation = requireConversation(user, id);
          if (data.title !== undefined) conversation.title = text(data.title, '对话标题', 120).trim() || '新的对话';
          if (data.persona !== undefined) conversation.persona = personaInput(data.persona, conversation.persona);
          conversation.updatedAt = stamp(); store.saveConversation(user.id, conversation);
          return json(response, 200, { conversation });
        }
      }
      throw new HttpError(404, '接口不存在。', 'NOT_FOUND');
    } catch (error) {
      if (response.headersSent) { if (!response.destroyed) response.end(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof ImportError ? 400 : 500;
      json(response, status, { error: { message: status === 500 ? '服务暂时出错，请稍后重试。' : error.message, code: error.code || 'INTERNAL_ERROR' } });
      if (status === 500) console.error('[server]', error.code || error.name || 'InternalError');
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;

  return { server, store, mode,
    async listen(port = 8787, host = '127.0.0.1') {
      await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); done(); }); });
      return server.address();
    },
    close() {
      if (!closePromise) closePromise = (async () => {
        closed = true;
        clearInterval(maintenance);
        for (const work of active.values()) work.controller.abort(new Error('SERVER_SHUTDOWN'));
        server.closeIdleConnections();
        await new Promise((done) => server.close(done));
        store.close();
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const app = createApp();
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`PalmChat服务：http://${host}:${port} · ${app.mode === 'demo' ? '演示模式（未配置 DeepSeek 密钥）' : '已配置模型服务'}`);
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await app.close(); process.exit(0); });
}
