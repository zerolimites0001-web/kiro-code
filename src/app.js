import { TUI, FG } from './tui.js';
import {
  loadConfig,
  saveConfig,
  newSession,
  saveSession,
  flushSessions,
  hasPending,
  listSessions,
  deleteSession,
  readSession,
  sessionFile,
  SESSIONS,
  backupSession,
  healSessions,
  buildSystemPrompt,
  logDebug,
  instanceLabel,
  ISOLATED,
} from './store.js';
import { listInstances, pruneInstances, GLOBAL_HOME } from './instance.js';
import { PROVIDER_PRESETS, THINK_LEVELS, streamChat, listModels, withRetry, RETRY_TRIES, RETRY_DELAY } from './providers.js';
import { TOOLS, getTool } from './tools.js';
import {
  loadCatalog,
  effectiveMeta,
  entryOf,
  fillFromCatalog,
  clampThink,
  fmtTokens,
  parseTokens,
} from './meta.js';
import { loadMcp, saveMcp, connectServer, disconnectServer, startMcp, mcpStatus } from './mcp.js';
import { setHost, loadPlugins, emit, getPluginCommand, pluginCommandList, pluginsCommand } from './plugins.js';

const MAX_STEPS = 99999999999;
const COMPACT_PROMPT =
  'Resuma a conversa acima em português, de forma objetiva. Preserve: objetivo do usuário, decisões tomadas, ' +
  'arquivos criados ou alterados (com caminhos), erros importantes e pendências. Responda apenas com o resumo.';

const tui = new TUI();
let cfg = loadConfig();
let catalog = {};
let session = null;
let abortCtl = null;
let busy = false;
let interrupting = false;
let lastCtrlC = 0;
let usage = { input: 0, output: 0 };
let lastInput = 0;
let turnStart = 0;
let lastTurnSecs = null;
const queue = [];

setHost({ tui });

const abortError = (msg = 'cancelado pelo usuário') => {
  const e = new Error(msg);
  e.name = 'AbortError';
  return e;
};

/**
 * Interrompe o turno corrente: aborta o stream/tool em andamento e marca
 * `interrupting` para que o loop do agente não recrie um novo turno depois.
 * Idempotente — chamar de novo (ESC, Ctrl+C repetido) só reforça.
 */
function interruptTurn() {
  interrupting = true;
  if (abortCtl && !abortCtl.signal.aborted) {
    try {
      abortCtl.abort();
    } catch {}
  }
  return true;
}
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const estimateTokens = (msgs) => Math.ceil(JSON.stringify(msgs).length / 4);

/* ---------------- estado ---------------- */

const activeProvider = () => (cfg.active ? cfg.providers[cfg.active] : null);
const callable = (p) => ({ ...p, model: p.defaultModel });

function effectiveThinking(name, p) {
  const m = effectiveMeta(p, p.defaultModel, name, catalog);
  if (!m.reasoning) return 'off';
  return clampThink(cfg.thinking, m.ceiling);
}

function refreshStatus() {
  const name = cfg.active;
  const p = activeProvider();
  tui.status = p
    ? `${process.cwd()}  ·  ${instanceLabel()}  ·  sessão ${session?.id ?? '-'}`
    : 'sem provedor — use /login';

  const parts = [`↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}`];
  if (p && p.defaultModel) {
    const m = effectiveMeta(p, p.defaultModel, name, catalog);
    const pct = Math.min(100, Math.round((lastInput / m.context) * 100));
    parts.push(`${pct}%/${fmtTokens(m.context)}`, p.defaultModel, name, `thinking ${effectiveThinking(name, p)}`);
  }
  if (queue.length) parts.push(`fila ${queue.length}`);
  if (lastTurnSecs !== null) parts.push(`✓ ${lastTurnSecs.toFixed(1)}s`);
  tui.footer = parts.join('  ·  ');
}

/**
 * Grava a sessão. Sem `immediate` a escrita é agrupada (400ms) para não escrever
 * centenas de KB a cada tool result; nos pontos críticos (mensagem do usuário,
 * fim do turno, shutdown) usa-se `true`.
 */
function persist(immediate = false) {
  if (!session) return;
  const ok = saveSession(session, { immediate });
  if (session._stale) {
    session._stale = false;
    tui.print(
      'Aviso: outra aba gravou um histórico maior nesta sessão. Use /resume para recarregar a versão completa.',
      FG.warn,
    );
  }
  return ok;
}

function newChat() {
  // flush do que estava pendente: trocar de sessão com escrita em fila perdia dados
  flushSessions();
  session = newSession({ provider: cfg.active, model: activeProvider()?.defaultModel });
  session.messages.push({ role: 'system', content: buildSystemPrompt(process.cwd()) });
  usage = { input: 0, output: 0 };
  lastInput = estimateTokens(session.messages);
  lastTurnSecs = null;
  tui.clear();
  tui.print(`Nova sessão ${session.id}`, FG.dim);
  refreshStatus();
  emit('session:change', { id: session.id });
}

function renderHistory() {
  tui.clear();
  for (const m of session.messages) {
    if (m.role === 'user') tui.addUser(m.content);
    else if (m.role === 'assistant') {
      if (m.thinking) tui.addThink(m.thinking);
      if (m.content) tui.print(m.content);
    } else if (m.role === 'tool') tui.pushTool({ ...m.ui, title: m.ui?.title || m.name || 'tool' });
  }
  lastInput = estimateTokens(session.messages);
  refreshStatus();
}

