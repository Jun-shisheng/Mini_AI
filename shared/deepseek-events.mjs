// DeepSeek "全家桶" Chat Completions 扩展字段的共享清洗与事件映射。
// 这些字段只用于一次流式请求的展示和多轮回传；服务端不把它们写入数据库。
const TOOL_TYPES = new Set(['deepseek_web_search', 'deepseek_read_url']);
const TOOL_KINDS = new Set(['search', 'deep_search', 'read_link', 'image_search', 'deep_image_search']);
const ACTION_TYPES = new Set(['search', 'open_page', 'find_in_page', 'read_link']);
const text = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum) : '';
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function sanitizeSources(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || entry.type !== 'url') return [];
    const url = text(entry.url, 2048);
    if (!/^https?:\/\//iu.test(url)) return [];
    return [{
      title: text(entry.title, 300),
      url,
      snippet: text(entry.snippet, 1600),
      siteName: text(entry.site_name, 120),
      siteIcon: /^https?:\/\//iu.test(entry.site_icon || '') ? text(entry.site_icon, 1024) : '',
      publishedAt: text(entry.published_at, 80),
    }];
  });
}

function sanitizeAction(value) {
  if (!value || typeof value !== 'object' || !ACTION_TYPES.has(value.type)) return null;
  const result = { type: value.type };
  if (value.type === 'search') {
    result.queries = Array.isArray(value.queries)
      ? [...new Set(value.queries.filter((entry) => typeof entry === 'string').map((entry) => entry.slice(0, 400)))].slice(0, 8)
      : [];
  } else {
    result.url = text(value.url, 2048);
    if (value.type === 'find_in_page') result.pattern = text(value.pattern, 400);
  }
  return result;
}

export function sanitizeCall(value) {
  if (!value || typeof value !== 'object' || !TOOL_TYPES.has(value.type)) return null;
  const action = sanitizeAction(value.action);
  if (!action) return null;
  const call = {
    index: integer(value.index),
    id: text(value.id, 128),
    type: value.type,
    kind: TOOL_KINDS.has(value.kind) ? value.kind : 'search',
    action,
  };
  if (value.status === 'completed' || value.status === 'failed') call.status = value.status;
  if (Array.isArray(value.sources)) call.sources = sanitizeSources(value.sources);
  if (value.page && typeof value.page === 'object') {
    call.page = {
      url: text(value.page.url, 2048),
      title: text(value.page.title, 300),
      publishedAt: text(value.page.published_at, 80),
    };
  }
  if (typeof value.signature === 'string' && value.signature.length <= 24000) call.signature = value.signature;
  if (value.error && typeof value.error === 'object') call.error = { code: text(value.error.code, 80) };
  return call;
}

/** Keep only the fields the next request can safely echo back to DeepSeek. */
export function sanitizeServerToolCalls(value) {
  if (!Array.isArray(value)) return [];
  const steps = value.slice(0, 30).flatMap((step) => {
    if (!step || typeof step !== 'object' || !Array.isArray(step.calls)) return [];
    const calls = step.calls.slice(0, 10).map(sanitizeCall).filter(Boolean);
    if (!calls.length) return [];
    const reasoning = typeof step.reasoning_content === 'string' ? step.reasoning_content
      : typeof step.reasoningContent === 'string' ? step.reasoningContent : '';
    return [{ index: integer(step.index), reasoning_content: text(reasoning, 4000), calls }];
  });
  let serialized = JSON.stringify(steps);
  if (serialized.length > 160000) {
    for (const step of steps) for (const call of step.calls) { delete call.sources; delete call.page; }
    serialized = JSON.stringify(steps);
  }
  while (serialized.length > 160000 && steps.length > 1) {
    steps.pop();
    serialized = JSON.stringify(steps);
  }
  return serialized.length <= 160000 ? steps : [];
}

/**
 * Chat Completions expects the original server_tool_calls shape. Display-only
 * fields are dropped; read-link signatures are preserved so the provider can
 * restore pages the model already read.
 */
export function toWireToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((step) => {
    if (!step || typeof step !== 'object' || !Array.isArray(step.calls)) return [];
    const calls = step.calls.slice(0, 10).flatMap((call) => {
      if (!call || typeof call !== 'object' || !TOOL_TYPES.has(call.type) || !call.action) return [];
      return [{
        index: integer(call.index), id: text(call.id, 128), type: call.type,
        kind: TOOL_KINDS.has(call.kind) ? call.kind : 'search', action: sanitizeAction(call.action),
        ...(call.status === 'completed' || call.status === 'failed' ? { status: call.status } : {}),
        ...(typeof call.signature === 'string' && call.signature.length <= 24000 ? { signature: call.signature } : {}),
        ...(call.error && typeof call.error === 'object' ? { error: { code: text(call.error.code, 80) } } : {}),
      }];
    });
    if (!calls.length) return [];
    const reasoning = typeof step.reasoning_content === 'string' ? step.reasoning_content
      : typeof step.reasoningContent === 'string' ? step.reasoningContent : '';
    return [{ index: integer(step.index), reasoning_content: text(reasoning, 4000), calls }];
  });
}

/** Convert Chat Completions annotations into the app's compact citation shape. */
export function sanitizeAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry) => {
    const citation = entry?.url_citation;
    if (!citation || typeof citation !== 'object') return [];
    const url = text(citation.url, 2048);
    if (!/^https?:\/\//iu.test(url)) return [];
    const start = integer(citation.start_index);
    const end = integer(citation.end_index);
    if (end <= start) return [];
    return [{ url, title: text(citation.title, 300) || url, startIndex: start, endIndex: end }];
  });
}

export function sourcesFromCalls(calls) {
  const seen = new Set();
  const sources = [];
  for (const step of calls || []) {
    for (const call of step.calls || []) {
      for (const source of call.sources || []) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        sources.push(source);
        if (sources.length >= 30) return sources;
      }
    }
  }
  return sources;
}

/** Map one upstream chunk to zero or more app-level SSE events. */
export function toolEventsFromChunk(chunk) {
  const event = chunk?.choices?.[0]?.server_tool_event;
  if (!event || typeof event !== 'object') return [];
  const step = integer(event.step);
  if (event.type === 'call_started') {
    const call = sanitizeCall(event.call);
    return call ? [{ event: 'tool', data: { phase: 'start', step, call } }] : [];
  }
  if (event.type === 'call_completed') {
    const call = sanitizeCall(event.call);
    return call ? [{ event: 'tool', data: { phase: 'done', step, call } }] : [];
  }
  return [];
}

/** Final-chunk extensions: full tool trace, citations and optional title. */
export function finalToolPayload(delta) {
  const serverToolCalls = sanitizeServerToolCalls(delta?.server_tool_calls);
  return {
    serverToolCalls,
    annotations: sanitizeAnnotations(delta?.annotations),
    sources: sourcesFromCalls(serverToolCalls),
    ...(typeof delta?.title === 'string' && delta.title.trim() ? { title: delta.title.trim().slice(0, 120) } : {}),
  };
}

/** DeepSeek's latest_reminder message: date,weekday,location,platform,language. */
export function latestReminder(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  return `${parts.year}-${parts.month}-${parts.day},${parts.weekday},,App,中文`;
}
