import { registerPlugin } from '@capacitor/core';
import { normalizeImport } from '../shared/import.mjs';

const vault = registerPlugin('LocalChatStore');
const utf8 = new TextEncoder();
export const LOCAL_CHAT_LIMITS = Object.freeze({ conversationBytes: 8 * 1024 * 1024, accountBytes: 64 * 1024 * 1024, conversations: 500 });
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class LocalChatError extends Error {
  constructor(message, code = 'LOCAL_STORAGE_FAILED', status = 400) { super(message); this.name = 'LocalChatError'; this.code = code; this.status = status; }
}

const problem = (message, code, status) => { throw new LocalChatError(message, code, status); };
const validAccount = (accountId) => {
  if (typeof accountId !== 'string' || !/^[\w-]{1,128}$/u.test(accountId)) problem('请先登录后再读取本机聊天记录。', 'UNAUTHORIZED', 401);
};
const validId = (id) => {
  if (typeof id !== 'string' || !uuid.test(id)) problem('本机会话编号无效。', 'INVALID_CONVERSATION');
  return id.toLowerCase();
};
const readText = (value, name, maximum, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > maximum) problem(`${name}格式无效或超过长度限制。`, 'INVALID_CONVERSATION');
  return value;
};
function persona(value) {
  const data = object(value) ? value : {};
  return { name: readText(data.name, '角色名字', 80), description: readText(data.description, '角色简介', 2000),
    systemPrompt: readText(data.systemPrompt, '角色设定', 16000), memory: readText(data.memory, '重要记忆', 16000) };
}
const fileId = /^file-api-[A-Za-z0-9_-]{8,120}$/u;
const inlineImage = /^data:image\/(?:jpeg|png|webp|gif);base64,/iu;
const inlinePdf = /^data:application\/pdf;base64,/iu;
function attachment(value) {
  if (!object(value)) return null;
  const name = readText(value.name, '附件名', 160);
  const size = Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0;
  if (typeof value.fileId === 'string' && fileId.test(value.fileId)) {
    const result = { fileId: value.fileId, name, kind: value.kind === 'image' ? 'image' : 'document', size };
    if (value.kind === 'image' && typeof value.preview === 'string'
      && value.preview.startsWith('data:image/') && value.preview.length <= 200000) result.preview = value.preview;
    return result;
  }
  if (value.mode !== 'inline') return null;
  if (value.kind === 'image' && typeof value.dataUrl === 'string'
    && inlineImage.test(value.dataUrl) && value.dataUrl.length <= 1_200_000) {
    const result = { mode: 'inline', name, kind: 'image', dataUrl: value.dataUrl, size };
    if (typeof value.preview === 'string' && value.preview.startsWith('data:image/') && value.preview.length <= 200000) result.preview = value.preview;
    return result;
  }
  if (value.kind === 'document' && typeof value.dataUrl === 'string'
    && inlinePdf.test(value.dataUrl) && value.dataUrl.length <= 5_600_000)
    return { mode: 'inline', name, kind: 'document', dataUrl: value.dataUrl, size };
  if (value.kind === 'document' && typeof value.text === 'string' && value.text.length <= 120000)
    return { mode: 'inline', name, kind: 'document', text: value.text, size };
  return null;
}
function source(value) {
  if (!object(value) || typeof value.url !== 'string' || !/^https?:\/\//iu.test(value.url)) return null;
  return { url: readText(value.url, '来源地址', 2048), title: readText(value.title, '来源标题', 300),
    snippet: readText(value.snippet, '来源摘要', 1600), siteName: readText(value.siteName, '站点名称', 120),
    siteIcon: typeof value.siteIcon === 'string' && /^https?:\/\//iu.test(value.siteIcon) ? value.siteIcon.slice(0, 1024) : '',
    publishedAt: readText(value.publishedAt, '发布时间', 80) };
}
function citation(value) {
  if (!object(value) || typeof value.url !== 'string' || !/^https?:\/\//iu.test(value.url)) return null;
  const start = Number.isSafeInteger(value.startIndex) && value.startIndex >= 0 ? value.startIndex : 0;
  const end = Number.isSafeInteger(value.endIndex) && value.endIndex > start ? value.endIndex : 0;
  return end > start ? { url: value.url.slice(0, 2048), title: readText(value.title, '引用标题', 300), startIndex: start, endIndex: end } : null;
}
const avatarPattern = /^data:image\/(?:jpeg|png|webp);base64,/iu;
function avatarValue(value) {
  return typeof value === 'string' && avatarPattern.test(value) && value.length <= 200000 ? value : '';
}

function message(value, now, makeId, versions = true) {
  if (!object(value) || !['user', 'assistant'].includes(value.role)) problem('本地聊天消息格式损坏，原记录未改动。', 'LOCAL_DATA_CORRUPTED');
  const result = { id: typeof value.id === 'string' ? value.id : makeId(), role: value.role,
    content: readText(value.content, '消息正文', 200000), status: ['complete', 'generating', 'stopped', 'error'].includes(value.status) ? value.status : 'complete',
    createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : now() };
  for (const [field, maximum] of Object.entries({ reasoning: 200000, error: 1000, finishReason: 80, requestId: 128, mode: 20, model: 100, title: 120, toolStatus: 200 })) {
    if (value[field] !== undefined) result[field] = readText(value[field], field, maximum);
  }
  if (['import', 'live', 'demo'].includes(value.source)) result.source = value.source;
  if (value.refused === true) result.refused = true;
  if (versions && Array.isArray(value.attachments)) {
    const attachments = value.attachments.slice(0, 5).map(attachment).filter(Boolean);
    if (attachments.length) result.attachments = attachments;
  }
  if (versions && Array.isArray(value.sources)) {
    const sources = value.sources.slice(0, 30).map(source).filter(Boolean);
    if (sources.length) result.sources = sources;
  }
  if (versions && Array.isArray(value.citations)) {
    const citations = value.citations.slice(0, 100).map(citation).filter(Boolean);
    if (citations.length) result.citations = citations;
  }
  if (versions && Array.isArray(value.serverToolCalls)) {
    try {
      const serialized = JSON.stringify(value.serverToolCalls);
      if (serialized.length <= 180000) result.serverToolCalls = JSON.parse(serialized);
    } catch { /* Leave an oversized or broken trace out of the saved message. */ }
  }
  if (versions && Array.isArray(value.annotations)) {
    const annotations = value.annotations.slice(0, 100).map(citation).filter(Boolean);
    if (annotations.length) result.annotations = annotations;
  }
  if (versions && Array.isArray(value.previousVersions)) result.previousVersions = value.previousVersions.slice(-10).map((entry) => message(entry, now, makeId, false));
  return result;
}

export function createLocalChatStore({ vault: implementation = vault, now = () => new Date().toISOString(), makeId = () => crypto.randomUUID() } = {}) {
  const accounts = new Map();
  const flushers = new Set();
  const state = (accountId) => {
    validAccount(accountId);
    if (!accounts.has(accountId)) accounts.set(accountId, { queue: Promise.resolve(), loaded: false, index: [], cache: new Map(), warnings: [], readOnly: false });
    return accounts.get(accountId);
  };
  const call = async (method, args) => {
    try { return await implementation[method](args); }
    catch (error) {
      if (error instanceof LocalChatError) throw error;
      const code = error?.code || 'LOCAL_STORAGE_FAILED';
      const messages = { KEY_INVALIDATED: '本机加密密钥不可用，已有记录未覆盖。请使用你导出的备份恢复。',
        DECRYPT_FAILED: '本地记录无法通过完整性校验，已有文件未覆盖。请使用备份恢复。',
        PAYLOAD_TOO_LARGE: '这段本地聊天过大，请先导出并另开一段对话。' };
      throw new LocalChatError(messages[code] || '无法读写本机加密记录，请检查剩余空间后重试。', code);
    }
  };
  const clean = (input) => {
    if (!object(input) || !Array.isArray(input.messages)) problem('本地聊天文件损坏，原记录未改动。', 'LOCAL_DATA_CORRUPTED');
    return { id: validId(input.id), title: readText(input.title, '对话标题', 120, '新对话').trim() || '新对话', persona: persona(input.persona),
      avatar: avatarValue(input.avatar),
      createdAt: readText(input.createdAt, '创建时间', 80, now()), updatedAt: readText(input.updatedAt, '更新时间', 80, now()),
      messages: input.messages.map((entry) => message(entry, now, makeId)) };
  };
  const pack = (conversation) => {
    const data = JSON.stringify({ format: 'palm-local-conversation', version: 1, conversation });
    const bytes = utf8.encode(data).length;
    if (bytes > LOCAL_CHAT_LIMITS.conversationBytes) problem('单段本地聊天超过 8 MiB，请先导出并另开一段对话。', 'LOCAL_STORAGE_LIMIT');
    return { data, bytes };
  };
  const summary = (conversation, bytes) => ({ id: conversation.id, title: conversation.title, avatar: conversation.avatar || '', persona: { name: conversation.persona.name },
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messageCount: conversation.messages.length, storageBytes: bytes });
  const ordered = (entries) => [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const saveIndex = async (accountId, record) => {
    await call('set', { accountId, key: 'index', data: JSON.stringify({ format: 'palm-local-index', version: 1, conversations: record.index }) });
  };
  const readConversation = async (accountId, id, record) => {
    if (record.cache.has(id)) return clone(record.cache.get(id));
    const { data } = await call('get', { accountId, key: 'conversation:' + id });
    if (data === null) problem('这段本机聊天文件不存在，列表索引与文件不一致。', 'LOCAL_DATA_MISSING', 404);
    let parsed;
    try { parsed = JSON.parse(data); } catch { problem('这段本地聊天文件损坏，原记录未改动。', 'LOCAL_DATA_CORRUPTED'); }
    if (parsed?.format !== 'palm-local-conversation' || parsed.version !== 1) problem('本地聊天版本不受支持，原记录未改动。', 'LOCAL_DATA_VERSION');
    const conversation = clean(parsed.conversation);
    if (conversation.id !== id) problem('本地聊天编号与文件不一致，原记录未改动。', 'LOCAL_DATA_CORRUPTED');
    record.cache.set(id, conversation);
    return clone(conversation);
  };
  const load = async (accountId, record) => {
    if (record.loaded) return;
    const [{ keys }, indexFile] = await Promise.all([call('list', { accountId }), call('get', { accountId, key: 'index' })]);
    if (!Array.isArray(keys)) problem('无法读取本机会话列表。', 'LOCAL_DATA_CORRUPTED');
    const ids = [...new Set(keys.filter((key) => typeof key === 'string' && key.startsWith('conversation:')).map((key) => validId(key.slice(13))))];
    if (ids.length > LOCAL_CHAT_LIMITS.conversations) problem('本机会话数量超过 500 段，请先导出备份。', 'LOCAL_STORAGE_LIMIT');
    let parsed;
    if (indexFile.data !== null) {
      try { parsed = JSON.parse(indexFile.data); }
      catch { record.readOnly = true; }
      if (!object(parsed)) record.readOnly = true;
      if (parsed && parsed.version !== 1) problem('本地列表索引版本不受支持，原记录未改动。', 'LOCAL_DATA_VERSION');
      if (parsed && (parsed.format !== 'palm-local-index' || !Array.isArray(parsed.conversations))) record.readOnly = true;
    }
    const entries = !record.readOnly && parsed?.conversations;
    if (Array.isArray(entries) && entries.some((entry) => !object(entry) || !uuid.test(entry.id || '')
      || typeof entry.title !== 'string' || typeof entry.updatedAt !== 'string' || !Number.isFinite(entry.storageBytes)
      || entry.storageBytes < 0 || entry.storageBytes > LOCAL_CHAT_LIMITS.conversationBytes)) record.readOnly = true;
    if (Array.isArray(entries) && entries.some((entry) => object(entry) && typeof entry.id === 'string' && !ids.includes(entry.id))) {
      problem('部分本地聊天文件缺失，已有索引没有被覆盖。请使用备份恢复。', 'LOCAL_DATA_MISSING');
    }
    const matching = Array.isArray(entries) && entries.length === ids.length && entries.every((entry) => object(entry) && ids.includes(entry.id)
      && typeof entry.title === 'string' && typeof entry.updatedAt === 'string' && Number.isFinite(entry.storageBytes))
      && new Set(entries.map((entry) => entry.id)).size === ids.length && !record.readOnly;
    if (matching) record.index = entries;
    else {
      const recovered = [];
      for (const id of ids) {
        const conversation = await readConversation(accountId, id, record);
        recovered.push(summary(conversation, pack(conversation).bytes));
      }
      record.index = ordered(recovered);
      if (record.readOnly) record.warnings.push('列表索引损坏，已只读打开可恢复的会话。请先导出备份，原文件没有被覆盖。');
      else if (ids.length) {
        await saveIndex(accountId, record);
        record.warnings.push('已从本机会话文件恢复列表索引，聊天正文没有改动。');
      }
    }
    record.loaded = true;
  };
  const enqueue = (accountId, operation) => {
    const record = state(accountId);
    const result = record.queue.then(async () => { await load(accountId, record); return operation(record); });
    record.queue = result.catch(() => {});
    return result;
  };
  const writable = (record) => { if (record.readOnly) problem('本地索引损坏，当前为只读模式。请先导出备份，已有聊天未覆盖。', 'LOCAL_READ_ONLY'); };
  const persist = async (accountId, record, conversation) => {
    writable(record);
    const encoded = pack(conversation);
    const existing = record.index.find((entry) => entry.id === conversation.id);
    if (!existing && record.index.length >= LOCAL_CHAT_LIMITS.conversations) problem('本机最多保存 500 段对话，请先导出备份。', 'LOCAL_STORAGE_LIMIT');
    const total = record.index.reduce((sum, entry) => sum + entry.storageBytes, 0) - (existing?.storageBytes || 0) + encoded.bytes;
    if (total > LOCAL_CHAT_LIMITS.accountBytes) problem('本账号的本地聊天超过 64 MiB，请先导出并清理旧对话。', 'LOCAL_STORAGE_LIMIT');
    await call('set', { accountId, key: 'conversation:' + conversation.id, data: encoded.data });
    record.cache.set(conversation.id, clone(conversation));
    record.index = ordered([...record.index.filter((entry) => entry.id !== conversation.id), summary(conversation, encoded.bytes)]);
    try { await saveIndex(accountId, record); }
    catch (error) { record.loaded = false; throw new LocalChatError('聊天正文已保存在本机，但列表索引写入失败。请检查剩余空间后重试。', error.code); }
    return clone(conversation);
  };
  const store = {
    list(accountId, query = '') {
      const term = typeof query === 'string' ? query.trim() : '';
      if (!term) return enqueue(accountId, (record) => ({ conversations: clone(ordered(record.index)), warnings: [...record.warnings] }));
      return enqueue(accountId, async (record) => {
        const needle = term.toLowerCase();
        const conversations = [];
        for (const entry of ordered(record.index)) {
          const conversation = await readConversation(accountId, entry.id, record);
          const text = [conversation.title, ...conversation.messages.map((message) => message.content + '\n' + (message.reasoning || ''))].join('\n');
const index = text.toLowerCase().indexOf(needle);
          if (index < 0) continue;
          const start = Math.max(0, index - 24);
          const end = Math.min(text.length, index + term.length + 48);
          conversations.push({ ...summary(conversation, entry.storageBytes), snippet: text.slice(start, end).replace(/\s+/gu, ' ').trim() });
        }
        return { conversations, warnings: [...record.warnings] };
      });
    },
    get(accountId, id, { recoverGenerating = false } = {}) {
      id = validId(id);
      return enqueue(accountId, async (record) => {
        const conversation = await readConversation(accountId, id, record);
        if (recoverGenerating && conversation.messages.some((entry) => entry.status === 'generating')) {
          for (const entry of conversation.messages) if (entry.status === 'generating') entry.status = 'stopped';
          conversation.updatedAt = now();
          if (!record.readOnly) await persist(accountId, record, conversation);
        }
        return conversation;
      });
    },
    create(accountId, input = {}) {
      const date = now();
      const conversation = clean({ id: makeId(), title: input.title || '新对话', persona: input.persona,
        messages: [], createdAt: date, updatedAt: date });
      return enqueue(accountId, (record) => persist(accountId, record, conversation));
    },
    update(accountId, id, patch) {
      id = validId(id);
      return enqueue(accountId, async (record) => {
        const conversation = await readConversation(accountId, id, record);
        if (patch.title !== undefined) conversation.title = readText(patch.title, '对话标题', 120).trim() || '新对话';
        if (patch.persona !== undefined) conversation.persona = persona(patch.persona);
        if (patch.avatar !== undefined) conversation.avatar = avatarValue(patch.avatar);
        conversation.updatedAt = now();
        return persist(accountId, record, conversation);
      });
    },
    save(accountId, input) {
      const snapshot = clean(clone(input));
      return enqueue(accountId, async (record) => {
        if (!record.index.some((entry) => entry.id === snapshot.id)) problem('本机会话不存在。', 'NOT_FOUND', 404);
        return persist(accountId, record, snapshot);
      });
    },
    remove(accountId, id) {
      id = validId(id);
      return enqueue(accountId, async (record) => {
        writable(record);
        await readConversation(accountId, id, record);
        await call('remove', { accountId, key: 'conversation:' + id });
        record.cache.delete(id);
        record.index = record.index.filter((entry) => entry.id !== id);
        try { await saveIndex(accountId, record); } catch (error) { record.loaded = false; throw error; }
        return { ok: true };
      });
    },
    import(accountId, input) {
      const normalized = normalizeImport(input);
      const prepared = normalized.conversations.map((entry) => {
        const date = now();
        const conversation = clean({ ...entry, messages: entry.messages.map((message) => ({ ...message, source: 'import' })), id: makeId(), createdAt: date, updatedAt: date });
        return { conversation, ...pack(conversation) };
      });
      return enqueue(accountId, async (record) => {
        writable(record);
        if (record.index.length + prepared.length > LOCAL_CHAT_LIMITS.conversations
          || record.index.reduce((sum, entry) => sum + entry.storageBytes, 0) + prepared.reduce((sum, entry) => sum + entry.bytes, 0) > LOCAL_CHAT_LIMITS.accountBytes) {
          problem('导入后会超过本机 500 段会话或 64 MiB 限额，请分批导入并清理旧记录。', 'LOCAL_STORAGE_LIMIT');
        }
        const written = [];
        const previousIndex = record.index;
        try {
          for (const entry of prepared) {
            await call('set', { accountId, key: 'conversation:' + entry.conversation.id, data: entry.data });
            written.push(entry.conversation.id);
          }
          record.index = ordered([...record.index, ...prepared.map((entry) => summary(entry.conversation, entry.bytes))]);
          await saveIndex(accountId, record);
          for (const entry of prepared) record.cache.set(entry.conversation.id, clone(entry.conversation));
        } catch (error) {
          record.index = previousIndex;
          let cleanupFailed = false;
          for (const id of written) try { await call('remove', { accountId, key: 'conversation:' + id }); } catch { cleanupFailed = true; }
          record.loaded = false;
          if (cleanupFailed) problem('导入没有完成，部分新文件无法清理。原有聊天未覆盖，请检查空间后重新打开列表。', 'LOCAL_IMPORT_PARTIAL');
          throw error;
        }
        return { count: prepared.length, conversations: prepared.map((entry) => clone(entry.conversation)), warnings: normalized.warnings };
      });
    },
    registerFlusher(flusher) { flushers.add(flusher); return () => flushers.delete(flusher); },
    async flush() {
      await Promise.all([...flushers].map((flusher) => flusher()));
      await Promise.all([...accounts.values()].map((record) => record.queue));
    },
    forget(accountId) { accounts.delete(accountId); },
  };
  return store;
}

export const localChatStore = createLocalChatStore();
export const flushLocalChats = () => localChatStore.flush();
