import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readHistoryFile } from '../src/importFiles.js';

const json = (value) => strToU8(JSON.stringify(value));
const ordinary = (title = '旧故事') => ({ title, messages: [{ role: 'user', content: '你还记得我们的约定吗？' }, { role: 'assistant', content: '记得，周末一起看海。' }] });
const asZipFile = (entries) => new File([zipSync(entries)], 'deepseek-history.zip', { type: 'application/zip' });

test('File wrapper imports a DeepSeek v3 ZIP and warns that image attachments were excluded', async () => {
  const session = { id: 'old-story', title: '海边的约定', current_message_id: 2, messages: [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', fragments: [{ type: 'REQUEST', content: '周末去看海吗？' }] },
    { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: '好，我记着呢。' }] },
  ] };
  const file = asZipFile({
    'manifest.json': json({ export_format_version: 3 }),
    'chat_sessions/old-story.json': json(session),
    'chat_session_index.json': json([{ id: 'old-story', title: '海边的约定', message_count: 2 }]),
    'chat_sessions/old-story_files/photo.png': new Uint8Array([137, 80, 78, 71]),
  });
  const result = await readHistoryFile(file);
  assert.deepEqual(result.conversations[0], { title: '海边的约定', messages: [
    { role: 'user', content: '周末去看海吗？' },
    { role: 'assistant', content: '好，我记着呢。' },
  ] });
  assert(result.warnings.some((warning) => warning.includes('图片和其他附件未导入')));
});

test('duplicate ZIP paths are rejected before the decompressor silently overwrites an earlier entry', async () => {
  const bytes = zipSync({ 'a.json': json(ordinary('第一份')), 'b.json': json(ordinary('第二份')) });
  const needle = strToU8('b.json');
  let replacements = 0;
  for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    if (needle.every((value, offset) => bytes[index + offset] === value)) {
      bytes[index] = 'a'.charCodeAt(0);
      replacements += 1;
    }
  }
  assert.equal(replacements, 2, 'both local and central file names were intentionally changed');
  await assert.rejects(() => readHistoryFile(new File([bytes], 'duplicate.zip')), /重复的文件路径/u);
});

test('ZIP paths reject traversal and Unicode-equivalent duplicates', async () => {
  await assert.rejects(() => readHistoryFile(asZipFile({ '../history.json': json(ordinary()) })), /不安全的文件路径/u);
  await assert.rejects(() => readHistoryFile(asZipFile({
    '\u00e9.json': json(ordinary('第一份')),
    'e\u0301.json': json(ordinary('第二份')),
  })), /重复的文件路径/u);
});

test('a small ZIP whose JSON expands beyond 20 MiB is rejected before parsing', async () => {
  const expanded = new Uint8Array(20 * 1024 * 1024 + 1);
  expanded.fill(32);
  const file = asZipFile({ 'huge.json': expanded });
  assert(file.size < 100_000, 'the compressed upload is small enough to bypass the upload-size bound');
  await assert.rejects(() => readHistoryFile(file), /压缩包中的聊天记录过大/u);
});

test('expanded size is cumulative across JSON ZIP entries', async () => {
  const part = new Uint8Array(11 * 1024 * 1024);
  part.fill(32);
  await assert.rejects(() => readHistoryFile(asZipFile({ 'one.json': part, 'two.json': part })), /压缩包中的聊天记录过大/u);
});

test('ordinary JSON File imports text and invalid JSON reports an actionable error', async () => {
  const file = new File([JSON.stringify(ordinary())], 'history.json', { type: 'application/json' });
  const result = await readHistoryFile(file);
  assert.equal(result.conversations[0].title, '旧故事');
  assert.equal(result.conversations[0].messages[1].content, '记得，周末一起看海。');
  await assert.rejects(() => readHistoryFile(new File(['{"messages": ['], 'broken.json')), /JSON 格式不完整/u);
  await assert.rejects(() => readHistoryFile(asZipFile({ 'broken.json': strToU8('{"messages": [') })), /无法解析的 JSON：broken\.json/u);
});

test('unsupported files and ZIPs with no JSON dialogue fail without creating an empty preview', async () => {
  await assert.rejects(() => readHistoryFile(null), /请选择聊天记录文件/u);
  await assert.rejects(() => readHistoryFile(new File(['no'], 'history.pdf')), /支持 ZIP、JSON、TXT 或 Markdown 文件/u);
  await assert.rejects(() => readHistoryFile(asZipFile({ 'photo.png': new Uint8Array([1, 2, 3]) })), /没有可导入的聊天记录/u);
});
