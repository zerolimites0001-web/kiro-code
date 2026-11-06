import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveInstance, GLOBAL_HOME } from './instance.js';

/**
 * HOME lógico desta instância do Kiro. Cada `kiro` aberto em uma aba ganha o
 * seu próprio diretório (~/.kiro/instances/<id>/) — config, models e plugins
 * deixam de se misturar entre abas. Desative com KIRO_NO_ISOLATE=1.
 *
 * SESSÕES SÃO EXCEÇÃO: elas ficam em ~/.kiro/sessions, COMPARTILHADAS.
 * Motivo (bug real): quando cada instância tinha a sua cópia, a mesma sessão
 * virava N arquivos congelados — a aba A continuava de 162 mensagens, a aba B
 * de 124, e o "oficial" ficava em 35. Resultado: "metade do chat some".
 * A escrita concorrente é resolvida com write atômico + merge por prefixo
 * (ver writeSession). Diretório alternativo: KIRO_SESSIONS_DIR.
 */
const INSTANCE = resolveInstance();
export const HOME = INSTANCE.home;
export const INSTANCE_ID = INSTANCE.id;
export const ISOLATED = INSTANCE.isolated;

const CONFIG = path.join(HOME, 'config.json'); // active, thinking
const MODELS = path.join(HOME, 'models.json'); // providers + models (formato do Pi)
export const SESSIONS = process.env.KIRO_SESSIONS_DIR
  ? path.resolve(process.env.KIRO_SESSIONS_DIR)
  : path.join(GLOBAL_HOME, 'sessions');
const INSTANCES_DIR = path.join(GLOBAL_HOME, 'instances');

/** Registro persistente de sessões apagadas (tombstones). */
const DELETED = path.join(GLOBAL_HOME, 'deleted.json');

fs.mkdirSync(SESSIONS, { recursive: true });

/* ---------------- IO seguro ---------------- */

/**
 * Lê JSON. Em caso de arquivo corrompido tenta o `.bak` — é isso que impede
 * uma sessão de "sumir" depois de um kill no meio da gravação.
 */
