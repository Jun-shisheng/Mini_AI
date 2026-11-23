/**
 * Standalone text-history importer, independently implemented from documented formats.
 * DeepSeek v3 format reference (not copied source code):
 * https://github.com/deepseek-ai/chat-demo/blob/main/src/services/chat/history/README.md
 * https://github.com/deepseek-ai/chat-demo/blob/main/src/services/chat/history/format.ts
 *
 * This module never fetches a URL, reads a filesystem path, or imports credentials.
 * Only user/assistant text on the selected conversation branch is returned.
 */

export const IMPORT_LIMITS = Object.freeze({
  bytes: 20 * 1024 * 1024,
  conversations: 100,
  messages: 20_000,
  messageCharacters: 200_000,
  totalCharacters: 8_000_000,
  nodes: 200_000,
  depth: 64,
  files: 2_000,
});

export class ImportError extends Error {
  constructor(message, code = 'INVALID_IMPORT') {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code) => { throw new ImportError(message, code); };
const encoder = new TextEncoder();
const roleOf = (value) => {
  if (typeof value !== 'string') return null;
  const role = value.toLowerCase().trim();
  if (['user', 'human', '用户', '我', '人类', '你'].includes(role)) return 'user';
  if (['assistant', 'ai', 'deepseek', 'ds', '助手', '模型'].includes(role)) return 'assistant';
  return null;
};
const isMessage = (value) => record(value) && (typeof value.role === 'string' || record(value.author));

function nativePersona(value) {
  if (value === undefined || value === null) return undefined;
  if (!record(value)) fail('PalmChat备份中的角色设定格式无效。', 'INVALID_PERSONA');
  const limits = { name: 80, description: 2_000, systemPrompt: 16_000, memory: 16_000 };
  const result = {};
  for (const [key, maximum] of Object.entries(limits)) {
    const text = own(value, key) ? value[key] : '';
    if (typeof text !== 'string') fail('PalmChat备份中的角色设定必须是文字。', 'INVALID_PERSONA');
    if (text.length > maximum) fail(`PalmChat备份中的角色字段 ${key} 超过 ${maximum.toLocaleString('zh-CN')} 字符，请缩短后导入。`, 'IMPORT_LIMIT');
    result[key] = text.replace(/\u0000/gu, '').trim();
  }
  return result;
}

function validateData(value) {
  let bytes = 0;
  let nodes = 0;
  const seen = new Set();
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop();
    const current = entry.value;
    nodes += 1;
    if (nodes > IMPORT_LIMITS.nodes || entry.depth > IMPORT_LIMITS.depth) {
      fail('导入数据结构过大或层级过深，请拆分后重试。', 'IMPORT_LIMIT');
    }
    if (typeof current === 'string') {
      if (current.length > IMPORT_LIMITS.bytes) fail('导入文件超过 20 MiB，请拆分后重试。', 'IMPORT_TOO_LARGE');
      bytes += encoder.encode(current).length;
    } else if (current !== null && typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
        fail('导入内容必须是 JSON 数据或纯文本。', 'INVALID_DATA');
      }
      if (seen.has(current)) fail('导入数据包含循环或重复的对象引用，请使用原始 JSON 文件。', 'INVALID_DATA');
      seen.add(current);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (key === 'length' && Array.isArray(current)) continue;
        if (['__proto__', 'prototype', 'constructor'].includes(key) || descriptor.get || descriptor.set) {
          fail('导入数据含有不支持的特殊字段。', 'INVALID_DATA');
        }
        bytes += encoder.encode(key).length + 4;
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
    } else if (!['boolean', 'number', 'undefined'].includes(typeof current) && current !== null) {
      fail('导入内容必须是 JSON 数据或纯文本。', 'INVALID_DATA');
    }
    if (bytes > IMPORT_LIMITS.bytes) fail('导入文件超过 20 MiB，请拆分后重试。', 'IMPORT_TOO_LARGE');
  }
}

