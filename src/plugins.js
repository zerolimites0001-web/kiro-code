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

function makeApi(rec) {
  const state = readState();
  const dataDir = path.join(DATA_DIR, rec.name);
  fs.mkdirSync(dataDir, { recursive: true });
  rec.offs = [];

  return {
    /** Ferramenta para o agente: o nome final é plug__<plugin>__<nome> */
    tool(def) {
      const name = `plug__${rec.name}__${def.schema.name}`;
      registerTool({ schema: { ...def.schema, name }, run: def.run });
      rec.tools.add(name);
    },

    /** Comando /nome. run(args) recebe o texto depois do comando */
    command(name, def) {
      const cmd = name.startsWith('/') ? name : `/${name}`;
      commands.set(cmd, { owner: rec.name, description: def.description || '', run: def.run });
      rec.commands.add(cmd);
    },

    /** Área ao vivo na TUI. render() devolve linhas e a TUI redesenha a cada segundo */
    widget(id, def) {
      const key = `${rec.name}:${id}`;
      rec.widgets.add(key);
      host?.tui.setWidget(key, { render: def.render });
    },

    print: (text, color) => host?.tui.print(text, color),

    on(evt, fn) {
      rec.offs.push(on(evt, fn));
    },

    emit: (evt, data) => emit(evt, data),

    config: { ...(rec.manifest?.config || {}), ...(state.config[rec.name] || {}) },

    dataDir,

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
