/**
 * stream({ provider, messages, tools, signal, thinking, onText, onThinking })
 * Retorna: { content, tool_calls: [{ id, name, arguments }], usage: { input, output } }
 *
 * thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
 */

export const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/* ---------------- retry ----------------
 * Requisição de LLM cai por 429/5xx/timeout/rede o tempo todo. Sem retry o
 * turno inteiro morria no primeiro tropeço do provedor.
 *
 *   RETRY_TRIES  = 100  tentativas no total
 *   RETRY_DELAY  = 3000 ms entre uma tentativa e a próxima
 * Ajustável por env: KIRO_RETRY_TRIES / KIRO_RETRY_DELAY_MS.
 */
export const RETRY_TRIES = Math.max(1, Number(process.env.KIRO_RETRY_TRIES) || 100);
export const RETRY_DELAY = Math.max(0, Number(process.env.KIRO_RETRY_DELAY_MS ?? 3000));

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (!ms) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        const e = new Error('cancelado pelo usuário');
        e.name = 'AbortError';
        reject(e);
      },
      { once: true },
    );
  });

/** Erros que NÃO devem ser repetidos: o problema está na requisição, não na rede. */
function permanent(err) {
  if (err?.name === 'AbortError') return true;
  const st = Number(err?.status || 0);
  if (st >= 400 && st < 500 && st !== 408 && st !== 409 && st !== 425 && st !== 429) return true;
  const msg = String(err?.message || '');
  // chave inválida / modelo inexistente / payload inválido
  return /invalid[ _-]?api[ _-]?key|unauthorized|forbidden|model[_ ]not[_ ]found|no such model|invalid[_ ]request|bad[_ ]request|context[ _]length|quota exceeded for the month/i.test(
    msg,
  );
}

/**
 * Executa `fn` com até `tries` tentativas, esperando `delay` ms entre elas.
 * `onRetry({ attempt, tries, error, waitMs })` permite mostrar progresso na TUI.
 */
export async function withRetry(fn, opts = {}) {
  const tries = Math.max(1, opts.tries ?? RETRY_TRIES);
  const delay = Math.max(0, opts.delay ?? RETRY_DELAY);
  const signal = opts.signal;
  const onRetry = opts.onRetry;
  let lastErr;

  for (let attempt = 1; attempt <= tries; attempt++) {
    if (signal?.aborted) {
      const e = new Error('cancelado pelo usuário');
      e.name = 'AbortError';
      throw e;
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err?.name === 'AbortError') throw err;
      if (permanent(err)) {
        err.permanent = true;
        throw err;
      }
      if (attempt >= tries) break;
      const waitMs = delay;
      try {
        onRetry?.({ attempt, tries, error: err, waitMs });
      } catch {}
      await sleep(waitMs, signal);
    }
  }
  const e = lastErr || new Error('falhou sem erro registrado');
  e.attempts = tries;
  throw e;
}

const ANTHROPIC_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768 };
const OPENAI_EFFORT = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };

export const PROVIDER_PRESETS = {
  openai: { label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
  anthropic: {
    label: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
  },
  nvidia: {
    label: 'NVIDIA NIM',
    type: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.1-70b-instruct'],
  },
  google: {
    label: 'Google AI Studio',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.8-flash', 'gemini-4-argon'],
  },
  arena: { label: 'Arena', type: 'openai', baseUrl: 'https://api.arena.ai/v1', models: [] },
  ollama: { label: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2'], noKey: true },
};

/** Linhas SSE -> objetos JSON */
async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}

async function assertOk(res) {
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${t.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
}

/**
 * Alguns provedores mandam os `arguments` da tool call com quebras de linha
 * CRUAS dentro das strings (em vez de "\n" escapado). O JSON.parse então
 * estoura e o argumento vira {} — a tool chega com o old_string "quebrado".
 *
 * Aqui a gente tenta o parse normal; se falhar, faz um reparo: percorre o
 * texto respeitando o estado "dentro de string" e troca control chars crus
 * (newline, tab, CR) pela versão escapada, e tenta de novo. Só isso — nada de
 * reescrever o JSON inteiro, então o que for válido continua idêntico.
 */
const controlInStrings = (s) => {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (inStr && c === '\\') {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      out += c;
      continue;
    }
    if (inStr) {
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (c < ' ') out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      else out += c;
      continue;
    }
    out += c;
  }
  return out;
};

const safeJson = (s) => {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(controlInStrings(s));
    } catch {
      return {};
    }
  }
};

/* ---------------- OpenAI compatível ---------------- */

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) },
        })),
      };
    }
    if (m.images?.length) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