function parseTextValue(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) fail('请先选择聊天文件或粘贴聊天内容。', 'EMPTY_INPUT');
  if (/^https?:\/\/[^\s]+$/iu.test(trimmed)) {
    fail('暂不支持直接读取分享链接。请从 DeepSeek 导出 ZIP / JSON，或复制聊天正文后导入。', 'SHARE_LINK_UNSUPPORTED');
  }
  if (/^[\[{]/u.test(trimmed)) {
    try { return { value: JSON.parse(trimmed), text: false }; }
    catch { fail('JSON 格式不完整，请选择原始导出文件。', 'INVALID_JSON'); }
  }
  return { value: trimmed, text: true };
}

function contentText(value, warn) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (record(part) && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') return part.text;
      warn('附件、图片、思考过程和工具结果暂不导入，仅保留对话正文。');
      return '';
    }).filter(Boolean).join('\n');
  }
  if (record(value)) {
    if (Array.isArray(value.parts)) return contentText(value.parts, warn);
    if (typeof value.text === 'string') return value.text;
  }
  return '';
}

function fromMessage(message, warn) {
  if (!record(message)) fail('聊天记录含有无效的消息数据。', 'INVALID_MESSAGE');
  const rawRole = typeof message.role === 'string' ? message.role : message.author?.role;
  const role = roleOf(rawRole);
  if (!role) {
    warn('系统、开发者和工具消息已跳过，不会作为角色提示导入。');
    return null;
  }
  let content;
  if (Array.isArray(message.fragments)) {
    const status = typeof message.status === 'string' ? message.status.toUpperCase() : 'FINISHED';
    if (role === 'assistant' && (['FAILED', 'TIMEOUT', 'CONTENT_FILTER', 'CONTEXT_LENGTH_EXCEEDED'].includes(status)
      || message.fragments.some((part) => part?.type === 'TEMPLATE_RESPONSE'))) {
      warn('失败、被拦截或包含服务端错误模板的回复已跳过。');
      return null;
    }
    const type = role === 'user' ? 'REQUEST' : 'RESPONSE';
    content = message.fragments.map((part) => {
      if (record(part) && part.type === type && typeof part.content === 'string') return part.content;
      warn('附件、图片、思考过程和工具结果暂不导入，仅保留对话正文。');
      return '';
    }).join('');
  } else {
    content = contentText(message.content, warn);
  }
  if (content.length > IMPORT_LIMITS.messageCharacters) {
    fail('单条消息超过 200,000 字符，请拆分后导入。', 'IMPORT_LIMIT');
  }
  content = content.replace(/\u0000/gu, '').trim();
  if (!content) {
    warn('空白或没有可识别正文的消息已跳过。');
    return null;
  }
  return { role, content };
}

function branchPath(nodes, pointer, warn, numeric = false) {
  if (nodes.length > IMPORT_LIMITS.messages) fail('消息总数超过 20,000 条，请拆分导入。', 'IMPORT_LIMIT');
  const byId = new Map();
  for (const node of nodes) {
    if (node.id === null || node.id === undefined || (typeof node.id !== 'string' && typeof node.id !== 'number')
      || (numeric && (!Number.isSafeInteger(node.id) || node.id < 0))) {
      fail('消息树的消息 ID 无效。', 'INVALID_TREE');
    }
    const id = String(node.id);
    if (!id || byId.has(id)) fail('消息树含有空白或重复的消息 ID。', 'INVALID_TREE');
    if (node.parent !== null && node.parent !== undefined && typeof node.parent !== 'string' && typeof node.parent !== 'number') {
      fail('消息树的父消息 ID 无效。', 'INVALID_TREE');
    }
    byId.set(id, { ...node, id, parent: node.parent === null || node.parent === undefined ? null : String(node.parent) });
  }
  const parents = new Set();
  for (const node of byId.values()) {
    if (node.parent !== null) {
      if (!byId.has(node.parent) || (numeric && Number(node.parent) >= Number(node.id))) {
        fail('消息树存在缺失或不合法的父消息，请重新导出完整记录。', 'INVALID_TREE');
      }
      parents.add(node.parent);
    }
  }
  const finished = new Set();
  for (const node of byId.values()) {
    if (finished.has(node.id)) continue;
    const visited = new Set();
    let cursor = node;
    while (cursor && !finished.has(cursor.id)) {
      if (visited.has(cursor.id)) fail('消息树含有循环引用，无法安全还原对话。', 'INVALID_TREE');
      visited.add(cursor.id);
      cursor = cursor.parent === null ? null : byId.get(cursor.parent);
    }
    for (const id of visited) finished.add(id);
  }
  if (byId.size === 0) return [];
  let selected = pointer;
  if (selected === null || selected === undefined || selected === '') {
    const leaves = [...byId.keys()].filter((id) => !parents.has(id));
    if (leaves.length !== 1) fail('记录包含多个分支但没有当前分支标记，无法确定应继续哪段对话。', 'AMBIGUOUS_BRANCH');
    selected = leaves[0];
    warn('记录未提供当前分支标记，已导入唯一的完整消息链。');
  }
  let current = byId.get(String(selected));
  if (!current) fail('当前分支标记指向不存在的消息，请重新导出完整记录。', 'INVALID_TREE');
  const path = [];
  while (current) {
    path.push(current.message);
    current = current.parent === null ? null : byId.get(current.parent);
  }
  if (path.length < byId.size) warn('仅导入会话的当前消息分支，其他分支未导入。');
  return path.reverse();
}