/* ---------------- agente ---------------- */

function summarize(call) {
  const a = call.arguments || {};
  if (call.name === 'bash' || call.name === 'loop') return ''; // comando completo vai no corpo (quebra linha), não no cabeçalho
  return clip(a.path ?? '', 44);
}

async function execTool(call) {
  const summary = summarize(call);
  const entry = tui.addTool(call.name, summary);
  // mostra o comando (entrada) logo ao iniciar, antes da saída ao vivo
  if (call.name === 'bash' || call.name === 'loop') {
    tui.toolLine(entry, { t: 'i', s: `$ ${call.arguments?.command ?? ''}` });
  } else if (call.arguments?.path) {
    tui.toolLine(entry, { t: 'i', s: call.arguments.path });
  }
  const finish = (status, subtitle, lines) => {
    entry.status = status;
    entry.subtitle = [summary, subtitle].filter(Boolean).join('  ·  ');
    entry.lines = lines;
    entry.endedAt = Date.now();
    tui.draw();
    emit('tool:after', { name: call.name, status, ms: entry.endedAt - entry.startedAt });
    return { title: call.name, subtitle: entry.subtitle, status, lines, ms: entry.endedAt - entry.startedAt };
  };

  const tool = getTool(call.name);
  if (!tool) {
    const ui = finish('err', '', [{ t: 'e', s: `ferramenta desconhecida: ${call.name}` }]);
    return { content: `ERRO: ferramenta desconhecida: ${call.name}`, ui };
  }
  if (abortCtl.signal.aborted || interrupting) {
    const ui = finish('err', 'cancelado', []);
    return { content: 'ERRO: cancelado pelo usuário', ui };
  }

  emit('tool:before', { name: call.name, args: call.arguments });
  try {
    const p = activeProvider();
    const vision = !!(p?.defaultModel && effectiveMeta(p, p.defaultModel, cfg.active, catalog).vision);
    const res = await tool.run(call.arguments || {}, {
      signal: abortCtl.signal,
      vision,
      log: (s) => {
        // cada pedaço de stdout/stderr vai pra caixa ao vivo, linha por linha,
        // em vez de esperar o comando terminar
        for (const line of String(s).split('\n')) {
          if (line !== '') tui.toolLine(entry, { t: 'o', s: line });
        }
      },
    });
    const ui = finish('ok', res.ui?.subtitle, res.ui?.lines || []);
    return { content: res.text, ui, image: res.image };
  } catch (err) {
    const msg = abortCtl.signal.aborted || interrupting ? 'cancelado pelo usuário' : err.message;
    const ui = finish('err', '', [{ t: 'e', s: msg }]);
    return { content: `ERRO: ${msg}`, ui };
  }
}

async function runTurn(userText) {
  const name = cfg.active;
  const p = activeProvider();
  if (!p || !p.defaultModel) return tui.print('Nenhum modelo ativo. Use /login ou /mod-provider.', FG.err);

  tui.addUser(userText);
  session.messages.push({ role: 'user', content: userText });
  if (session.title === 'nova sessão') session.title = userText.slice(0, 40);
  persist(true); // síncrono: a mensagem do usuário nunca se perde num kill
  emit('turn:start', { text: userText });

  busy = true;
  interrupting = false;
  turnStart = Date.now();
  refreshStatus();
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Se o usuário já pediu interrupção (Ctrl+C/ESC durante uma tool), para aqui:
      // recriar o controller a cada passo era o que fazia a IA "ressuscitar" e
      // continuar rodando depois do Ctrl+C.
      if (interrupting) throw abortError('cancelado pelo usuário');

      abortCtl = new AbortController();
      tui.setBusy(step === 0 ? 'pensando' : 'continuando');

      let thought = '';
      const res = await streamChat({
        provider: callable(p),
        messages: session.messages,
        tools: TOOLS,
        signal: abortCtl.signal,
        thinking: effectiveThinking(name, p),
        onText: (d) => tui.stream(d),
        onThinking: (d) => {
          thought += d;
          tui.think(d);
        },
        // retry: 100 tentativas, 3s entre elas (padrão em providers.js)
        onRetry: ({ attempt, tries, error, waitMs }) => {
          // a tentativa que falhou pode ter deixado texto parcial: descarta
          tui.discardPartial();
          thought = '';
          tui.setBusy(`retry ${attempt}/${tries} · ${String(error?.message || error).slice(0, 60)}`);
          refreshStatus();
          tui.print(
            `↻ tentativa ${attempt}/${tries} falhou (${String(error?.message || error).slice(0, 100)}). Nova tentativa em ${Math.round(waitMs / 1000)}s.`,
            FG.warn,
          );
        },
      });
      tui.commit();

      usage.input += res.usage?.input || 0;
      usage.output += res.usage?.output || 0;
      // provedor sem uso informado: estima pelo tamanho do histórico, para o % não ficar em 0
      lastInput = res.usage?.input || estimateTokens(session.messages);

      const hasCalls = res.tool_calls.length > 0;
      if (res.content || hasCalls) {
        session.messages.push({
          role: 'assistant',
          content: res.content,
          thinking: thought || undefined,
          tool_calls: hasCalls ? res.tool_calls : undefined,
        });
        persist();
      }
      refreshStatus();
      if (!hasCalls) break;

      tui.setBusy('executando ferramenta');
      for (const call of res.tool_calls) {
        // Interrompido no meio da lista: ainda grava um resultado para cada
        // tool_call restante. Sem isso o histórico fica com tool_call sem
        // resposta e o próximo turno estoura no provedor.
        if (interrupting || abortCtl.signal.aborted) {
          session.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: 'ERRO: cancelado pelo usuário',
          });
          continue;
        }
        const result = await execTool(call);
        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: String(result.content),
          ui: result.ui,
        });
        if (result.image) {
          session.messages.push({
            role: 'user',
            content: `Imagem anexada (${call.arguments?.path || 'sem nome'}).`,
            images: [result.image],
          });
        }
        persist();
      }
      if (interrupting) throw abortError('cancelado pelo usuário');
      if (step === MAX_STEPS - 1) tui.print(`Limite de ${MAX_STEPS} passos atingido. Envie outra mensagem para continuar.`, FG.warn);
    }
  } catch (err) {
    if (err.name === 'AbortError') tui.print('[interrompido]', FG.warn);
    else tui.print(`Erro: ${err.message}`, FG.err);
  } finally {
    tui.commit();
    busy = false;
    interrupting = false;
    abortCtl = null;
    lastTurnSecs = (Date.now() - turnStart) / 1000;
    persist(true); // fim de turno: tudo que foi agrupado vai pro disco agora
    emit('turn:end', { seconds: lastTurnSecs, usage });
    tui.setBusy('');
    refreshStatus();
    tui.draw();
  }
}

