import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HOME, logDebug } from './store.js';
import { registerTool, unregisterTools } from './tools.js';

/**
 * ~/.kiro/plugins/
 *   timer.js                    plugin de arquivo único
 *   agent-kit/plugin.json       plugin de pasta: { name, version, main, permissions, config }
 *   agent-kit/main.js           arquivo de entrada (export default { name, setup, teardown })
 *
 * ~/.kiro/plugins.json          { approved: { nome: hash }, disabled: [nome], config: { nome: {...} } }
 * ~/.kiro/plugin-data/<nome>/   pasta de dados de cada plugin
 *
 * Plugins só carregam depois de aprovados. O hash cobre todos os arquivos do plugin:
 * se qualquer arquivo mudar, o plugin volta a "pendente" até ser aprovado de novo.
 */

const PLUGIN_DIR = path.join(HOME, 'plugins');
const STATE_FILE = path.join(HOME, 'plugins.json');
const DATA_DIR = path.join(HOME, 'plugin-data');

const plugins = new Map(); // nome -> registro
const listeners = new Map(); // evento -> Set<fn>
const commands = new Map(); // '/cmd' -> { owner, description, run }
let host = null; // { tui }

export function setHost(h) {
  host = h;
}

/* ---------------- estado ---------------- */

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { approved: s.approved || {}, disabled: s.disabled || [], config: s.config || {} };
  } catch {
    return { approved: {}, disabled: [], config: {} };
  }
}

function writeState(s) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/* ---------------- eventos ---------------- */

export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) {
    try {
      fn(data);
    } catch (err) {
      logDebug(`evento ${evt}: ${err.message}`);
    }
  }
}

function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}

/* ---------------- descoberta e hash ---------------- */

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function discover() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const found = [];
  for (const e of fs.readdirSync(PLUGIN_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(PLUGIN_DIR, e.name);
    if (e.isFile() && e.name.endsWith('.js')) {
      found.push({ name: e.name.replace(/\.js$/, ''), dir: PLUGIN_DIR, entry: full, files: [full], manifest: {} });
    } else if (e.isDirectory()) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(full, 'plugin.json'), 'utf8'));
        const entry = path.join(full, manifest.main || 'main.js');
        found.push({ name: manifest.name || e.name, dir: full, entry, files: walk(full), manifest });
      } catch (err) {
        found.push({ name: e.name, error: `pasta sem plugin.json válido (${err.message})` });
      }
    }
  }
  return found;
}