function extractMessages(value, warn, strictDeepSeek = false) {
  if (record(value.mapping)) {
    const nodes = Object.entries(value.mapping).map(([key, node]) => {
      if (!record(node)) fail('消息树格式无效。', 'INVALID_TREE');
      if (node.id !== undefined && String(node.id) !== key) fail('消息树键名与消息 ID 不一致。', 'INVALID_TREE');
      return { id: key, parent: node.parent, message: node.message ?? null };
    });
    return branchPath(nodes, value.current_node ?? value.current_message_id, warn).filter(Boolean);
  }
  if (!Array.isArray(value.messages)) fail('没有找到支持的聊天消息列表。', 'UNSUPPORTED_FORMAT');
  if (value.messages.length > IMPORT_LIMITS.messages) fail('消息总数超过 20,000 条，请拆分导入。', 'IMPORT_LIMIT');
  const tree = strictDeepSeek || own(value, 'current_message_id') || value.messages.some((message) => record(message) && own(message, 'parent_id'));
  if (!tree) return value.messages;
  if (strictDeepSeek && !own(value, 'current_message_id')) fail('DeepSeek 记录缺少当前分支标记。', 'INVALID_TREE');
  const nodes = value.messages.map((message) => {
    if (!record(message)) fail('消息树格式无效。', 'INVALID_TREE');
    return { id: message.id, parent: message.parent_id, message };
  });
  return branchPath(nodes, value.current_message_id, warn, true);
}

function parseTranscript(value, warn) {
  const lines = value.split(/\r?\n/u);
  const messages = [];
  let role = null;
  let buffer = [];
  let fence = null;
  let found = false;
  const labels = '用户|我|人类|你|user|human|助手|模型|assistant|ai|deepseek|ds';
  const colon = new RegExp(`^\\s*(?:#{1,6}\\s+)?(?:\\*\\*)?(${labels})(?:\\*\\*)?\\s*[：:](?:\\*\\*)?[ \\t]*(.*)$`, 'iu');
  const heading = new RegExp(`^\\s*(?:#{1,6}\\s+|\\*\\*)(${labels})(?:\\*\\*)?\\s*$`, 'iu');
  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) messages.push({ role: role ?? 'user', content });
    buffer = [];
  };
  for (const line of lines) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (delimiter) {
      if (fence === null) fence = { char: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    const marker = fence === null ? colon.exec(line) ?? heading.exec(line) : null;
    if (marker) {
      if (!found && buffer.some((part) => part.trim())) warn('角色标记前的文字已作为一条用户消息保留。');
      flush();
      role = roleOf(marker[1]);
      buffer.push(marker[2] ?? '');
      found = true;
    } else buffer.push(line);
  }
  flush();
  if (!found) warn('未识别到用户 / 助手角色标记，全文已作为一条用户消息导入。');
  return { messages };
}

