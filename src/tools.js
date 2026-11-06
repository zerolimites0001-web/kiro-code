import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Cada tool: schema (JSON schema p/ o modelo) + run(args, ctx) -> { text, ui }
 *   text: o que volta para o modelo
 *   ui:   { subtitle, lines: [{ t: '+'|'-'|' '|'…'|'o'|'i'|'e', s }] } para a caixa na TUI
 *   ctx:  { signal, log(string) } para progresso ao vivo
 */

/** Saída máxima devolvida ao modelo. Aumente com KIRO_MAX_OUT (chars). */
const MAX_OUT = Math.max(1000, Number(process.env.KIRO_MAX_OUT) || 60000);
/** Quantas linhas ficam guardadas na caixa da TUI para o "expandir" (clique / ctrl+o) */
const UI_MAX = 400;
// Estourou o limite? Guarda o começo E o fim — o erro costuma estar no fim da saída.
const trunc = (s) => {
  if (s.length <= MAX_OUT) return s;
  const half = Math.floor(MAX_OUT / 2);
  return s.slice(0, half) + `\n...[truncado ${s.length - MAX_OUT} chars do meio]...\n` + s.slice(-half);
};
const abs = (p) => path.resolve(process.cwd(), p);
const splitLines = (s) => (s === '' ? [] : s.split('\n'));

/**
 * Mata o processo E toda a árvore dele. `child.kill()` sozinho só derruba o
 * `sh`; um comando que subiu processo/pipeline deixava os netos vivos ("não
 * consigo interromper"). `detached` põe o filho num process group próprio, e
 * `kill(-pid)` derruba o grupo inteiro.
 */
/**
 * Mata o processo E toda a árvore de netos. Tenta SIGTERM primeiro (dá chance
 * de limpar), depois SIGKILL se não sair. `process.kill(-pid)` atinge o process
 * group inteiro (por causa do `detached: true`), não só o `sh`.
 */
function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  const tryKill = (sig) => {
    try {
      if (pid) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {}
  };
  tryKill(signal);
  // Se for SIGTERM, agenda um SIGKILL de garantia daqui a 2s se o processo
  // ainda estiver vivo (o 'close' ainda não disparou).
  if (signal === 'SIGTERM') {
    setTimeout(() => {
      if (!child.exitCode && !child.signalCode) tryKill('SIGKILL');
    }, 2000).unref?.();
  }
}

function runShell(command, { timeout = 60000, signal, log } = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      env: process.env,
      detached: true, // process group próprio -> dá pra matar a árvore toda
    });
    let out = '';
    let aborted = false;
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: child.exitCode, out: trunc(out), ...extra });
    };
    const timer = setTimeout(() => killTree(child), timeout);
    const onAbort = () => {
      aborted = true;
      killTree(child, 'SIGTERM');
    };

    // Streaming ao vivo: cada pedaço de stdout/stderr vai para o log da TUI
    // (caixa da tool) enquanto o comando roda, e também acumula em `out`.
    const push = (d) => {
      const s = String(d);
      out += s;
      log?.(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => {
      out += `\n[erro ao executar: ${err.message}]`;
      finish({ aborted });
    });
    child.on('close', (code) => finish({ code: code ?? child.exitCode, aborted }));

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Diff linha a linha por LCS. Retorna ops: { t: '+'|'-'|' ', s } */
export function lineDiff(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))];

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) ops.push({ t: ' ', s: A[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: A[i++] });
    else ops.push({ t: '+', s: B[j++] });
  }
  while (i < n) ops.push({ t: '-', s: A[i++] });
  while (j < m) ops.push({ t: '+', s: B[j++] });
  return ops;
}

/** Mantém só mudanças + 2 linhas de contexto; o resto vira "…" */
function compactOps(ops, ctx = 2) {
  const keep = ops.map(() => false);
  ops.forEach((o, k) => {
    if (o.t === ' ') return;
    for (let d = -ctx; d <= ctx; d++) if (ops[k + d]) keep[k + d] = true;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (skipped) out.push({ t: '…', s: `${skipped} linhas inalteradas` }), (skipped = 0);
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ t: '…', s: `${skipped} linhas inalteradas` });
  return out;
}