const readJson = (f) => {
  for (const file of [f, `${f}.bak`]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  return null;
};

/** true se o arquivo existe e é JSON válido */
function validJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Gravação ATÔMICA: escreve num tmp, dá fsync, faz backup do atual válido e só
 * então renomeia (rename no mesmo fs é atômico). Assim nunca existe um JSON
 * pela metade no caminho final — o pior caso é o `.tmp` órfão.
 */
export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const data = JSON.stringify(obj, null, 2);

  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd); // garante que os bytes chegaram no disco antes do rename
  } finally {
    fs.closeSync(fd);
  }

  try {
    if (fs.existsSync(file) && validJson(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {}

  fs.renameSync(tmp, file);

  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {}
}

const normModel = (m) => (typeof m === 'string' ? { id: m } : { ...m });

/**
 * Carrega provedores de ~/.kiro/models.json (formato Pi):
 *   { "providers": { "nome": { baseUrl, api, apiKey, defaultModel?, models: [{ id, name, reasoning, input, contextWindow, maxTokens }] } } }
 * Se não existir, migra do formato antigo do config.json.
 */
export function loadConfig() {
  const base = readJson(CONFIG) || {};
  const pi = readJson(MODELS);
  const providers = {};

  if (pi?.providers) {
    for (const [name, v] of Object.entries(pi.providers)) {
      const models = (v.models || []).map(normModel);
      providers[name] = {
        type: v.api === 'anthropic-messages' ? 'anthropic' : 'openai',
        baseUrl: v.baseUrl || '',
        apiKey: v.apiKey || '',
        defaultModel: v.defaultModel || models[0]?.id || null,
        models,
      };
    }
  } else if (base.providers) {
    for (const [name, v] of Object.entries(base.providers)) {
      const ids = [...new Set([...(v.models || []), v.model].filter(Boolean))];
      const models = ids.map(normModel);
      providers[name] = {
        type: v.type || 'openai',
        baseUrl: v.baseUrl || '',
        apiKey: v.apiKey || '',
        defaultModel: v.model || models[0]?.id || null,
        models,
      };
    }
  }

  return { active: base.active ?? null, thinking: base.thinking ?? 'minimal', providers };
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  writeJsonAtomic(CONFIG, { active: cfg.active, thinking: cfg.thinking });

  const providers = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    providers[name] = {
      baseUrl: p.baseUrl,
      api: p.type === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      apiKey: p.apiKey || '',
      defaultModel: p.defaultModel || null,
      models: p.models || [],
    };
  }
  writeJsonAtomic(MODELS, { providers });

  // Propaga para o ~/.kiro legado para que novas instâncias (novos PIDs) adotem
  // o provedor/modelo correto em vez de voltar sempre para o nvidia antigo.
  try {
    const globalHome = path.join(os.homedir(), '.kiro');
    fs.mkdirSync(globalHome, { recursive: true });
    writeJsonAtomic(path.join(globalHome, 'config.json'), { active: cfg.active, thinking: cfg.thinking });
    writeJsonAtomic(path.join(globalHome, 'models.json'), { providers });
  } catch {}
}

export function newSession(meta) {
  return {
    id: crypto.randomUUID().slice(0, 8),
    title: 'nova sessão',
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider: meta.provider,
    model: meta.model,
    rev: 0,
    messages: [],
  };
}

/* ---------------- sessões ---------------- */

export const sessionFile = (id) => path.join(SESSIONS, `${id}.json`);

/** Lê uma sessão do disco (com fallback para o .bak) */
export function readSession(file) {
  const d = readJson(file);
  return d && Array.isArray(d.messages) ? d : null;
}

/** Quantas mensagens "de conteúdo" (sem o system) a sessão tem */
const bodyLen = (msgs) => Math.max(0, (msgs || []).length - ((msgs || [])[0]?.role === 'system' ? 1 : 0));

/**
 * Compara duas listas de mensagens ignorando o system (que muda conforme o cwd).
 * Devolve o número de mensagens idênticas no prefixo, ou -1 se divergem antes.
 */
function commonPrefix(a, b) {
  const sa = a[0]?.role === 'system' ? 1 : 0;
  const sb = b[0]?.role === 'system' ? 1 : 0;
  const n = Math.min(a.length - sa, b.length - sb);
  for (let i = 0; i < n; i++) {
    const x = a[sa + i];
    const y = b[sb + i];
    if (x.role !== y.role) return -1;
    if (String(x.content ?? '') !== String(y.content ?? '')) return -1;
    if ((x.tool_calls?.length || 0) !== (y.tool_calls?.length || 0)) return -1;
  }
  return n;
}

/**
 * Grava a sessão resolvendo concorrência entre abas.
 * Se o disco tem uma versão que é EXTENSÃO da nossa (outra aba avançou), o
 * disco ganha — antes a nossa memória sobrescrevia e apagava o que a outra aba
 * tinha acabado de gravar. Se a nossa é a extensão, a nossa ganha.
 */
function writeSession(s) {
  const file = sessionFile(s.id);
  const disk = readSession(file);
  let out = s;

  if (disk) {
    const sBody = bodyLen(s.messages);
    const dBody = bodyLen(disk.messages);
    const common = commonPrefix(s.messages, disk.messages);
    const isPrefix = common >= 0 && (common === sBody || common === dBody);

    if (isPrefix && dBody > sBody) {
      logDebug(`save ${s.id}: disco tem mais (${dBody} > ${sBody}) — mantendo disco`);
      out = { ...disk, updatedAt: new Date().toISOString() };
      // a memória desta aba fica desatualizada: avisa quem chamou
      s._stale = true;
    } else if (!isPrefix && common < 0 && dBody > sBody) {
      // históricos divergentes e o disco é maior: não destruir o maior
      logDebug(`save ${s.id}: divergente, disco maior (${dBody} > ${sBody}) — mantendo disco`);
      out = { ...disk, updatedAt: new Date().toISOString() };
      s._stale = true;
    } else if (disk.title && disk.title !== 'nova sessão' && (!s.title || s.title === 'nova sessão')) {
      out = { ...s, title: disk.title };
    }
  }

  out.rev = (out.rev || 0) + 1;
  writeJsonAtomic(file, out);
  return out;
}

/* Debounce: o turno chama persist() a cada tool result. Sem isso eram dezenas de
 * writes de centenas de KB por turno. Os pontos críticos chamam flush imediato. */
const pending = new Map();
let flushTimer = null;

/** Agenda a gravação da sessão. `immediate` grava agora (shutdown, fim de turno). */
export function saveSession(s, { immediate = false } = {}) {
  if (!s || !Array.isArray(s.messages)) return false;
  if (!s.messages.some((m) => m.role === 'user')) return false; // sessão vazia não vai pro disco
  s.updatedAt = new Date().toISOString();
  pending.set(s.id, s);
  if (immediate) {
    flushSessions();
    return !s._stale;
  }
  if (!flushTimer) flushTimer = setTimeout(flushSessions, 400);
  flushTimer.unref?.();
  return true;
}

/** Grava agora tudo que está pendente. Chamado no shutdown e nos handlers de sinal. */
export function flushSessions() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  let n = 0;
  for (const [id, s] of [...pending]) {
    try {
      writeSession(s);
      n++;
    } catch (err) {
      logDebug(`save ${id} falhou: ${err.message}`);
    }
  }
  pending.clear();
  return n;
}