function archiveEntries(input, warn) {
  if (input.length > IMPORT_LIMITS.files) fail('归档文件过多，请拆分后导入。', 'IMPORT_LIMIT');
  const files = new Map();
  for (const file of input) {
    const path = file.filename.normalize('NFC');
    if (path.length > 512 || path.includes('\\') || /^(?:\/|[A-Za-z]:)/u.test(path)
      || path.includes('\u0000') || path.split('/').some((part) => part === '.' || part === '..') || files.has(path)) {
      fail('归档中含有不安全或重复的文件路径。', 'INVALID_ARCHIVE');
    }
    files.set(path, file.data);
  }
  const manifests = [...files.keys()].filter((path) => /(?:^|\/)manifest\.json$/u.test(path));
  if (manifests.length > 1) fail('归档包含多个格式清单，无法确定文件结构。', 'INVALID_ARCHIVE');
  if (manifests.length === 1) {
    const manifestPath = manifests[0];
    const manifest = files.get(manifestPath);
    if (!record(manifest) || manifest.export_format_version !== 3) {
      fail('当前仅支持 DeepSeek 第 3 版历史归档，请重新导出。', 'UNSUPPORTED_VERSION');
    }
    const prefix = manifestPath.slice(0, -'manifest.json'.length);
    const index = files.get(prefix + 'chat_session_index.json');
    if (!Array.isArray(index)) fail('DeepSeek 归档缺少有效的会话索引，请重新导出。', 'INVALID_ARCHIVE');
    const sessions = [...files.entries()].filter(([path]) => path.startsWith(prefix + 'chat_sessions/') && /^[^/]+\.json$/u.test(path.slice((prefix + 'chat_sessions/').length)));
    const byId = new Map();
    for (const [path, session] of sessions) {
      if (!record(session) || typeof session.id !== 'string' || !session.id || /[/\\]/u.test(session.id)
        || path !== prefix + 'chat_sessions/' + session.id + '.json' || byId.has(session.id)) {
        fail('DeepSeek 会话文件名与会话 ID 不一致。', 'INVALID_ARCHIVE');
      }
      byId.set(session.id, session);
    }
    const ids = new Set();
    const result = index.map((item) => {
      if (!record(item) || typeof item.id !== 'string' || ids.has(item.id) || !byId.has(item.id)) {
        fail('DeepSeek 会话索引与文件不一致，请重新导出完整归档。', 'INVALID_ARCHIVE');
      }
      ids.add(item.id);
      const session = byId.get(item.id);
      if (!Array.isArray(session.messages) || (item.message_count !== undefined && item.message_count !== session.messages.length)) {
        fail('DeepSeek 会话消息数量与索引不一致。', 'INVALID_ARCHIVE');
      }
      return { value: session, strictDeepSeek: true, title: typeof item.title === 'string' ? item.title : undefined };
    });
    if (ids.size !== byId.size) fail('DeepSeek 归档包含没有索引的会话。', 'INVALID_ARCHIVE');
    return result;
  }
  warn('未发现 DeepSeek 格式清单，已按通用 JSON 聊天记录解析。');
  const result = [];
  for (const [path, data] of files) {
    if (!/\.json$/iu.test(path) || /(?:^|\/)(?:user|manifest|chat_session_index)\.json$/u.test(path)) continue;
    result.push(...collectConversations(data, warn));
  }
  return result;
}