function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.basename(f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

/* ---------------- API entregue a cada plugin ---------------- */

// Timer registrado por um plugin (auto-limpo no teardown)
function registerTimer(rec, id, on) {
  rec.timers.add(id);
  return () => { clearInterval(id); clearTimeout(id); rec.timers.delete(id); };
}

function makeApi(rec) {
  const state = readState();
  const dataDir = path.join(DATA_DIR, rec.name);
  fs.mkdirSync(dataDir, { recursive: true });
  rec.offs = [];
  if (!rec.timers) rec.timers = new Set();

  // config efetiva (manifest defaults + estado salvo). `set` persiste no plugs.json
  const effectiveConfig = { ...(rec.manifest?.config || {}), ...(state.config[rec.name] || {}) };

  return {
    /** Ferramenta para o agente: o nome final é plug__<plugin>__<nome> */
    tool(def) {
      const name = `plug__${rec.name}__${def.schema.name}`;
      registerTool({ schema: { ...def.schema, name }, run: def.run });
      rec.tools.add(name);
    },

    /** Comando /nome. run(args, ctx) recebe o texto depois do comando + contexto */
    command(name, def) {
      const cmd = name.startsWith('/') ? name : `/${name}`;
      commands.set(cmd, {
        owner: rec.name,
        description: def.description || '',
        run: def.run,
      });
      rec.commands.add(cmd);
    },

    /** Área ao vivo na TUI. render() devolve linhas; `interval` ms (>=250) opcional */
    widget(id, def) {
      const key = `${rec.name}:${id}`;
      rec.widgets.add(key);
      host?.tui.setWidget(key, {
        render: def.render,
        interval: Number.isFinite(def.interval) ? Math.max(250, def.interval) : undefined,
      });
    },

    /** Escreve no histórico da TUI. `color` aceita um código ANSI ou nome */
    print: (text, color) => host?.tui.print(text, color || ''),

    /** Assina um evento. A assinatura é removida pelo loader no cleanup */
    on(evt, fn) {
      rec.offs.push(on(evt, fn));
    },

    /** Emite um evento para os plugins carregados */
    emit: (evt, data) => emit(evt, data),

    /** Timer seguro: auto-limpo no teardown/reload */
    interval(fn, ms) {
      const id = setInterval(() => { try { fn(); } catch (e) { logDebug(`[plugin ${rec.name}] interval: ${e.message}`); } }, Math.max(16, ms));
      return registerTimer(rec, id, true);
    },
    timeout(fn, ms) {
      const id = setTimeout(() => { try { fn(); } catch (e) { logDebug(`[plugin ${rec.name}] timeout: ${e.message}`); } }, Math.max(0, ms));
      return registerTimer(rec, id, false);
    },

    /** Configuração efetiva do plugin (readonly-ish). Use configSet para gravar */
    get config() { return { ...effectiveConfig }; },
    /** Grava uma chave de configuração do plugin (persistente em plugins.json) */
    configSet(key, value) {
      const s = readState();
      s.config[rec.name] = { ...(s.config[rec.name] || {}), [key]: value };
      writeState(s);
      effectiveConfig[key] = value;
    },

    /** Diretório de dados persistente do plugin no HOME lógico */
    dataDir,

    /** Roteador HTTP leve? Não — utilitários de dados: */
    data: {
      read(name, fallback = null) {
        try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); }
        catch { return fallback; }
      },
      write(name, value) {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
      },
      file(name) { return path.join(dataDir, name); },
    },

    /** Lista de plugins carregados: [{name, version, status}] */
    plugins: () => [...plugins.values()].map((p) => ({ name: p.name, version: p.version, status: p.status })),

    /** Log de depuração no debug.log local */
    log: (msg) => logDebug(`[plugin ${rec.name}] ${msg}`),
  };
}

/* ---------------- ativar e desativar ---------------- */

function cleanup(rec) {
  unregisterTools(`plug__${rec.name}__`);
  for (const cmd of rec.commands) commands.delete(cmd);
  rec.commands.clear();
  for (const key of rec.widgets) host?.tui.removeWidgets(key);
  rec.widgets.clear();
  for (const off of rec.offs || []) off();
  rec.offs = [];
  // limpa timers registrados via kiro.interval/timeout
  for (const t of rec.timers || []) { clearInterval(t); clearTimeout(t); }
  rec.timers?.clear();
  rec.tools.clear();
}

async function activate(rec) {
  try {
    const mod = await import(`${pathToFileURL(rec.entry).href}?v=${Date.now()}`);
    const plugin = mod.default;
    if (!plugin || typeof plugin.setup !== 'function') {
      throw new Error('export default precisa ter setup(kiro)');
    }
    rec.instance = plugin;
    if (plugin.version) rec.version = plugin.version;
    if (plugin.description && !rec.description) rec.description = plugin.description;
    await plugin.setup(makeApi(rec));
    rec.status = 'ativo';
    rec.error = null;
  } catch (err) {
    cleanup(rec);
    rec.status = 'erro';
    rec.error = err.message;
    logDebug(`plugin ${rec.name}: ${err.message}`);
  }
}

async function deactivate(rec) {
  try {
    await rec.instance?.teardown?.();
  } catch (err) {
    logDebug(`teardown ${rec.name}: ${err.message}`);
  }
  cleanup(rec);
  rec.instance = null;
}

/* ---------------- carregamento ---------------- */