const stats = (ops) => ({
  add: ops.filter((o) => o.t === '+').length,
  del: ops.filter((o) => o.t === '-').length,
});
const statsText = ({ add, del }) => `+${add} −${del}`;

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export const TOOLS = [
  {
    schema: {
      name: 'read_image',
      description: 'Carrega uma imagem (png, jpg, gif, webp) do disco para o modelo ver. Só funciona em modelos com visão.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async run(args, ctx) {
      if (!ctx.vision) {
        return { text: 'This model is not compatible with vision.', ui: { subtitle: 'sem visão', lines: [] } };
      }
      const p = abs(args.path);
      const mime = MIME[path.extname(p).slice(1).toLowerCase()];
      if (!mime) throw new Error('formato não suportado (use png, jpg, gif ou webp)');
      const data = (await fs.readFile(p)).toString('base64');
      return {
        text: `Imagem carregada: ${args.path}`,
        image: { mime, data },
        ui: { subtitle: args.path, lines: [] },
      };
    },
  },

  {
    schema: {
      name: 'bash',
      description: 'Executa um comando shell no diretório do projeto e retorna stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando shell a executar' },
          timeout_ms: { type: 'number', description: 'Timeout em ms (padrão 60000)' },
        },
        required: ['command'],
      },
    },
    async run(args, ctx) {
      const r = await runShell(args.command, {
        timeout: args.timeout_ms || 60000,
        signal: ctx.signal,
        log: ctx.log, // saída vai para a caixa da TUI ao vivo, não só no fim
      });
      // Primeira linha: o comando completo rodando (não só o resumo do cabeçalho)
      const head = [{ t: 'i', s: `$ ${args.command}` }];
      const lines = head.concat(splitLines(r.out).slice(0, UI_MAX).map((s) => ({ t: 'o', s })));
      return { text: `exit=${r.code}\n${r.out}`, ui: { subtitle: `exit ${r.code}`, lines } };
    },
  },
  {
    schema: {
      name: 'read_file',
      description: 'Lê um arquivo de texto. Pode informar um intervalo de linhas.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start: { type: 'number', description: 'Linha inicial (1-based)' },
          end: { type: 'number', description: 'Linha final (inclusive)' },
        },
        required: ['path'],
      },
    },
    async run(args) {
      const lines = splitLines(await fs.readFile(abs(args.path), 'utf8'));
      const s = Math.max(1, args.start || 1);
      const e = Math.min(lines.length, args.end || lines.length);
      const slice = lines.slice(s - 1, e);
      const text = trunc(slice.map((l, i) => `${s + i}\t${l}`).join('\n'));
      // linhas no ui: sem elas o bloco do read_file não tinha o que expandir
      return {
        text,
        ui: { subtitle: `${e - s + 1} linhas`, lines: slice.slice(0, UI_MAX).map((l, i) => ({ t: ' ', s: `${s + i}  ${l}` })) },
      };
    },
  },
  {
    schema: {
      name: 'write_file',
      description: 'Cria ou sobrescreve um arquivo com o conteúdo informado.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    async run(args) {
      const p = abs(args.path);
      let old = null;
      try {
        old = await fs.readFile(p, 'utf8');
      } catch {}
      const ops = lineDiff(old ?? '', args.content);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, args.content, 'utf8');
      const st = stats(ops);
      const label = old === null ? `novo arquivo, ${splitLines(args.content).length} linhas` : statsText(st);
      return {
        text: `Arquivo escrito: ${args.path} (${label})`,
        ui: { subtitle: label, lines: compactOps(ops).slice(0, UI_MAX) },
      };
    },
  },
  {
    schema: {
      name: 'edit_file',
      description: 'Substitui um trecho exato (old_string) por outro (new_string) em um arquivo. old_string deve ser único.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async run(args) {
      const p = abs(args.path);
      const src = await fs.readFile(p, 'utf8');

      // O modelo às vezes manda o trecho com CRLF do Windows ou com espaço
      // sobrando no fim das linhas (comum em arquivo de projeto misto). Isso
      // NÃO muda o que ele quis dizer, então tenta casar exato primeiro e, se
      // falhar, casa normalizando: line endings + trailing whitespace.
      const norm = (s) =>
        s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+(\n|$)/g, '$1');

      let needle = args.old_string;
      let hay = src;
      let count = src.split(needle).length - 1;
      if (count === 0) {
        const nHay = norm(src);
        const nNeedle = norm(needle);
        const nCount = nHay.split(nNeedle).length - 1;
        if (nCount >= 1) {
          hay = nHay;
          needle = nNeedle;
          count = nCount;
        }
      }
      if (count === 0) throw new Error('old_string não encontrado no arquivo');
      if (count > 1) throw new Error(`old_string aparece ${count} vezes; torne-o único`);

      const line = hay.slice(0, hay.indexOf(needle)).split('\n').length;
      const out = hay.replace(needle, () => args.new_string);
      await fs.writeFile(p, out, 'utf8');

      const ops = [
        ...splitLines(args.old_string).map((s) => ({ t: '-', s })),
        ...splitLines(args.new_string).map((s) => ({ t: '+', s })),
      ];
      const st = stats(ops);
      return {
        text: `Editado: ${args.path} (linha ${line}, ${statsText(st)})`,
        ui: { subtitle: `linha ${line}  ${statsText(st)}`, lines: ops.slice(0, UI_MAX) },
      };
    },
  },
  {
    schema: {
      name: 'loop',
      description:
        'Repete um comando shell até ele dar sucesso (exit 0) ou atingir max_tries. Útil para esperar serviços, retry de testes e builds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          max_tries: { type: 'number', description: 'Máximo de tentativas (padrão 5, máx 50)' },
          interval_ms: { type: 'number', description: 'Pausa entre tentativas (padrão 2000)' },
        },
        required: ['command'],
      },
    },
    async run(args, ctx) {
      const max = Math.min(args.max_tries || 5, 50);
      const wait = args.interval_ms ?? 2000;
      let last = null;
      const sleep = (ms) =>
        new Promise((resolve) => {
          if (!ms) return resolve();
          const t = setTimeout(resolve, ms);
          // espera interrompível: sem isso o Ctrl+C não fazia efeito no intervalo
          ctx.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      for (let i = 1; i <= max; i++) {
        if (ctx.signal?.aborted) throw new Error('cancelado');
        last = await runShell(args.command, { timeout: 120000, signal: ctx.signal });
        if (ctx.signal?.aborted) throw new Error('cancelado');
        ctx.log?.(`tentativa ${i}/${max} → exit=${last.code}`);
        if (last.code === 0) {
          return { text: `Sucesso na tentativa ${i}/${max}\n${last.out}`, ui: { subtitle: `ok em ${i}/${max}`, lines: [] } };
        }
        await sleep(wait);
      }
      if (ctx.signal?.aborted) throw new Error('cancelado');
      return {
        text: `Falhou após ${max} tentativas (exit=${last.code})\n${last.out}`,
        ui: { subtitle: `falhou ${max}x`, lines: [] },
      };
    },
  },
];

/** Registro dinâmico: ferramentas de plugins e de servidores MCP entram aqui */
export function registerTool(tool) {
  const i = TOOLS.findIndex((t) => t.schema.name === tool.schema.name);
  if (i >= 0) TOOLS.splice(i, 1);
  TOOLS.push(tool);
  return tool.schema.name;
}

/** Remove todas as ferramentas cujo nome começa com o prefixo */
export function unregisterTools(prefix) {
  for (let i = TOOLS.length - 1; i >= 0; i--) {
    if (TOOLS[i].schema.name.startsWith(prefix)) TOOLS.splice(i, 1);
  }
}

export function getTool(name) {
  return TOOLS.find((t) => t.schema.name === name);
}
