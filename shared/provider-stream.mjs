export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data.trim() === '[DONE]') return;
      try { yield JSON.parse(data); } catch { throw new Error('UPSTREAM_STREAM_INVALID'); }
    }
    if (buffer.length > 1024 * 1024) throw new Error('UPSTREAM_STREAM_INVALID');
  }
  buffer += decoder.decode();
  const trailing = buffer.trim();
  if (trailing && !trailing.startsWith(':')) {
    const data = trailing.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') {
      try { yield JSON.parse(data); } catch { throw new Error('UPSTREAM_STREAM_INVALID'); }
    }
  }
}