/* ---------------- /compact ---------------- */

function transcript(msgs) {
  return msgs
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'user') return `USUÁRIO: ${m.content}`;
      if (m.role === 'assistant')
        return `ASSISTENTE: ${m.content || ''}${m.tool_calls ? ` [chamou: ${m.tool_calls.map((t) => t.name).join(', ')}]` : ''}`;
      if (m.role === 'tool') return `RESULTADO (${m.name}): ${clip(m.content, 400)}`;
      return '';
    })
    .join('\n\n');
}

async function compact() {
  const p = activeProvider();
  if (!p || !p.defaultModel) return tui.print('Nenhum modelo ativo. Use /login.', FG.err);
  if (session.messages.filter((m) => m.role !== 'system').length < 2) return tui.print('Nada para compactar ainda.', FG.dim);

  busy = true;
  interrupting = false;
  abortCtl = new AbortController();
  tui.setBusy('compactando contexto');
  try {
    const res = await streamChat({
      provider: callable(p),
      messages: [{ role: 'user', content: `${transcript(session.messages)}\n\n${COMPACT_PROMPT}` }],
      tools: [],
      signal: abortCtl.signal,
      thinking: 'off',
      onText: () => {},
      onThinking: () => {},
    });
    // O /compact substitui o histórico inteiro — sem backup isso era perda
    // irreversível de metade do chat. O .pre-compact guarda a versão completa.
    const bak = backupSession(session, 'pre-compact');
    session.messages = [
      session.messages[0],
      { role: 'user', content: `Resumo da conversa anterior:\n${res.content}` },
      { role: 'assistant', content: 'Entendido. Continuo a partir desse resumo.' },
    ];
    session.compactedAt = new Date().toISOString();
    lastInput = estimateTokens(session.messages);
    persist(true);
    tui.print(
      `Contexto compactado. Histórico completo preservado em ${bak ? bak.split('/').pop() : 'backup'}.`,
      FG.ok,
    );
  } catch (err) {
    tui.print(err.name === 'AbortError' ? '[compactação cancelada]' : `Erro ao compactar: ${err.message}`, FG.err);
  } finally {
    busy = false;
    interrupting = false;
    abortCtl = null;
    tui.setBusy('');
    refreshStatus();
    tui.draw();
  }
}

/* ---------------- thinking ---------------- */

function setThinking(level) {
  cfg.thinking = level;
  saveConfig(cfg);
  refreshStatus();
  tui.draw();
}

const THINK_HELP = {
  off: 'Sem raciocínio',
  minimal: 'Raciocínio bem curto (~1k tokens)',
  low: 'Raciocínio leve (~2k tokens)',
  medium: 'Raciocínio moderado (~8k tokens)',
  high: 'Raciocínio profundo (~16k tokens)',
  xhigh: 'Raciocínio extra (~32k tokens)',
};

async function pickThinking() {
  const pick = await tui.select(
    'Thinking level',
    THINK_LEVELS.map((l) => ({ label: `${l.padEnd(8)} ${THINK_HELP[l]}${l === cfg.thinking ? '  ✓' : ''}`, value: l })),
  );
  if (pick) setThinking(pick);
}

/* ---------------- provedores e modelos ---------------- */

function modelLabel(name, p, id) {
  const m = effectiveMeta(p, id, name, catalog);
  const shortId = id.length > 34 ? id.slice(0, 33) + '…' : id.padEnd(34);
  const ctx = m.sources.context === 'padrão' ? '?' : fmtTokens(m.context);
  const out = m.sources.output === 'padrão' ? '?' : fmtTokens(m.output);
  return `${shortId} ${ctx} ctx · ${out} out · ${m.reasoning ? 'reason' : 'sem reason'} · ${m.vision ? 'visão' : 'texto'}`;
}