async function openaiStream({ provider, messages, tools, signal, thinking, onText, onThinking }) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const body = {
    model: provider.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(messages),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t.schema })) } : {}),
  };
  if (thinking && thinking !== 'off') body.reasoning_effort = OPENAI_EFFORT[thinking];
  if (provider.maxOutput) body.max_tokens = provider.maxOutput;

  return withRetry(
    async () => {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify(body),
      });
      await assertOk(res);

      let content = '';
      const calls = {};
      let usage = { input: 0, output: 0 };
      // texto já entregue nesta tentativa: se ela falhar no meio, o retry avisa
      // o consumidor para descartar o parcial (senão o texto duplicava na tela
      // e entrava duplicado no histórico).
      let emitted = '';
      try {
        for await (const chunk of sse(res.body)) {
          if (chunk.usage) {
            usage = { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0 };
          }
          const d = chunk.choices?.[0]?.delta;
          if (!d) continue;
          const reasoning = d.reasoning_content || d.reasoning;
          if (reasoning) onThinking?.(reasoning);
          if (d.content) {
            content += d.content;
            emitted += d.content;
            onText?.(d.content);
          }
          for (const tc of d.tool_calls || []) {
            const i = tc.index ?? 0;
            calls[i] ??= { id: '', name: '', args: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].name += tc.function.name;
            if (tc.function?.arguments) calls[i].args += tc.function.arguments;
          }
        }
      } catch (err) {
        err.partialText = emitted;
        throw err;
      }
      return {
        content,
        usage,
        tool_calls: Object.values(calls).map((c, i) => ({
          id: c.id || `call_${i}_${Date.now()}`,
          name: c.name,
          arguments: safeJson(c.args),
        })),
      };
    },
    {
      signal,
      tries: provider.retries,
      delay: provider.retryDelay,
      onRetry: (info) => opts.onRetry?.({ ...info, provider: 'openai' }),
    },
  );
}

/* ---------------- Anthropic ---------------- */

function toAnthropic(messages) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const out = [];
  for (const m of messages.filter((x) => x.role !== 'system')) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.tool_calls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments || {} })),
        ],
      });
    } else if (m.images?.length) {
      out.push({
        role: 'user',
        content: [
          ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
          { type: 'text', text: m.content },
        ],
      });
    } else if (m.content) {
      out.push({ role: m.role, content: m.content });
    }
  }
  return { system, messages: out };
}

async function anthropicStream({ provider, messages, tools, signal, thinking, onText, onThinking }) {
  const { system, messages: msgs } = toAnthropic(messages);
  const budget = thinking && thinking !== 'off' ? ANTHROPIC_BUDGET[thinking] : 0;

  const body = {
    model: provider.model,
    max_tokens: provider.maxOutput
      ? Math.max(provider.maxOutput, budget ? budget + 1024 : 0)
      : budget ? budget + 4096 : 4096,
    stream: true,
    system,
    messages: msgs,
    ...(tools.length
      ? { tools: tools.map((t) => ({ name: t.schema.name, description: t.schema.description, input_schema: t.schema.parameters })) }
      : {}),
  };
  if (budget) body.thinking = { type: 'enabled', budget_tokens: budget };

  return withRetry(
    async () => {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      await assertOk(res);

      let content = '';
      const blocks = {};
      const usage = { input: 0, output: 0 };
      let emitted = '';
      try {
        for await (const ev of sse(res.body)) {
          if (ev.type === 'message_start') usage.input = ev.message?.usage?.input_tokens || 0;
          else if (ev.type === 'message_delta') usage.output = ev.usage?.output_tokens || usage.output;
          else if (ev.type === 'error') {
            const err = new Error(`stream: ${ev.error?.message || 'erro no meio do stream'}`);
            err.status = ev.error?.type === 'overloaded_error' ? 529 : undefined;
            err.partialText = emitted;
            throw err;
          } else if (ev.type === 'content_block_start') {
            const b = ev.content_block;
            if (b.type === 'tool_use') blocks[ev.index] = { id: b.id, name: b.name, json: '' };
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta;
            if (d.type === 'text_delta') {
              content += d.text;
              emitted += d.text;
              onText?.(d.text);
            } else if (d.type === 'thinking_delta') onThinking?.(d.thinking);
            else if (d.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].json += d.partial_json;
          }
        }
      } catch (err) {
        if (!err.partialText) err.partialText = emitted;
        throw err;
      }
      return {
        content,
        usage,
        tool_calls: Object.values(blocks).map((b) => ({ id: b.id, name: b.name, arguments: safeJson(b.json) })),
      };
    },
    {
      signal,
      tries: provider.retries,
      delay: provider.retryDelay,
      onRetry: (info) => opts.onRetry?.({ ...info, provider: 'anthropic' }),
    },
  );
}

