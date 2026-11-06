import fs from 'node:fs';
import path from 'node:path';
import { HOME, logDebug } from './store.js';
import { registerTool, unregisterTools } from './tools.js';

/**
 * Servidores MCP em ~/.kiro/mcp.json:
 * {
 *   "servers": {
 *     "github": {
 *       "url": "https://host/mcp",
 *       "auth": { "type": "none" | "bearer" | "header" | "session",
 *                 "token": "...", "header": "x-api-key", "sessionId": "..." },
 *       "enabled": true
 *     }
 *   }
 * }
 *
 * Transporte: Streamable HTTP (POST JSON-RPC; resposta em JSON ou SSE).
 * Ferramentas viram "mcp__<servidor>__<ferramenta>" no registro de ferramentas.
 */

const MCP_FILE = path.join(HOME, 'mcp.json');
const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'kiro-code', version: '0.2.0' };

const clients = new Map(); // nome -> { cfg, sessionId, tools, status, error }

export function loadMcp() {
  try {
    return JSON.parse(fs.readFileSync(MCP_FILE, 'utf8')).servers || {};
  } catch {
    return {};
  }
}

export function saveMcp(servers) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(MCP_FILE, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
}

function headersFor(cfg, sessionId) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL,
  };
  const a = cfg.auth || { type: 'none' };
  if (a.type === 'bearer' && a.token) h.Authorization = `Bearer ${a.token}`;
  if (a.type === 'header' && a.header && a.token) h[a.header] = a.token;
  const sid = sessionId || a.sessionId;
  if (sid) h['Mcp-Session-Id'] = sid;
  return h;
}

/** Lê um stream SSE até achar a resposta com o id pedido */
async function readSseFor(res, id) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = ev
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) {
          reader.cancel().catch(() => {});
          return msg;
        }
      } catch {}
    }
  }
  throw new Error('resposta SSE sem o id esperado');
}

async function rpc(cfg, state, method, params, { notify = false, timeout = 20000 } = {}) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = Date.now() + Math.floor(Math.random() * 1000);

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: headersFor(cfg, state.sessionId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) state.sessionId = sid;

  if (notify) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}`);
  }

  const ct = res.headers.get('content-type') || '';
  const msg = ct.includes('text/event-stream') ? await readSseFor(res, body.id) : await res.json();
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg.result;
}

/** Conecta, descobre as ferramentas e registra cada uma no agente */
export async function connectServer(name, cfg) {
  const state = { cfg, sessionId: cfg.auth?.sessionId || null, tools: [], status: 'conectando', error: null };
  clients.set(name, state);
  unregisterTools(`mcp__${name}__`);

  try {
    await rpc(cfg, state, 'initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT,
    });
    await rpc(cfg, state, 'notifications/initialized', undefined, { notify: true });
    const list = await rpc(cfg, state, 'tools/list', {});

    state.tools = (list.tools || []).map((t) =>
      registerTool({
        schema: {
          name: `mcp__${name}__${t.name}`,
          description: `[MCP ${name}] ${t.description || t.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
        async run(args) {
          const r = await rpc(cfg, state, 'tools/call', { name: t.name, arguments: args || {} }, { timeout: 120000 });
          const parts = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`));
          const text = parts.join('\n') || JSON.stringify(r);
          const lines = text.split('\n').slice(0, 20).map((s) => ({ t: r.isError ? 'e' : 'o', s }));
          if (r.isError) throw new Error(text);
          return { text, ui: { subtitle: `${name}/${t.name}`, lines } };
        },
      }),
    );
    state.status = 'ok';
  } catch (err) {
    state.status = 'erro';
    state.error = err.message;
    logDebug(`mcp ${name}: ${err.message}`);
  }
  return state;
}

export function disconnectServer(name) {
  unregisterTools(`mcp__${name}__`);
  clients.delete(name);
}

/** Conecta todos os servidores habilitados */
export async function startMcp() {
  const servers = loadMcp();
  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    out.push(await connectServer(name, cfg));
  }
  return out;
}

export function mcpStatus(name) {
  return clients.get(name) || null;
}