/** Busca modelos no endpoint e preenche metadados (endpoint, depois models.dev). Mantém os manuais. */
async function syncProvider(name) {
  const p = cfg.providers[name];
  catalog = await loadCatalog();

  let list = null;
  try {
    // listModels também passa pelo retry (100x, 3s) — provedor lento não derruba o /login
    list = await withRetry(() => listModels(p), {
      tries: RETRY_TRIES,
      delay: RETRY_DELAY,
      onRetry: ({ attempt, tries, error, waitMs }) =>
        tui.setBusy(`modelos ${attempt}/${tries} · ${String(error?.message || error).slice(0, 50)} · ${Math.round(waitMs / 1000)}s`),
    });
  } catch (err) {
    tui.print(`Não consegui listar os modelos de ${name}: ${err.message.slice(0, 160)}`, FG.err);
    tui.print('Mantive a lista que já existia. Use "Adicionar modelo manualmente" se precisar.', FG.warn);
    return;
  }
  if (!list.length) {
    tui.print(`${name} respondeu sem modelos.`, FG.warn);
    return;
  }

  const previous = new Map((p.models || []).map((m) => [m.id, m]));
  p.models = list.map((x) => {
    const prev = previous.get(x.id) || {};
    const entry = { ...prev, id: x.id };
    entry._src = { ...(prev._src || {}) };
    const fromEndpoint = (k, v) => {
      if (v !== null && v !== undefined && entry[k] === undefined) {
        entry[k] = v;
        entry._src[k] = 'endpoint';
      }
    };
    fromEndpoint('contextWindow', x.context);
    fromEndpoint('maxTokens', x.output);
    fromEndpoint('reasoning', x.reasoning);
    if (x.vision !== null && x.vision !== undefined && entry.input === undefined) {
      entry.input = x.vision ? ['text', 'image'] : ['text'];
      entry._src.input = 'endpoint';
    }
    fillFromCatalog(entry, p, name, catalog);
    return entry;
  });

  if (!p.models.some((m) => m.id === p.defaultModel)) p.defaultModel = p.models[0]?.id || null;
  saveConfig(cfg);
  refreshStatus();
  tui.print(`${p.models?.length ?? 0} modelos carregados de ${name}.`, FG.ok);
}

async function pickDefaultModel(name) {
  const p = cfg.providers[name];
  const items = p.models.map((m) => ({ label: modelLabel(name, p, m.id), value: m.id }));
  items.push({ label: 'Digitar ID manualmente', value: '__manual' });

  let pick = await tui.select(`Modelo padrão de ${name}`, items);
  if (pick === '__manual') {
    const id = await tui.ask('ID do modelo:');
    if (id) {
      p.models.push({ id, _src: {} });
      pick = id;
    } else pick = null;
  }
  if (pick) {
    p.defaultModel = pick;
    saveConfig(cfg);
    refreshStatus();
    tui.print(`Modelo padrão: ${pick}`, FG.ok);
  }
}

async function editModel(name, id) {
  const p = cfg.providers[name];
  const entry = entryOf(p, id);
  if (!entry) return;
  const m = effectiveMeta(p, id, name, catalog);
  const mark = (k) => {
    entry._src ??= {};
    entry._src[k] = 'manual';
  };

  const pick = await tui.select(`${id}  ·  ${fmtTokens(m.context)} ctx  ·  ${fmtTokens(m.output)} out  ·  fonte: ${m.source}`, [
    { label: `Reasoning  ·  ${m.reasoning ? 'sim' : 'não'}`, value: 'reasoning' },
    { label: `Teto de reasoning  ·  ${m.ceiling || 'xhigh'}`, value: 'ceiling' },
    { label: `Entrada de imagem  ·  ${m.vision ? 'sim' : 'não'}`, value: 'vision' },
    { label: `Janela de contexto (contextWindow)  ·  ${fmtTokens(m.context)}`, value: 'context' },
    { label: `Máx. tokens de saída (maxTokens)  ·  ${fmtTokens(m.output)}`, value: 'output' },
    { label: 'Usar como modelo padrão', value: 'default' },
    { label: 'Atualizar metadados (models.dev)', value: 'refresh' },
    { label: 'Remover modelo', value: 'delete' },
    { label: 'Voltar', value: 'back' },
  ]);

  switch (pick) {
    case 'reasoning':
      entry.reasoning = !m.reasoning;
      mark('reasoning');
      break;
    case 'vision':
      entry.input = m.vision ? ['text'] : ['text', 'image'];
      mark('input');
      break;
    case 'ceiling': {
      const c = await tui.select('Teto de reasoning', THINK_LEVELS.map((l) => ({ label: l, value: l })));
      if (c) entry.ceiling = c;
      break;
    }
    case 'context': {
      const v = parseTokens(await tui.ask('contextWindow (ex: 131k, 1M):'));
      if (!Number.isNaN(v)) {
        entry.contextWindow = v;
        mark('contextWindow');
      }
      break;
    }
    case 'output': {
      const v = parseTokens(await tui.ask('maxTokens (ex: 32k):'));
      if (!Number.isNaN(v)) {
        entry.maxTokens = v;
        mark('maxTokens');
      }
      break;
    }
    case 'default':
      p.defaultModel = id;
      break;
    case 'refresh': {
      for (const k of ['contextWindow', 'maxTokens', 'reasoning', 'input']) {
        if (entry._src?.[k] !== 'manual') delete entry[k];
      }
      catalog = await loadCatalog({ force: true });
      fillFromCatalog(entry, p, name, catalog);
      break;
    }
    case 'delete':
      p.models = p.models.filter((x) => x.id !== id);
      if (p.defaultModel === id) p.defaultModel = p.models[0]?.id || null;
      saveConfig(cfg);
      refreshStatus();
      tui.print(`Modelo ${id} removido de ${name}.`, FG.ok);
      return;
    default:
      saveConfig(cfg);
      refreshStatus();
      return;
  }

  saveConfig(cfg);
  refreshStatus();
  tui.print(`Modelo ${id} atualizado.`, FG.ok);
  return editModel(name, id);
}