/** Lista modelos disponíveis do provedor (quando a API suporta) */
export async function listModels(provider) {
  if (provider.type === 'google') return listGoogle(provider);
  if (provider.type === 'anthropic') return PROVIDER_PRESETS.anthropic.models.map((id) => ({ id, context: null }));
  const headers = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, { headers });
  await assertOk(res);
  const json = await res.json();
  return (json.data || [])
    .map((m) => ({
      id: m.id,
      context:
        m.context_length ||
        m.top_provider?.context_length ||
        m.max_model_len ||
        m.context_window ||
        m.limit?.context ||
        null,
      output:
        m.top_provider?.max_completion_tokens ||
        m.max_output_tokens ||
        m.max_completion_tokens ||
        m.limit?.output ||
        null,
      reasoning: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.includes('reasoning')
        : (m.capabilities?.reasoning?.supported ?? null),
      vision: Array.isArray(m.architecture?.input_modalities)
        ? m.architecture.input_modalities.includes('image')
        : Array.isArray(m.modalities?.input)
          ? m.modalities.input.includes('image')
          : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function streamChat(opts) {
  if (opts.provider.type === 'google') return googleStream(opts);
  return opts.provider.type === 'anthropic' ? anthropicStream(opts) : openaiStream(opts);
}

/* ---------------- Google Gemini (API nativa) ---------------- */

const GOOGLE_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768 };
const GOOGLE_LEVEL = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };
// Gemini 3+ usa thinkingLevel; 2.5 usa thinkingBudget
const googleUsesLevel = (model) => /gemini-[34]/.test(model || '');
const googleId = (name) => String(name || '').replace(/^models\//, '');

function pushContent(list, role, parts) {
  if (!parts.length) return;
  const last = list[list.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else list.push({ role, parts });
}

function toGoogle(messages) {
  const names = {};
  let system;
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? system + '\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      pushContent(contents, 'user', [
        { functionResponse: { name: names[m.tool_call_id] || 'tool', response: { result: m.content } } },
      ]);
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const t of m.tool_calls || []) {
        names[t.id] = t.name;
        const part = { functionCall: { name: t.name, args: t.arguments || {} } };
        // assinatura do pensamento precisa voltar junto da tool call (Gemini 3)
        if (t.thoughtSignature) part.thoughtSignature = t.thoughtSignature;
        parts.push(part);
      }
      pushContent(contents, 'model', parts);
      continue;
    }
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    for (const i of m.images || []) parts.push({ inlineData: { mimeType: i.mime, data: i.data } });
    pushContent(contents, 'user', parts.length ? parts : [{ text: '' }]);
  }
  return { system, contents };
}

async function googleStream({ provider, messages, tools, signal, thinking, onText, onThinking, onRetry }) {
  const { system, contents } = toGoogle(messages);
  const generationConfig = {};
  // limite de saída: só envia quando o provedor informa (vem do endpoint)
  if (provider.maxOutput) generationConfig.maxOutputTokens = provider.maxOutput;
  if (thinking && thinking !== 'off') {
    generationConfig.thinkingConfig = { includeThoughts: true };
    if (googleUsesLevel(provider.model)) generationConfig.thinkingConfig.thinkingLevel = GOOGLE_LEVEL[thinking];
    else generationConfig.thinkingConfig.thinkingBudget = GOOGLE_BUDGET[thinking];
  }
  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => t.schema) }] } : {}),
    generationConfig,
  };
  const base = provider.baseUrl.replace(/\/$/, '');
  const url = `${base}/models/${googleId(provider.model)}:streamGenerateContent?alt=sse`;
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['x-goog-api-key'] = provider.apiKey;

  return withRetry(
    async () => {
      const res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
      await assertOk(res);

      let content = '';
      let emitted = '';
      const calls = [];
      let usage = { input: 0, output: 0 };
      try {
        for await (const chunk of sse(res.body)) {
          const u = chunk.usageMetadata;
          if (u) {
            usage = {
              input: u.promptTokenCount || 0,
              output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
            };
          }
          for (const cand of chunk.candidates || []) {
            for (const part of cand.content?.parts || []) {
              if (part.functionCall) {
                calls.push({
                  id: `call_${calls.length}_${Date.now()}`,
                  name: part.functionCall.name,
                  arguments: part.functionCall.args || {},
                  thoughtSignature: part.thoughtSignature,
                });
              } else if (part.text) {
                if (part.thought) onThinking?.(part.text);
                else {
                  content += part.text;
                  emitted += part.text;
                  onText?.(part.text);
                }
              }
            }
          }
        }
      } catch (err) {
        err.partialText = emitted;
        throw err;
      }
      return { content, usage, tool_calls: calls };
    },
    {
      signal,
      tries: provider.retries,
      delay: provider.retryDelay,
      onRetry: (info) => onRetry?.({ ...info, provider: 'google' }),
    },
  );
}

// modelos que não são de chat (imagem, áudio, embedding, etc.)
const GOOGLE_NON_CHAT = /image|banana|tts|embedding|lyria|transcribe|omni|robotics|computer-use|deep-research|antigravity|live|native-audio|aqa/;

async function listGoogle(provider) {
  const base = provider.baseUrl.replace(/\/$/, '');
  const headers = provider.apiKey ? { 'x-goog-api-key': provider.apiKey } : {};
  const all = [];
  let pageToken = '';
  do {
    const res = await fetch(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers });
    await assertOk(res);
    const json = await res.json();
    all.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);

  return all
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .filter((m) => !GOOGLE_NON_CHAT.test(googleId(m.name)))
    .map((m) => {
      const id = googleId(m.name);
      return {
        id,
        // limites vêm direto da API (inputTokenLimit / outputTokenLimit)
        context: m.inputTokenLimit || null,
        output: m.outputTokenLimit || null,
        reasoning: /gemini-(2\.5|[34])/.test(id) ? true : null,
        vision: /gemini/.test(id),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
