import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeContext } from '../src/api.js';
import { chatProvider } from '../server/provider.mjs';
import { finalToolPayload, latestReminder, toWireToolCalls, toolEventsFromChunk } from '../shared/deepseek-events.mjs';


test('DeepSeek provider declares search, link reading, safety and title only for the official channel', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response('data: [DONE]\n\n');
  };
  const provider = chatProvider({ provider: 'deepseek', apiKey: 'fixture-key' });
  await provider.generate(fetchImpl, [{ role: 'user', content: '你好' }], 'user-1',
    { thinking: true, webSearch: true, readUrl: true, title: true }, 100, new AbortController().signal);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(calls[0].body.tools, [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }]);
  assert.equal(calls[0].body.safety_check.level, 'high');
  assert.equal(calls[0].body.title.enabled, true);
  assert.equal(calls[0].body.thinking.type, 'enabled');

  const free = chatProvider({ provider: 'openrouter', apiKey: 'fixture-key' });
  await free.generate(async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('data: [DONE]\n\n'); },
    [{ role: 'user', content: '你好' }], 'user-1', { thinking: false, webSearch: true, readUrl: true, title: true }, 100, new AbortController().signal);
  assert.equal(calls[1].body.tools, undefined);
  assert.equal(calls[1].body.title, undefined);
});

test('tool events, citations and titles round-trip in the documented shape', () => {
  const started = toolEventsFromChunk({ choices: [{ server_tool_event: {
    type: 'call_started', step: 0,
    call: { index: 0, id: 'srvtoolu_s_00_x', type: 'deepseek_web_search', kind: 'search', action: { type: 'search', queries: ['天气'] } },
  } }] });
  assert.equal(started.length, 1);
  assert.equal(started[0].event, 'tool');
  assert.equal(started[0].data.phase, 'start');
  assert.deepEqual(started[0].data.call.action.queries, ['天气']);

  const final = finalToolPayload({
    server_tool_calls: [{ index: 0, reasoning_content: '想一下', calls: [{
      index: 0, id: 'srvtoolu_rl_00_y', type: 'deepseek_read_url', kind: 'read_link',
      action: { type: 'read_link', url: 'https://example.com/a' }, status: 'completed',
      page: { url: 'https://example.com/a', title: 'A', published_at: '2026-01-01' },
      signature: 'encrypted-page', sources: undefined,
    }] }],
    annotations: [{ type: 'url_citation', url_citation: {
      url: 'https://example.com/a', title: 'A', start_index: 0, end_index: 3,
    } }],
    title: '会话标题',
  });
  assert.equal(final.title, '会话标题');
  assert.equal(final.annotations[0].url, 'https://example.com/a');
  assert.equal(final.serverToolCalls[0].reasoning_content, '想一下');
  const wire = toWireToolCalls(final.serverToolCalls);
  assert.equal(wire[0].calls[0].signature, 'encrypted-page');
  assert.equal(wire[0].calls[0].page, undefined);
  assert.match(latestReminder(new Date('2026-11-19T04:00:00Z')), /^2026-11-19,星期.*,,App,中文$/u);
});

test('native context keeps file ids and tool traces but never uploads local image previews', () => {
  const conversation = {
    id: '33333333-3333-4333-8333-333333333333',
    title: '新对话',
    messages: [
      { role: 'user', content: '这张图里有什么', attachments: [{
        fileId: 'file-api-12345678', name: 'cat.png', kind: 'image',
        preview: 'data:image/jpeg;base64,AAAA',
      }] },
      { role: 'assistant', content: '一只猫', serverToolCalls: [{
        index: 0, reasoning_content: '', calls: [{
          index: 0, id: 'srvtoolu_rl_00_a', type: 'deepseek_read_url', kind: 'read_link',
          action: { type: 'read_link', url: 'https://example.com/cat' }, status: 'completed', signature: 'page',
        }],
      }] },
      { role: 'user', content: '谢谢' },
    ],
  };
  const context = buildNativeContext(conversation, { requestId: 'request-context', webSearch: true });
  assert.equal(context.payload.title, true);
  assert.equal(context.payload.webSearch, true);
  assert.deepEqual(context.payload.messages[0].attachments, [
    { fileId: 'file-api-12345678', name: 'cat.png', kind: 'image' },
  ]);
  assert.equal(context.payload.messages[1].serverToolCalls[0].calls[0].signature, 'page');
  assert.doesNotMatch(JSON.stringify(context.payload), /data:image|base64/);
});