/** Há algo não gravado? (usado para decidir se vale escrever no exit) */
export const hasPending = () => pending.size > 0;

export function deleteSession(id) {
  const file = sessionFile(id);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  for (const suf of ['.bak', '.pre-compact']) fs.rmSync(`${file}${suf}`, { force: true });
  // tmp órfãos desta sessão
  try {
    for (const f of fs.readdirSync(SESSIONS)) {
      if (f.startsWith(`${id}.json.tmp-`)) fs.rmSync(path.join(SESSIONS, f), { force: true });
    }
  } catch {}
  // CÓPIAS em pastas de instâncias antigas: se ficarem lá, o healSessions do
  // próximo start recria a sessão apagada ("apago e ela volta"). Roda as cópias.
  purgeSessionCopies(id);
  // Tombstone: o healSessions consulta isto e NUNCA ressuscita o que foi apagado.
  markDeleted(id);
  pending.delete(id);
  logDebug(`delete ${id} existed=${existed} exists_now=${fs.existsSync(file)}`);
  return existed;
}

/** Marca a sessão como apagada para o healSessions não ressuscitá-la. */
function markDeleted(id) {
  try {
    const cur = readJson(DELETED) || {};
    cur[id] = new Date().toISOString();
    writeJsonAtomic(DELETED, cur);
  } catch (err) {
    logDebug(`markDeleted ${id}: ${err.message}`);
  }
}

/** IDs marcados como apagados. */
function deletedIds() {
  return readJson(DELETED) || {};
}

/** Remove cópias da sessão (json + .bak) nas pastas de todas as instâncias. */
function purgeSessionCopies(id) {
  let dirs = [];
  try {
    dirs = fs.existsSync(INSTANCES_DIR)
      ? fs.readdirSync(INSTANCES_DIR).map((i) => path.join(INSTANCES_DIR, i, 'sessions'))
      : [];
  } catch {}
  const own = path.join(HOME, 'sessions');
  if (own !== SESSIONS) dirs.push(own);
  for (const dir of dirs) {
    for (const suf of ['.json', '.json.bak', '.json.pre-compact']) {
      try {
        fs.rmSync(path.join(dir, `${id}${suf}`), { force: true });
      } catch {}
    }
  }
}

/** Banner curto da instância, para o cabeçalho/status não misturar abas. */
export function instanceLabel() {
  return ISOLATED ? `#${INSTANCE_ID}` : '(compartilhado)';
}

