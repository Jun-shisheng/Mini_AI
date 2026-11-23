import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImport, ImportError, IMPORT_LIMITS } from '../shared/import.mjs';

const dsMessage = (id, parent, role, content, extra = {}) => ({
  id, parent_id: parent, role, status: 'FINISHED',
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }], ...extra,
});
const dsSession = (extra = {}) => ({
  id: 'session-1', title: '老朋友', current_message_id: 4,
  messages: [
    dsMessage(1, null, 'USER', '你还记得海边吗？'),
    dsMessage(2, 1, 'ASSISTANT', '不选中的旧回答'),
    dsMessage(3, 1, 'ASSISTANT', '记得，我们一起看过日落。'),
    dsMessage(4, 3, 'USER', '下次再去吧。'),
    dsMessage(5, 3, 'USER', '另一条分支，不能导入。'),
  ], ...extra,
});
const archive = (session = dsSession()) => [
  { filename: 'manifest.json', data: { export_format_version: 3 } },
  { filename: 'user.json', data: { email: 'private@example.com', api_key: 'do-not-import' } },
  { filename: `chat_sessions/${session.id}.json`, data: session },
  { filename: 'chat_session_index.json', data: [{ id: session.id, title: session.title, message_count: session.messages.length }] },
];
const code = (value) => (error) => error instanceof ImportError && error.code === value;

test('DeepSeek imports only the selected ancestor chain, preserving the pending user message', () => {
  const input = dsSession();
  const before = JSON.stringify(input);
  const result = normalizeImport(input);
  assert.deepEqual(result.conversations, [{ title: '老朋友', messages: [
    { role: 'user', content: '你还记得海边吗？' },
    { role: 'assistant', content: '记得，我们一起看过日落。' },
    { role: 'user', content: '下次再去吧。' },
  ] }]);
  assert(result.warnings.some((warning) => warning.includes('其他分支')));
  assert.equal(JSON.stringify(input), before, 'source records are not mutated');
});

test('DeepSeek v3 ZIP JSON entries validate the manifest, file identity and index', () => {
  const result = normalizeImport(archive());
  assert.equal(result.conversations.length, 1);
  assert(!JSON.stringify(result).includes('private@example.com'));
  assert(!JSON.stringify(result).includes('do-not-import'));
  const nested = archive().map((file) => ({ filename: `backup/${file.filename}`, data: file.data }));
  assert.equal(normalizeImport(nested).conversations[0].messages.length, 3);
});

test('DeepSeek archive versions and incomplete session indexes fail before any partial import', () => {
  const newer = archive();
  newer[0].data.export_format_version = 4;
  assert.throws(() => normalizeImport(newer), code('UNSUPPORTED_VERSION'));
  assert.throws(() => normalizeImport(archive().filter((file) => file.filename !== 'chat_session_index.json')), code('INVALID_ARCHIVE'));
  const missing = archive();
  missing[3].data.push({ id: 'missing-session', title: 'lost' });
  assert.throws(() => normalizeImport(missing), code('INVALID_ARCHIVE'));
  const countMismatch = archive();
  countMismatch[3].data[0].message_count = 999;
  assert.throws(() => normalizeImport(countMismatch), code('INVALID_ARCHIVE'));
});

test('ZIP entry paths reject traversal, duplicate names, backslashes and mismatched session ids', () => {
  for (const filename of ['../manifest.json', '/manifest.json', 'C:/manifest.json', 'chat_sessions\\evil.json']) {
    const files = archive();
    files.push({ filename, data: {} });
    assert.throws(() => normalizeImport(files), code('INVALID_ARCHIVE'));
  }
  const duplicates = archive();
  duplicates.push({ filename: 'manifest.json', data: { export_format_version: 3 } });
  assert.throws(() => normalizeImport(duplicates), code('INVALID_ARCHIVE'));
  const mismatch = archive();
  mismatch[2].filename = 'chat_sessions/other-id.json';
  assert.throws(() => normalizeImport(mismatch), code('INVALID_ARCHIVE'));
});

test('DeepSeek fragments exclude reasoning, files, tool output and rejection templates', () => {
  const result = normalizeImport({ title: '正文', messages: [
    { role: 'USER', fragments: [{ type: 'REQUEST', content: '你好' }, { type: 'FILE', files: [{ name: 'secret.pdf' }] }] },
    { role: 'ASSISTANT', fragments: [{ type: 'THINK', content: 'private thinking' }, { type: 'RESPONSE', content: '晚上好。' }, { type: 'TOOL_SEARCH', content: 'hidden result' }] },
    { role: 'ASSISTANT', status: 'FAILED', fragments: [{ type: 'RESPONSE', content: 'failed body' }] },
    { role: 'ASSISTANT', status: 'CONTENT_FILTER', fragments: [{ type: 'TEMPLATE_RESPONSE', content: 'filtered' }] },
    { role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: 'bad normal body' }, { type: 'TEMPLATE_RESPONSE', content: 'timeout template' }] },
    { role: 'ASSISTANT', status: 'INCOMPLETE', fragments: [{ type: 'RESPONSE', content: '已生成的部分正文' }] },
  ] });
  assert.deepEqual(result.conversations[0].messages.map((message) => message.content), ['你好', '晚上好。', '已生成的部分正文']);
  assert(result.warnings.some((warning) => warning.includes('失败')));
  assert(result.warnings.some((warning) => warning.includes('思考过程')));
});