function collectConversations(input, warn, depth = 0) {
  if (depth > 8) fail('聊天文件容器层级过深。', 'UNSUPPORTED_FORMAT');
  if (Array.isArray(input)) {
    if (input.length > IMPORT_LIMITS.messages) fail('导入记录过多，请拆分后重试。', 'IMPORT_LIMIT');
    if (input.length && input.every((entry) => record(entry) && typeof entry.filename === 'string' && own(entry, 'data'))) {
      return archiveEntries(input, warn);
    }
    if (input.length && input.every(isMessage)) return [{ value: { messages: input }, strictDeepSeek: false }];
    return input.flatMap((value) => collectConversations(value, warn, depth + 1));
  }
  if (!record(input)) fail('没有识别到支持的聊天记录格式。', 'UNSUPPORTED_FORMAT');
  if (depth === 0 && input.format === 'palm-history') {
    if (input.version !== 1) fail('当前仅支持PalmChat第 1 版备份，请使用兼容版本导出。', 'UNSUPPORTED_VERSION');
    if (!Array.isArray(input.conversations) || input.conversations.some((conversation) => !record(conversation) || !Array.isArray(conversation.messages))) {
      fail('PalmChat备份缺少有效的对话列表。', 'UNSUPPORTED_FORMAT');
    }
    return input.conversations.map((value) => ({ value, strictDeepSeek: false, restorePersona: true }));
  }
  if (Array.isArray(input.messages) || record(input.mapping)) return [{ value: input, strictDeepSeek: false }];
  for (const key of ['conversations', 'chat_sessions', 'sessions', 'chats']) {
    if (Array.isArray(input[key])) return collectConversations(input[key], warn, depth + 1);
  }
  if (Array.isArray(input.files)) return archiveEntries(input.files, warn);
  fail('没有识别到聊天消息。支持 DeepSeek 导出文件、ChatGPT JSON 或带角色标记的文本。', 'UNSUPPORTED_FORMAT');
}

/**
 * @param {unknown} input JSON data, raw JSON/transcript text, or {filename,data}[] from an unpacked ZIP.
 * @returns {{conversations: Array<{title:string,messages:Array<{role:'user'|'assistant',content:string}>,persona?:{name:string,description:string,systemPrompt:string,memory:string}}>, warnings:string[]}}
 * @throws {ImportError} No source records are modified on failure.
 */
export function normalizeImport(input) {
  if (input === null || input === undefined || input === '') fail('请先选择聊天文件或粘贴聊天内容。', 'EMPTY_INPUT');
  validateData(input);
  const warnings = new Set();
  const warn = (message) => warnings.add(message);
  let source = input;
  let transcript = false;
  if (typeof source === 'string') {
    const parsed = parseTextValue(source);
    source = parsed.value;
    transcript = parsed.text;
    if (!transcript) validateData(source);
  }
  const candidates = transcript ? [{ value: parseTranscript(source, warn), strictDeepSeek: false }] : collectConversations(source, warn);
  if (candidates.length > IMPORT_LIMITS.conversations) fail('每次最多导入 100 个会话，请分批导入。', 'IMPORT_LIMIT');
  const conversations = [];
  let messageCount = 0;
  let totalCharacters = 0;
  for (const candidate of candidates) {
    const raw = extractMessages(candidate.value, warn, candidate.strictDeepSeek);
    messageCount += raw.length;
    if (messageCount > IMPORT_LIMITS.messages) fail('消息总数超过 20,000 条，请拆分导入。', 'IMPORT_LIMIT');
    const messages = raw.map((message) => fromMessage(message, warn)).filter(Boolean);
    if (!messages.length) { warn('没有有效正文的空会话已跳过。'); continue; }
    for (const message of messages) totalCharacters += message.content.length;
    if (totalCharacters > IMPORT_LIMITS.totalCharacters) fail('导入正文超过 8,000,000 字符，请分批导入。', 'IMPORT_LIMIT');
    const title = [candidate.value.title, candidate.value.name, candidate.title].find((value) => typeof value === 'string' && value.trim())
      ?? messages.find((message) => message.role === 'user')?.content ?? messages[0].content;
    const persona = candidate.restorePersona ? nativePersona(candidate.value.persona) : undefined;
    conversations.push({ title: title.replace(/\u0000/gu, '').trim().slice(0, 80), messages, ...(persona ? { persona } : {}) });
  }
  if (!conversations.length) fail('文件中没有可导入的用户或助手对话正文。', 'NO_MESSAGES');
  return { conversations, warnings: [...warnings] };
}