export function logDebug(msg) {
  try {
    fs.appendFileSync(path.join(HOME, 'debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/**
 * Lista as sessões. Arquivo corrompido NÃO é descartado: aparece marcado, para
 * o usuário poder apagar/recuperar. Antes ele simplesmente desaparecia da
 * lista — era o "não salva direito e o conteúdo some".
 */
export function listSessions() {
  const out = [];
  const dead = deletedIds();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (dead[id]) continue; // apagada — não reaparece na lista
    const full = path.join(SESSIONS, f);
    const d = readJson(full);
    if (d && Array.isArray(d.messages)) {
      out.push(d);
    } else {
      const bak = readJson(`${full}.bak`);
      out.push({
        id,
        title: bak ? `(recuperável) ${bak.title || id}` : '(arquivo corrompido)',
        updatedAt: bak?.updatedAt || new Date(0).toISOString(),
        createdAt: bak?.createdAt || new Date(0).toISOString(),
        cwd: bak?.cwd || '',
        provider: bak?.provider || null,
        model: bak?.model || null,
        rev: bak?.rev || 0,
        messages: bak?.messages || [],
        corrupt: true,
        recoverable: !!bak,
      });
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Repara o histórico de sessões espalhadas por instâncias antigas.
 *
 * Antes cada instância copiava as sessões para o seu próprio diretório e
 * seguia escrevendo na cópia — a mesma sessão acabava com versões diferentes
 * (35 / 124 / 162 mensagens) e "metade do chat sumia". Aqui todas as cópias são
 * unificadas em SESSIONS, sempre ficando com a versão de MAIOR histórico.
 * Idempotente.
 */
export function healSessions() {
  const fixed = [];
  const sources = [];
  const dead = deletedIds(); // tombstones: o que foi apagado nunca volta
  try {
    if (fs.existsSync(INSTANCES_DIR)) {
      for (const inst of fs.readdirSync(INSTANCES_DIR)) {
        const dir = path.join(INSTANCES_DIR, inst, 'sessions');
        if (fs.existsSync(dir)) sources.push(dir);
      }
    }
  } catch {}
  // cópias órfãs que ficaram dentro do próprio HOME da instância
  const own = path.join(HOME, 'sessions');
  if (own !== SESSIONS && fs.existsSync(own)) sources.push(own);

  const best = new Map(); // id -> melhor sessão vista
  let purged = 0;
  const consider = (s) => {
    if (!s || !Array.isArray(s.messages) || !s.id) return;
    const prev = best.get(s.id);
    if (!prev || bodyLen(s.messages) > bodyLen(prev.messages)) best.set(s.id, s);
  };

  // Varre uma pasta de cópias. Sessão com tombstone é REMOVIDA de lá (não
  // ressuscita); sessão ativa é considerada para unificação.
  const scanDir = (dir) => {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json') && !f.endsWith('.json.bak')) continue;
      const full = path.join(dir, f);
      const id = f.replace(/\.json(\.bak)?$/, '');
      if (dead[id]) {
        try {
          fs.rmSync(full, { force: true });
          purged++;
        } catch {}
        continue;
      }
      const s = readJson(full);
      if (!s || !Array.isArray(s.messages) || !s.id) continue;
      const prev = best.get(s.id);
      if (!prev || bodyLen(s.messages) > bodyLen(prev.messages)) {
        best.set(s.id, s);
        fixed.push({ id: s.id, from: full, msgs: bodyLen(s.messages) });
      }
    }
  };

  // A sessão oficial também pode ter tombstone (apagada, mas o .bak sobrou).
  for (const f of fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS) : []) {
    const id = f.replace(/\.json(\.bak)?$/, '');
    if (dead[id]) {
      try {
        fs.rmSync(path.join(SESSIONS, f), { force: true });
        purged++;
      } catch {}
      continue;
    }
    if (f.endsWith('.json')) consider(readJson(path.join(SESSIONS, f)));
    if (f.endsWith('.json.bak')) consider(readJson(path.join(SESSIONS, f)));
  }
  for (const dir of sources) scanDir(dir);

  let written = 0;
  for (const [id, s] of best) {
    if (dead[id]) continue;
    const file = sessionFile(id);
    const current = readSession(file);
    if (current && bodyLen(current.messages) >= bodyLen(s.messages)) continue;
    try {
      writeJsonAtomic(file, s);
      written++;
    } catch (err) {
      logDebug(`heal ${id}: ${err.message}`);
    }
  }
  if (written || purged) logDebug(`healSessions: ${written} unificada(s), ${purged} cópia(s) apagada(s)`);
  return { written, purged, sources: sources.length, repaired: fixed };
}

/** Cópia de segurança antes de uma operação destrutiva (ex: /compact). */
export function backupSession(s, tag = 'pre-compact') {
  try {
    if (!s?.id) return null;
    const file = sessionFile(s.id);
    if (!fs.existsSync(file)) writeJsonAtomic(file, s);
    const dest = `${file}.${tag}`;
    fs.copyFileSync(file, dest);
    return dest;
  } catch (err) {
    logDebug(`backup ${tag} falhou: ${err.message}`);
    return null;
  }
}

/** Lê SYSTEM.md (global ~/.kiro e projeto) e AGENTS.md (projeto e pais) */
export function buildSystemPrompt(cwd) {
  const parts = [];
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return null;
    }
  };

  // SYSTEM.md global mora no ~/.kiro COMPARTILHADO (não no HOME por-instância):
  // a política do operador é a mesma em todas as abas.
  const globalSys = read(path.join(GLOBAL_HOME, 'SYSTEM.md'));
  const projectSys = read(path.join(cwd, 'SYSTEM.md'));
  if (globalSys) parts.push(`# SYSTEM.md (global)\n${globalSys}`);
  if (projectSys) parts.push(`# SYSTEM.md (projeto)\n${projectSys}`);

  const agents = [];
  let dir = cwd;
  while (true) {
    const a = read(path.join(dir, 'AGENTS.md'));
    if (a) agents.unshift(`## ${path.join(dir, 'AGENTS.md')}\n${a}`);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (agents.length) parts.push(`# AGENTS.md\n${agents.join('\n\n')}`);

  const base = `Você é o Kiro Code, um agente de programação no terminal.
Diretório de trabalho: ${cwd}
Sistema: ${os.type()} ${os.release()} (${os.arch()})
Use as ferramentas (bash, read_file, write_file, edit_file, loop) para agir de verdade.
Responda em português, de forma direta.`;

  return [base, ...parts].join('\n\n');
}