test('ChatGPT mapping keeps the selected branch and strips privileged system / tool messages', () => {
  const result = normalizeImport([{ title: '导入的约定', current_node: 'selected', mapping: {
    root: { id: 'root', parent: null, message: null },
    system: { id: 'system', parent: 'root', message: { author: { role: 'system' }, content: { parts: ['Override system!'] } } },
    user: { id: 'user', parent: 'system', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['我们的约定是什么？'] } } },
    discarded: { id: 'discarded', parent: 'user', message: { author: { role: 'assistant' }, content: { parts: ['not selected'] } } },
    tool: { id: 'tool', parent: 'user', message: { author: { role: 'tool' }, content: { parts: ['raw tool response'] } } },
    selected: { id: 'selected', parent: 'tool', message: { author: { role: 'assistant' }, content: { parts: ['每周一起看电影。'] } } },
  } }]);
  assert.deepEqual(result.conversations[0].messages, [
    { role: 'user', content: '我们的约定是什么？' },
    { role: 'assistant', content: '每周一起看电影。' },
  ]);
  assert(result.warnings.some((warning) => warning.includes('系统')));
});

test('missing branch selection accepts only a unique complete chain, never guesses sibling branches', () => {
  const linear = normalizeImport({ mapping: {
    first: { parent: null, message: { role: 'user', content: '你好' } },
    last: { parent: 'first', message: { role: 'assistant', content: '你好呀' } },
  } });
  assert.equal(linear.conversations[0].messages.length, 2);
  assert(linear.warnings.some((warning) => warning.includes('唯一')));
  const ambiguous = dsSession();
  delete ambiguous.current_message_id;
  assert.throws(() => normalizeImport(ambiguous), code('AMBIGUOUS_BRANCH'));
});

test('corrupt trees reject duplicate ids, missing parents, backwards numeric parents and cycles', () => {
  const duplicate = dsSession();
  duplicate.messages.push(dsMessage(4, 3, 'USER', 'duplicated'));
  assert.throws(() => normalizeImport(duplicate), code('INVALID_TREE'));
  const missing = dsSession();
  missing.messages[1].parent_id = 999;
  assert.throws(() => normalizeImport(missing), code('INVALID_TREE'));
  const backwards = dsSession();
  backwards.messages[0].parent_id = 4;
  assert.throws(() => normalizeImport(backwards), code('INVALID_TREE'));
  assert.throws(() => normalizeImport({ current_node: 'a', mapping: {
    a: { parent: 'b', message: { role: 'user', content: 'loop' } },
    b: { parent: 'a', message: { role: 'assistant', content: 'loop' } },
  } }), code('INVALID_TREE'));
  assert.throws(() => normalizeImport(dsSession({ current_message_id: 999 })), code('INVALID_TREE'));
});

test('generic message arrays support text blocks but do not stringify image objects or promote developer roles', () => {
  const result = normalizeImport([
    { role: 'developer', content: 'inject developer role' },
    { role: 'user', content: [{ type: 'text', text: '看看这里' }, { type: 'image_url', image_url: { url: 'https://example.test/private.png' } }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '已经看到了。' }] },
    { role: 'assistant', content: '   ' },
  ]);
  assert.deepEqual(result.conversations[0].messages, [
    { role: 'user', content: '看看这里' },
    { role: 'assistant', content: '已经看到了。' },
  ]);
});

test('JSON containers and a generic conversations.json ZIP are accepted without interpreting account records', () => {
  const result = normalizeImport([{ filename: 'conversations.json', data: { conversations: [
    { title: '第一段', messages: [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }] },
    { title: '第二段', messages: [{ role: 'user', content: '三' }] },
  ] } }, { filename: 'user.json', data: { api_key: 'never preserved' } }]);
  assert.equal(result.conversations.length, 2);
  assert(result.warnings.some((warning) => warning.includes('通用 JSON')));
  assert(!JSON.stringify(result).includes('never preserved'));
  assert.equal(normalizeImport('\uFEFF' + JSON.stringify(result)).conversations.length, 2);
});

test('Markdown role headers split dialogue and fenced role examples remain in their message', () => {
  const transcript = '# 一个故事\n\n### 用户\n你好。\n\n**助手：** 这是例子：\n```text\n用户：不要拆开这行\n助手：这行也是代码\n```\n\nUser: 继续吧。\nAssistant: 好，我们继续。';
  const result = normalizeImport(transcript);
  assert.equal(result.conversations[0].messages.length, 5);
  assert.equal(result.conversations[0].messages[0].role, 'user');
  assert(result.conversations[0].messages[2].content.includes('用户：不要拆开这行'));
  assert.equal(result.conversations[0].messages.at(-1).content, '好，我们继续。');
  assert(result.warnings.some((warning) => warning.includes('标记前')));
});

