export const DEEPSEEK_FEATURES = Object.freeze({
  webSearch: true, readUrl: true, fileInput: true, imageInput: true,
  asr: true, tts: true, title: true, safety: true,
});
export const OPENROUTER_FEATURES = Object.freeze({
  // Text, images and PDFs work through OpenRouter's free models / file parser.
  // Web search, DeepSeek files, ASR and TTS remain DeepSeek-only.
  webSearch: false, readUrl: false, fileInput: true, imageInput: true,
  asr: false, tts: false, title: false, safety: false,
});

export function chatProvider(options = {}) {
  const name = options.provider ?? process.env.CHAT_PROVIDER ?? 'deepseek';
  if (!['deepseek', 'openrouter'].includes(name)) throw new Error('CHAT_PROVIDER 配置无效');
  const free = name === 'openrouter';
  const key = String(options.apiKey ?? (free ? process.env.OPENROUTER_API_KEY : process.env.DEEPSEEK_API_KEY) ?? '').trim();
  const model = String(options.model || (free ? process.env.OPENROUTER_MODEL : process.env.CHAT_MODEL)
    || (free ? 'openrouter/free' : 'deepseek-flash')).trim();
  const url = free ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.deepseek.com/chat/completions';
  return {
    name, model, mode: key ? 'live' : 'demo',
    features: free ? OPENROUTER_FEATURES : DEEPSEEK_FEATURES,
    generate(fetchImpl, messages, userId, generationOptions, maxTokens, signal) {
      // Keep the old boolean call shape working for tests and existing callers.
      const options = generationOptions && typeof generationOptions === 'object'
        ? generationOptions : { thinking: generationOptions === true };
      const thinking = options.thinking === true;
      const tools = [];
      if (!free && options.webSearch === true) tools.push({ type: 'deepseek_web_search' });
      if (!free && options.readUrl === true) tools.push({ type: 'deepseek_read_url' });
      const common = { model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
      const hasFile = messages.some((message) => Array.isArray(message?.content)
        && message.content.some((block) => block?.type === 'file'));
      const reasoningMode = options.reasoning
        || (typeof process !== 'undefined' && process.env ? process.env.OPENROUTER_REASONING : '') || 'off';
      const reasoningPayload = reasoningMode === 'off' ? { reasoning: { enabled: false } }
        : reasoningMode === 'low' ? { reasoning: { effort: 'low' } } : {};
      const payload = free ? { ...common,
        ...(hasFile ? { plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }] } : {}),
        ...reasoningPayload,
        provider: { max_price: { prompt: 0, completion: 0 } } } :
        { ...common, user_id: userId, thinking: { type: thinking ? 'enabled' : 'disabled' },
          ...(tools.length ? { tools } : {}),
          ...(options.safety === false ? {} : { safety_check: { level: 'high' } }),
          ...(options.title === true ? { title: { enabled: true } } : {}),
          ...(thinking ? { reasoning_effort: 'low' } : {}) };
      // Workers only accept 'follow' or 'manual'; a 3xx is handled as a failed response.
      return fetchImpl(url, { method: 'POST', redirect: 'manual', signal,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    },
  };
}
