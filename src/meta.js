import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './store.js';
import { THINK_LEVELS } from './providers.js';

/**
 * Metadados por modelo (mesmos nomes do models.json do Pi):
 *   contextWindow, maxTokens, reasoning, input: ["text"] | ["text","image"]
 *
 * Prioridade (cada campo):
 *   1. valor gravado no próprio modelo em models.json (manual ou já sincronizado)
 *   2. models.dev, casado pelo provedor (nome ou host do endpoint) e pelo id exato
 *   3. padrões do Pi: 128000 de contexto, 16384 de saída, sem reasoning, só texto
 */

export const PI_DEFAULTS = { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ['text'] };

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE = path.join(HOME, 'models-dev.json');
const MAX_AGE = 24 * 3600 * 1000;

export async function loadCatalog({ force = false } = {}) {
  if (!force) {
    try {
      const st = await fs.stat(CACHE);
      if (Date.now() - st.mtimeMs < MAX_AGE) return JSON.parse(await fs.readFile(CACHE, 'utf8'));
    } catch {}
  }
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    await fs.mkdir(HOME, { recursive: true });
    await fs.writeFile(CACHE, JSON.stringify(json));
    return json;
  } catch {
    try {
      return JSON.parse(await fs.readFile(CACHE, 'utf8'));
    } catch {
      return {};
    }
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

/** Acha o id do provedor no catálogo: pelo nome, ou pelo host do endpoint (campo api) */
function catalogProviderId(catalog, name, baseUrl, alias) {
  // alias: id do provedor no models.dev a usar quando o endpoint não está lá (ex: "openai")
  if (alias && catalog[alias]) return alias;
  if (name && catalog[name]) return name;
  const host = hostOf(baseUrl);
  if (!host) return null;
  for (const pid of Object.keys(catalog)) {
    if (catalog[pid]?.api && hostOf(catalog[pid].api) === host) return pid;
  }
  return null;
}

/** Metadados do modelo no catálogo, só dentro do mesmo provedor (sem chutar outro) */
export function catalogModel(catalog, name, baseUrl, id, alias) {
  const pid = catalogProviderId(catalog, name, baseUrl, alias);
  if (!pid) return null;
  const m = catalog[pid].models?.[id];
  return m || null;
}

/** Converte um modelo do models.dev para os campos do models.json do Pi */
export function fromCatalog(m) {
  const input = m.modalities?.input?.length ? m.modalities.input : m.attachment ? ['text', 'image'] : ['text'];
  return {
    contextWindow: m.limit?.context,
    maxTokens: m.limit?.output,
    reasoning: !!m.reasoning,
    input,
  };
}

export function entryOf(p, id) {
  return (p.models || []).find((m) => m.id === id);
}

/** Campos efetivos de um modelo, com a origem de cada um */
export function effectiveMeta(p, id, name, catalog) {
  const e = entryOf(p, id) || {};
  const cat = catalogModel(catalog, name, p.baseUrl, id, p.catalog);
  const cv = cat ? fromCatalog(cat) : {};
  const src = e._src || {};

  const forced = forcedFor(p);
  const pick = (k) => {
    // limites fixos do arena (1M contexto, 131k saída, visão) sobrepõem o endpoint e o models.dev,
    // mas um valor digitado pelo usuário (manual) continua ganhando
    if (forced && forced[k] !== undefined && src[k] !== 'manual') return { v: forced[k], s: 'arena' };
    if (e[k] !== undefined) return { v: e[k], s: src[k] || 'manual' };
    if (cv[k] !== undefined) return { v: cv[k], s: 'models.dev' };
    return { v: PI_DEFAULTS[k], s: 'padrão' };
  };

  const ctx = pick('contextWindow');
  const out = pick('maxTokens');
  const reas = pick('reasoning');
  const inp = pick('input');

  return {
    context: ctx.v,
    output: out.v,
    reasoning: reas.v,
    vision: (inp.v || []).includes('image'),
    ceiling: e.ceiling || 'xhigh',
    source: ctx.s,
    sources: { context: ctx.s, output: out.s },
  };
}

/** Preenche campos ausentes do modelo com o catálogo, marcando a origem */
export function fillFromCatalog(entry, p, name, catalog) {
  const cat = catalogModel(catalog, name, p.baseUrl, entry.id, p.catalog);
  if (!cat) return;
  const cv = fromCatalog(cat);
  entry._src ??= {};
  for (const k of ['contextWindow', 'maxTokens', 'reasoning', 'input']) {
    if (entry[k] === undefined && cv[k] !== undefined) {
      entry[k] = cv[k];
      entry._src[k] = 'models.dev';
    }
  }
}

/** Diz se o provedor tem alguma fonte de metadados (models.dev ou o próprio endpoint) */
export function hasCatalogFor(catalog, name, baseUrl, alias) {
  return !!catalogProviderId(catalog, name, baseUrl, alias);
}

/** Reduz o nível de thinking ao teto do modelo */
export function clampThink(level, ceiling) {
  const i = Math.min(THINK_LEVELS.indexOf(level), THINK_LEVELS.indexOf(ceiling));
  return THINK_LEVELS[Math.max(0, i)];
}

export function fmtTokens(n) {
  if (!n) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

/** "131k" -> 131000, "1M" -> 1000000, "32768" -> 32768 */
export function parseTokens(s) {
  const m = String(s || '')
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return NaN;
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1000 : 1;
  return Math.round(Number(m[1]) * mult);
}

export const ARENA_HOST = 'api.arena.ai';
export const ARENA_FORCED = { contextWindow: 1_000_000, maxTokens: 131_000, input: ['text', 'image'] };

/** Limites fixos para o provedor arena, ou null para os demais */
export function forcedFor(p) {
  return hostOf(p?.baseUrl) === ARENA_HOST ? ARENA_FORCED : null;
}

/** Grava os limites fixos no modelo (usado ao sincronizar, para o models.json ficar certo) */
export function applyForced(entry, p) {
  const f = forcedFor(p);
  if (!f) return;
  entry._src ??= {};
  for (const k of Object.keys(f)) {
    if (entry._src[k] === 'manual') continue;
    entry[k] = Array.isArray(f[k]) ? [...f[k]] : f[k];
    entry._src[k] = 'arena';
  }
}