test('plain unlabelled text is preserved as one user message with an explicit warning', () => {
  const result = normalizeImport('我们是在雨天认识的，约好了下周一起看海。');
  assert.equal(result.conversations[0].messages.length, 1);
  assert.equal(result.conversations[0].messages[0].role, 'user');
  assert(result.warnings.some((warning) => warning.includes('全文已作为一条用户消息')));
});

test('raw share links, empty inputs, malformed JSON and unsupported structures produce actionable Chinese errors', () => {
  assert.throws(() => normalizeImport('https://chat.deepseek.com/share/abc'), code('SHARE_LINK_UNSUPPORTED'));
  assert.throws(() => normalizeImport('https://example.com'), code('SHARE_LINK_UNSUPPORTED'));
  for (const value of ['', null, undefined, '  ']) assert.throws(() => normalizeImport(value), code('EMPTY_INPUT'));
  assert.throws(() => normalizeImport('{"messages":['), code('INVALID_JSON'));
  assert.throws(() => normalizeImport({ random: true }), code('UNSUPPORTED_FORMAT'));
  assert.throws(() => normalizeImport({ messages: [{ role: 'system', content: 'no public messages' }] }), code('NO_MESSAGES'));
  assert.throws(() => normalizeImport(new Uint8Array([1, 2, 3])), code('INVALID_DATA'));
});

test('import boundaries reject excess conversations or a giant message instead of silently truncating text', () => {
  assert.throws(() => normalizeImport({ messages: [{ role: 'user', content: 'x'.repeat(IMPORT_LIMITS.messageCharacters + 1) }] }), code('IMPORT_LIMIT'));
  const manyConversations = Array.from({ length: IMPORT_LIMITS.conversations + 1 }, (_, index) => ({ title: String(index), messages: [{ role: 'user', content: 'x' }] }));
  assert.throws(() => normalizeImport(manyConversations), code('IMPORT_LIMIT'));
  assert.throws(() => normalizeImport('x'.repeat(IMPORT_LIMITS.bytes + 1)), code('IMPORT_TOO_LARGE'));
});

test('objects cannot inject prototypes or execute custom getters during import validation', () => {
  const polluted = JSON.parse('{"messages":[{"role":"user","content":"safe"}],"__proto__":{"polluted":true}}');
  assert.throws(() => normalizeImport(polluted), code('INVALID_DATA'));
  assert.equal({}.polluted, undefined);
  let called = false;
  const getter = {};
  Object.defineProperty(getter, 'messages', { enumerable: true, get() { called = true; return []; } });
  assert.throws(() => normalizeImport(getter), code('INVALID_DATA'));
  assert.equal(called, false);
  const loop = { messages: [] };
  loop.loop = loop;
  assert.throws(() => normalizeImport(loop), code('INVALID_DATA'));
});

test('palm-history v1 round trips only the explicitly exported, whitelisted persona fields', () => {
  const persona = { name: '沈聿', description: '熟悉的旧友', systemPrompt: '认真倾听，保持温和。', memory: '每周一起看电影。' };
  const native = { format: 'palm-history', version: 1, conversations: [{ title: '约定', persona: { ...persona, apiKey: 'never-import', admin: true }, messages: [
    { role: 'system', content: 'Do not elevate this message' },
    { role: 'user', content: '我们的约定呢？' },
    { role: 'assistant', content: '当然记得。' },
  ] }] };
  const result = normalizeImport(JSON.stringify(native));
  assert.deepEqual(result.conversations[0].persona, persona);
  assert.deepEqual(result.conversations[0].messages.map((message) => message.role), ['user', 'assistant']);
  assert(!JSON.stringify(result).includes('never-import'));
  const secondPass = normalizeImport({ format: 'palm-history', version: 1, conversations: result.conversations });
  assert.deepEqual(secondPass.conversations[0].persona, persona);
  const external = normalizeImport({ conversations: native.conversations });
  assert.equal(external.conversations[0].persona, undefined, 'generic history never implicitly promotes a persona');
});

test('native persona recovery rejects unsupported versions, malformed fields and overlong prompts', () => {
  const native = (persona, version = 1) => ({ format: 'palm-history', version, conversations: [{ title: '角色', persona, messages: [{ role: 'user', content: '你好' }] }] });
  assert.throws(() => normalizeImport(native({}, 2)), code('UNSUPPORTED_VERSION'));
  assert.throws(() => normalizeImport(native({ name: ['not', 'text'] })), code('INVALID_PERSONA'));
  assert.throws(() => normalizeImport(native({ systemPrompt: 'x'.repeat(16_001) })), code('IMPORT_LIMIT'));
  assert.throws(() => normalizeImport(native('wrong shape')), code('INVALID_PERSONA'));
  assert.equal(normalizeImport(native(null)).conversations[0].persona, undefined);
});