export async function loadPlugins() {
  const state = readState();
  for (const d of discover()) {
    if (d.error) {
      plugins.set(d.name, { name: d.name, status: 'erro', error: d.error, commands: new Set(), tools: new Set(), widgets: new Set() });
      continue;
    }
    const rec = {
      name: d.name,
      version: d.manifest.version || '0.0.0',
      description: d.manifest.description || '',
      permissions: d.manifest.permissions || [],
      entry: d.entry,
      dir: d.dir,
      manifest: d.manifest,
      files: d.files,
      hash: hashOf(d.files),
      status: 'pendente',
      error: null,
      commands: new Set(),
      tools: new Set(),
      widgets: new Set(),
      timers: new Set(),
      offs: [],
    };
    plugins.set(d.name, rec);

    if (state.disabled.includes(d.name)) rec.status = 'desativado';
    else if (state.approved[d.name] !== rec.hash) rec.status = 'pendente';
    else await activate(rec);
  }
}

/* ---------------- comandos /plugins ---------------- */

export function getPluginCommand(cmd) {
  return commands.get(cmd);
}

export function pluginCommandList() {
  return [...commands.entries()].map(([cmd, c]) => ({ cmd, owner: c.owner, description: c.description }));
}

const COLORS = { ativo: '\x1b[38;5;114m', pendente: '\x1b[38;5;221m', desativado: '\x1b[38;5;244m', erro: '\x1b[38;5;203m' };

/** Executa /plugins [lista|reload|approve|on|off] e devolve linhas para imprimir */
export async function pluginsCommand(args) {
  const [sub, name] = args.trim().split(/\s+/);
  const state = readState();
  const out = [];

  if (!sub || sub === 'lista') {
    if (!plugins.size) out.push(['Nenhum plugin em ~/.kiro/plugins/', '\x1b[38;5;244m']);
    for (const rec of plugins.values()) {
      const color = COLORS[rec.status] || '';
      const cmds = [...rec.commands].join(' ');
      const perms = rec.permissions?.length ? ` · permissões: ${rec.permissions.join(', ')}` : '';
      out.push([`${rec.name} ${rec.version}  [${rec.status}]${perms}`, color]);
      if (rec.description) out.push([`   ${rec.description}`, '\x1b[38;5;244m']);
      if (cmds) out.push([`   comandos: ${cmds}`, '\x1b[38;5;117m']);
      if (rec.status === 'pendente') out.push([`   aprovar: /plugins approve ${rec.name}`, '\x1b[38;5;221m']);
      if (rec.status === 'erro' && rec.error) out.push([`   erro: ${rec.error}`, COLORS.erro]);
    }
    return out;
  }

  if (sub === 'reload') {
    for (const rec of plugins.values()) if (rec.instance) await deactivate(rec);
    plugins.clear();
    await loadPlugins();
    return [[`Plugins recarregados: ${plugins.size}.`, COLORS.ativo]];
  }

  const rec = plugins.get(name);
  if (!rec) return [[`Plugin "${name}" não encontrado.`, COLORS.erro]];

  if (sub === 'approve') {
    state.approved[name] = rec.hash;
    state.disabled = state.disabled.filter((n) => n !== name);
    writeState(state);
    await activate(rec);
    return [[`${name} aprovado (${rec.status}).`, COLORS.ativo]];
  }

  if (sub === 'off') {
    if (!state.disabled.includes(name)) state.disabled.push(name);
    writeState(state);
    await deactivate(rec);
    rec.status = 'desativado';
    return [[`${name} desativado.`, COLORS.desativado]];
  }

  if (sub === 'on') {
    state.disabled = state.disabled.filter((n) => n !== name);
    writeState(state);
    if (state.approved[name] === rec.hash) await activate(rec);
    else rec.status = 'pendente';
    return [[`${name} ${rec.status}.`, COLORS[rec.status] || '']];
  }

  return [['Uso: /plugins [lista|reload|approve <nome>|on <nome>|off <nome>]', COLORS.erro]];
}

export const pluginsDir = PLUGIN_DIR;