async function editProviderModels(name) {
  const p = cfg.providers[name];
  const items = p.models.map((m) => ({ label: modelLabel(name, p, m.id), value: m.id }));
  items.push({ label: 'Voltar', value: null });
  const id = await tui.select(`Modelos de ${name}`, items);
  if (id) return editModel(name, id);
}

async function editProvider(name) {
  const p = cfg.providers[name];
  const pick = await tui.select(`${name}  ·  ${p.baseUrl}`, [
    { label: 'Atualizar modelos (probe + models.dev)', value: 'probe' },
    { label: `Trocar modelo padrão (atual: ${p.defaultModel || '—'})`, value: 'default' },
    { label: 'Editar modelos (contexto, saída, reasoning, visão)', value: 'models' },
    { label: 'Adicionar modelo manualmente', value: 'add' },
    { label: 'Alterar endpoint', value: 'endpoint' },
    { label: 'Remover provedor', value: 'delete' },
    { label: 'Voltar', value: 'back' },
  ]);

  switch (pick) {
    case 'probe':
      await syncProvider(name);
      return editProvider(name);
    case 'default':
      await pickDefaultModel(name);
      return editProvider(name);
    case 'models':
      return editProviderModels(name);
    case 'add': {
      const id = await tui.ask('ID do modelo:');
      if (id && !entryOf(p, id)) p.models.push({ id, _src: {} });
      break;
    }
    case 'endpoint': {
      const url = await tui.ask('Nova base URL:');
      if (url) {
        p.baseUrl = url;
        await syncProvider(name);
      }
      break;
    }
    case 'delete':
      delete cfg.providers[name];
      if (cfg.active === name) cfg.active = Object.keys(cfg.providers)[0] || null;
      tui.print(`Provedor ${name} removido.`, FG.ok);
      break;
    default:
      return;
  }
  saveConfig(cfg);
  refreshStatus();
  tui.draw();
}

async function modProvider() {
  const names = Object.keys(cfg.providers);
  if (!names.length) return tui.print('Nenhum provedor. Use /login.', FG.err);
  const pick = await tui.select(
    'Editar provedor',
    names.map((n) => ({ label: `${n}  ·  ${cfg.providers[n].baseUrl}  ·  ${cfg.providers[n].models.length} modelos`, value: n })),
  );
  if (pick) return editProvider(pick);
}

/* ---------------- MCP: /mcp wizard (ADD MCP / REMOVE MCP) ---------------- */

const AUTH_TYPES = [
  { label: 'NO-LOGIN  (sem autenticação)', value: 'none' },
  { label: 'API key  (Authorization: Bearer)', value: 'bearer' },
  { label: 'Header customizado  (ex: x-api-key)', value: 'header' },
  { label: 'Session ID  (cabeçalho Mcp-Session-Id)', value: 'session' },
];

function mcpLine(name, cfgMcp) {
  const s = mcpStatus(name);
  const st = !s ? 'desconectado' : s.status === 'ok' ? `${s.tools.length} ferramentas` : s.status;
  return `${name}  ·  ${cfgMcp.url}  ·  ${cfgMcp.auth?.type || 'none'}  ·  ${st}`;
}

async function mcpAdd() {
  const name = (await tui.ask('Nome do servidor (ex: github):'))?.trim();
  if (!name) return;
  const servers = loadMcp();
  if (servers[name] && !(await confirm(`"${name}" já existe. Substituir?`))) return;

  const url = (await tui.ask('URL do MCP (https://host/mcp):'))?.trim();
  if (!/^https?:\/\//.test(url || '')) return tui.print('URL inválida: precisa começar com http:// ou https://', FG.err);

  const type = await tui.select('Login', AUTH_TYPES);
  if (!type) return;

  const auth = { type };
  if (type === 'bearer') auth.token = await tui.ask('API key:');
  if (type === 'header') {
    auth.header = await tui.ask('Nome do header (ex: x-api-key):');
    auth.token = await tui.ask('Valor do header:');
  }
  if (type === 'session') auth.sessionId = await tui.ask('Session ID:');

  const extra = await tui.ask('Session ID extra (Enter para pular):');
  if (extra) auth.sessionId = extra;

  servers[name] = { url, auth, enabled: true };
  saveMcp(servers);
  tui.print(`Conectando a ${name}…`, FG.dim);
  const s = await connectServer(name, servers[name]);
  if (s.status === 'ok') {
    tui.print(`✔ ${name}: ${s.tools.length} ferramentas (${s.tools.join(', ') || 'nenhuma'})`, FG.ok);
  } else {
    tui.print(`✘ ${name}: ${s.error}. Salvo mesmo assim; use /mcp para reconectar.`, FG.err);
  }
  tui.draw();
}

async function confirm(question) {
  return tui.select(question, [
    { label: 'Sim', value: true },
    { label: 'Não', value: false },
  ]);
}

async function mcpRemove() {
  const servers = loadMcp();
  const names = Object.keys(servers);
  if (!names.length) return tui.print('Nenhum servidor MCP cadastrado.', FG.warn);
  const pick = await tui.select(
    'REMOVE MCP',
    names.map((n) => ({ label: mcpLine(n, servers[n]), value: n })),
  );
  if (!pick) return;
  if (!(await confirm(`Remover ${pick} e suas ferramentas?`))) return;
  disconnectServer(pick);
  delete servers[pick];
  saveMcp(servers);
  tui.print(`Servidor ${pick} removido.`, FG.ok);
  tui.draw();
}

async function mcpWizard() {
  const servers = loadMcp();
  const items = Object.keys(servers).map((n) => ({ label: mcpLine(n, servers[n]), value: `srv:${n}` }));
  items.push({ label: 'ADD MCP', value: 'add' }, { label: 'REMOVE MCP', value: 'remove' }, { label: 'Voltar', value: 'back' });

  const pick = await tui.select('MCP servers', items);
  if (!pick || pick === 'back') return;
  if (pick === 'add') return mcpAdd();
  if (pick === 'remove') return mcpRemove();

  const name = pick.slice(4);
  const act = await tui.select(name, [
    { label: 'Reconectar e listar ferramentas', value: 'reconnect' },
    { label: 'Desativar/ativar', value: 'toggle' },
    { label: 'Voltar', value: 'back' },
  ]);
  if (act === 'reconnect') {
    tui.print(`Conectando a ${name}…`, FG.dim);
    const s = await connectServer(name, servers[name]);
    tui.print(s.status === 'ok' ? `✔ ${s.tools.length} ferramentas` : `✘ ${s.error}`, s.status === 'ok' ? FG.ok : FG.err);
  } else if (act === 'toggle') {
    servers[name].enabled = servers[name].enabled === false;
    saveMcp(servers);
    if (servers[name].enabled) await connectServer(name, servers[name]);
    else disconnectServer(name);
    tui.print(`${name} ${servers[name].enabled ? 'ativado' : 'desativado'}.`, FG.ok);
  }
  tui.draw();
}

/* ---------------- fila e despacho ---------------- */

async function dispatch(text) {
  if (text.startsWith('/')) await handleCommand(text);
  else await runTurn(text);
  while (queue.length && !busy) {
    const next = queue.shift();
    refreshStatus();
    tui.print(`▶ da fila: ${next}`, FG.dim);
    if (next.startsWith('/')) await handleCommand(next);
    else await runTurn(next);
  }
  refreshStatus();
  tui.draw();
}

/* ---------------- comandos ---------------- */

const COMMANDS = {
  '/help': 'Mostra os comandos',
  '/login': 'Adiciona provedor: busca modelos sozinho e pergunta o modelo padrão',
  '/models': 'Troca o modelo padrão do provedor ativo',
  '/mod-provider': 'Edita provedores e modelos',
  '/provider': 'Troca o provedor ativo',
  '/mcp': 'Servidores MCP: ADD MCP / REMOVE MCP',
  '/plugins': 'Plugins: lista, approve, on, off, reload',
  '/thinking': 'Nível de raciocínio (ou Shift+Tab para ciclar)',
  '/compact': 'Resume a conversa para liberar contexto',
  '/instances': 'Lista as instâncias do Kiro abertas (isolamento entre abas)',
  '/resume': 'Retoma, renomeia (ctrl+r) ou apaga (ctrl+d) uma sessão',
  '/sessions': 'Diagnóstico dos saves: unifica versões divergentes, lista corrompidas',
  '/new': 'Nova sessão',
  '/clear': 'Limpa a tela (mantém a sessão)',
  '/quit': 'Sai do Kiro Code',
};

async function handleCommand(line) {
  const [cmd, ...restParts] = line.trim().split(/\s+/);
  const rest = restParts.join(' ');

  const pluginCmd = getPluginCommand(cmd);
  if (pluginCmd) {
    try {
      const r = await pluginCmd.run(rest);
      if (typeof r === 'string') tui.print(r);
    } catch (err) {
      tui.print(`Erro no plugin (${pluginCmd.owner}): ${err.message}`, FG.err);
    }
    return;
  }

  switch (cmd) {
    case '/help': {
      const extra = pluginCommandList().map((c) => [c.cmd, `${c.description || ''} (plugin ${c.owner ?? '?'})`]);
      const lines = [...Object.entries(COMMANDS), ...extra].map(([k, v]) => `${k.padEnd(14)} ${v}`);
      return tui.print(lines.join('\n'), FG.accent);
    }
    case '/sessions': {
      const sessions = listSessions();
      const bad = sessions.filter((s) => s.corrupt);
      const total = sessions.reduce((n, s) => n + Math.max(0, s.messages.length - 1), 0);
      tui.print(
        `${sessions.length} sessão(ões) em disco · ${total} mensagens no total\n${SESSIONS}`,
        FG.accent,
      );
      if (bad.length) {
        for (const s of bad) {
          tui.print(
            `⚠ ${s.id}  ${s.title}${s.recoverable ? '  (backup válido — vai recuperar ao retomar)' : '  (sem backup)'}`,
            s.recoverable ? FG.warn : FG.err,
          );
        }
      }
      const heal = healSessions();
      const bits = [];
      if (heal.written) bits.push(`unifiquei ${heal.written} sessão(ões) com histórico divergente`);
      if (heal.purged) bits.push(`limpei ${heal.purged} cópia(s) de sessão(ões) apagada(s)`);
      tui.print(bits.length ? `${bits.join(' · ')}.` : 'Nenhuma versão divergente para unificar.', heal.written || heal.purged ? FG.ok : FG.dim);
      if (hasPending()) tui.print('Havia escrita pendente — gravada agora.', FG.dim);
      flushSessions();
      return;
    }

    case '/new':
      return newChat();
    case '/clear':
      return renderHistory();
    case '/compact':
      return compact();
    case '/instances': {
      const rows = listInstances();
      const lines = rows.map(
        (m) =>
          `${m.id === (instanceLabel().replace(/^#/, '')) ? '▶' : ' '} ${m.id.padEnd(22)} ` +
          `${m.alive ? 'ativo ' : 'morto '} pid ${String(m.pid || '-').padEnd(7)} ${m.cwd || ''}`,
      );
      const head = ISOLATED
        ? `Instâncias em ${GLOBAL_HOME}/instances/ (esta: ${instanceLabel()})`
        : `Isolamento desligado (KIRO_NO_ISOLATE=1) — todas as abas compartilham ${GLOBAL_HOME}`;
      return tui.print([head, ...(lines.length ? lines : ['  (nenhuma registrada)'])].join('\n'), FG.dim);
    }
    case '/mod-provider':
      return modProvider();
    case '/mcp':
      return mcpWizard();
    case '/plugins':
      for (const [text, color] of await pluginsCommand(rest)) tui.print(text, color);
      return;
    case '/quit':
    case '/exit':
      return shutdown();
    case '/thinking':
      return pickThinking();

    case '/provider': {
      const names = Object.keys(cfg.providers);
      if (!names.length) return tui.print('Nenhum provedor. Use /login.', FG.err);
      const pick = await tui.select(
        'Escolha o provedor',
        names.map((n) => ({ label: `${n} (${cfg.providers[n].defaultModel || 'sem modelo'})`, value: n })),
      );
      if (pick) {
        cfg.active = pick;
        saveConfig(cfg);
        refreshStatus();
        tui.print(`Provedor ativo: ${pick}`, FG.ok);
      }
      return;
    }

    case '/models': {
      const name = cfg.active;
      const p = activeProvider();
      if (!p) return tui.print('Nenhum provedor ativo. Use /login.', FG.err);
      if (!p.models.length) await syncProvider(name);
      const pick = await tui.select(
        `Modelo padrão de ${name}`,
        p.models.map((m) => ({ label: modelLabel(name, p, m.id), value: m.id })),
      );
      if (pick) {
        p.defaultModel = pick;
        saveConfig(cfg);
        refreshStatus();
        tui.print(`Modelo: ${pick}`, FG.ok);
      }
      return;
    }

    case '/login':
      return login();

    case '/resume': {
      const sessions = listSessions();
      if (!sessions.length) return tui.print('Nenhuma sessão salva.', FG.warn);
      const r = await tui.select(
        'Retomar sessão',
        sessions.slice(0, 30).map((s) => ({
          // tamanho no rótulo: sem isso não dá pra ver que a sessão "encolheu"
          label: `${String(s.updatedAt || '').slice(0, 16).replace('T', ' ')}  ${s.title || '(sem título)'}  [${s.id}]  ${Math.max(0, s.messages.length - 1)} msg${s.corrupt ? (s.recoverable ? '  ⚠ recuperável' : '  ⚠ corrompida') : ''}`,
          value: s.id,
        })),
        { keys: { '\x12': 'rename', '\x04': 'delete' }, hint: 'ctrl+r renomear · ctrl+d apagar' },
      );
      const action = r && typeof r === 'object' ? r.action : null;
      const pick = r && typeof r === 'object' ? r.value : r;
      if (!pick) return;

      if (action === 'delete') {
        const target = sessions.find((s) => s.id === pick);
        if (await confirm(`Apagar "${target.title}" [${target.id}]?`)) {
          const existed = deleteSession(target.id);
          if (session?.id === target.id) newChat();
          tui.print(existed ? `Sessão ${target.id} apagada.` : `Sessão ${target.id} não existia no disco.`, existed ? FG.ok : FG.warn);
        }
        return handleCommand('/resume');
      }

      if (action === 'rename') {
        const target = sessions.find((s) => s.id === pick);
        const title = await tui.ask('Renomear sessão:', target.title);
        if (title) {
          target.title = title;
          if (session?.id === target.id) session.title = title;
          saveSession(target, { immediate: true });
          tui.print(`Sessão renomeada para "${title}".`, FG.ok);
        }
        return handleCommand('/resume');
      }

      // flush do que estava pendente antes de trocar de sessão
      flushSessions();

      // Relê do disco: a lista pode estar velha e a memória pode ter mais
      // mensagens que o arquivo (aí retomar "encolhia" o chat).
      const fromDisk = readSession(sessionFile(pick));
      const fromList = sessions.find((s) => s.id === pick);
      const diskMsgs = fromDisk?.messages?.length || 0;
      const listMsgs = fromList?.messages?.length || 0;
      session = diskMsgs >= listMsgs ? fromDisk || fromList : fromList;

      if (fromList?.corrupt) {
        tui.print(
          fromList.recoverable
            ? 'Esta sessão estava corrompida; recuperei a versão do backup.'
            : 'Esta sessão está corrompida e não tem backup válido.',
          fromList.recoverable ? FG.warn : FG.err,
        );
      }
      renderHistory();
      emit('session:change', { id: session.id });
      tui.print(`Sessão ${session.id} retomada (${session.messages.length - 1} mensagens).`, FG.ok);
      return;
    }

    default:
      return tui.print(`Comando desconhecido: ${cmd}. Use /help`, FG.err);
  }
}

async function login() {
  const choice = await tui.select('Tipo de provedor', [
    ...Object.entries(PROVIDER_PRESETS).map(([k, v]) => ({ label: v.label, value: k })),
    { label: 'Custom (OpenAI-compatível)', value: 'custom' },
    { label: 'Custom (Anthropic-compatível)', value: 'custom-anthropic' },
  ]);
  if (!choice) return;

  const preset = PROVIDER_PRESETS[choice];
  const isCustom = choice.startsWith('custom');
  const name = isCustom ? await tui.ask('Nome do provedor:') : choice;
  if (!name) return;
  const baseUrl = isCustom ? await tui.ask('Base URL (ex: https://host/v1):') : preset.baseUrl;
  const apiKey = await tui.ask(preset?.noKey ? 'API key (Enter para vazio):' : 'API key:');

  cfg.providers[name] = {
    type: choice.endsWith('anthropic') ? 'anthropic' : preset?.type || 'openai',
    baseUrl: baseUrl || preset?.baseUrl || '',
    apiKey: apiKey || '',
    defaultModel: null,
    models: [],
  };
  cfg.active = name;
  saveConfig(cfg);
  if (!session) newChat();

  await syncProvider(name);
  await pickDefaultModel(name);
  refreshStatus();
  tui.draw();
}

/* ---------------- ciclo de vida ---------------- */

function shutdown() {
  try {
    // grava a sessão atual e TUDO que estava agrupado, de forma síncrona
    if (session) saveSession(session, { immediate: true });
    flushSessions();
  } catch (err) {
    logDebug(`shutdown flush: ${err.message}`);
  }
  tui.stop();
  process.exit(0);
}

export async function run() {
  tui.onSubmit = async (text) => {
    const t = text.trim();
    if (!t) return;
    if (busy) {
      queue.push(t);
      refreshStatus();
      return tui.print(`+ fila (${queue.length}): ${t}`, FG.dim);
    }
    dispatch(t).catch((err) => {
      busy = false;
      tui.setBusy('');
      tui.print(`Erro inesperado: ${err.message}`, FG.err);
      logDebug(`dispatch: ${err.stack || err.message}`);
    });
  };

  tui.onCtrlC = (force) => {
    if (force) return shutdown();
    // Rodando (stream da IA ou tool como bash/loop): interrompe de imediato.
    // Não exige abortCtl: entre passos ele fica nulo por um instante, mas o
    // flag `interrupting` já garante que o turno não continua.
    if (busy) {
      interruptTurn();
      tui.setBusy('interrompendo');
      return;
    }
    const now = Date.now();
    if (now - lastCtrlC < 1500) return shutdown();
    lastCtrlC = now;
    tui.print('Pressione Ctrl+C de novo para sair (ou /quit).', FG.dim);
  };

  tui.onEsc = () => {
    if (busy) {
      interruptTurn();
      tui.setBusy('interrompendo');
    }
  };

  tui.onCtrlD = () => {
    tui.print('Ctrl+D só apaga sessões dentro do /resume. Para sair use /quit.', FG.dim);
  };

  tui.onCycleThinking = () => {
    const i = THINK_LEVELS.indexOf(cfg.thinking);
    setThinking(THINK_LEVELS[(i + 1) % THINK_LEVELS.length]);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('SIGINT', shutdown);
  // último recurso: se algo escapar, grava o que estiver pendente
  process.on('exit', () => {
    try {
      if (hasPending()) flushSessions();
    } catch {}
  });
  tui.start();
  try {
    pruneInstances(); // limpa pastas de instâncias mortas antigas
  } catch {}
  try {
    // Unifica sessões que ficaram espalhadas pelas instâncias antigas (a mesma
    // sessão com 35/124/162 mensagens). Fica com a versão de maior histórico.
    const heal = healSessions();
    if (heal.written) {
      tui.print(`Reparei ${heal.written} sessão(ões) com histórico divergente de abas antigas.`, FG.dim);
    }
    if (heal.purged) {
      tui.print(`Limpei ${heal.purged} cópia(s) de sessão(ões) que você apagou.`, FG.dim);
    }
  } catch (err) {
    logDebug(`healSessions: ${err.message}`);
  }
  catalog = await loadCatalog();

  newChat();
  await loadPlugins();
  const mcpStates = await startMcp();
  const failed = mcpStates.filter((s) => s.status !== 'ok');
  if (failed.length) tui.print(`MCP: ${failed.length} servidor(es) com erro. Use /mcp.`, FG.warn);
  const pluginCmds = pluginCommandList();
  if (pluginCmds.length) tui.print(`Plugins: ${pluginCmds.length} comando(s) disponíveis.`, FG.dim);

  if (!Object.keys(cfg.providers).length) {
    tui.print('Bem-vindo ao Kiro Code! Vamos configurar um provedor.', FG.accent);
    await login();
  } else {
    if (!cfg.active || !cfg.providers[cfg.active]) cfg.active = Object.keys(cfg.providers)[0];
    tui.print(
      'Digite uma mensagem ou /help. Clique numa caixa de tool (ou Ctrl+O) para expandir, Shift+Tab ciclo do thinking, ESC interrompe.',
      FG.dim,
    );
  }
  refreshStatus();
  tui.draw();
}
