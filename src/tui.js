import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const C = {
  r: '\x1b[0m',
  b: '\x1b[1m',
  i: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

export const FG = {
  text: '\x1b[38;5;252m',
  dim: '\x1b[38;5;244m',
  accent: '\x1b[38;5;117m',
  add: '\x1b[38;5;114m',
  del: '\x1b[38;5;210m',
  err: '\x1b[38;5;203m',
  ok: '\x1b[38;5;114m',
  warn: '\x1b[38;5;221m',
};

export const BG = {
  user: '\x1b[48;5;237m',
  ok: '\x1b[48;5;22m',
  err: '\x1b[48;5;52m',
  run: '\x1b[48;5;238m',
  code: '\x1b[48;5;235m',
  head: '\x1b[48;5;24m',
  sel: '\x1b[48;5;31m',
  // bash/shell: caixa PRETA DESTACADA — corpo preto puro, texto claro e uma
  // trilha colorida na lateral (\u258c) que faz a caixa saltar do fundo da tela.
  bashRun: '\x1b[48;5;16m', // preto puro, em execução
  bashOk: '\x1b[48;5;16m', // preto puro, sucesso
  bashErr: '\x1b[48;5;16m', // preto puro, erro (o vermelho vai na trilha)
  bashHead: '\x1b[48;5;234m', // faixa do cabeçalho, um tom acima do corpo
};

/** Ferramentas de shell usam a caixa preta destacada */
const SHELL_TOOLS = /^(bash|loop|shell)$/i;
/** Texto padrão dentro da caixa do shell (fundo preto → texto claro) */
const SHELL_FG = '\x1b[38;5;252m';
const SHELL_FG_BOLD = '\x1b[1m\x1b[38;5;231m';
/** Trilha de destaque à esquerda: é ela que "acende" a caixa preta */
const RAIL_RUN = '\x1b[38;5;221m';
const RAIL_OK = '\x1b[38;5;114m';
const RAIL_ERR = '\x1b[38;5;203m';

const R = C.r;

/* ---------- saneamento de texto vindo de fora ----------
 * Saída de comando traz \r (barras de progresso), \t e códigos ANSI crus.
 * Sem limpar: o \r volta o cursor pro começo da MESMA linha (a caixa parecia
 * sumir / sair torta) e o \t desalinha a largura porque o terminal expande
 * tab até a parada de 8 colunas, estourando o pad().
 */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
export function san(s, tab = 4) {
  return String(s ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' '.repeat(Math.max(1, tab | 0)))
    .replace(CTRL, '');
}
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_STICKY = /\x1b\[[0-9;?]*[A-Za-z]/y;
const vis = (s) => String(s).replace(ANSI, '');

/**
 * Largura de um GRAPHEME CLUSTER em colunas de terminal (0, 1 ou 2).
 * Code points isolados erram com emoji + FE0F, flags (2x regional indicator),
 * ZWJ sequences e combinantes — a contagem tem que ser por cluster.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const isRegional = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isWideCp = (cp) =>
  cp === 0x2329 || cp === 0x232a ||
  (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
  (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK
  (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
  (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
  (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms / vertical
  (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators (flags)
  (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols & dingbats (✅⚠☀…) com apresentação emoji
  (cp >= 0x2b00 && cp <= 0x2bff) || // setas/estrelas emoji (⬅⭐…)
  (cp >= 0x1f000 && cp <= 0x1faff) || // emoji & symbols (bloco inteiro)
  (cp >= 0x20000 && cp <= 0x3fffd) || // CJK ext B+
  (cp >= 0x30000 && cp <= 0x3134a);
const isZeroCp = (cp) =>
  cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0) ||
  (cp >= 0x300 && cp <= 0x36f) ||   // combinantes (combining marks, general category Mn/Me via faixa)
  (cp >= 0x483 && cp <= 0x489) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||  // variation selectors
  cp === 0xfeff ||
  (cp >= 0x200b && cp <= 0x200f) ||  // zero-width
  (cp >= 0x2060 && cp <= 0x2064);

function graphemeW(seg) {
  if (!seg) return 0;
  // string so com combinantes/VS = largura 0
  let baseW = 0;
  let hasBase = false;
  let hasVS16 = false;
  let zwj = false;
  let regionalCount = 0;
  for (const ch of seg) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d) { zwj = true; continue; }
    if (cp === 0xfe0f) { hasVS16 = true; continue; }
    if (isZeroCp(cp)) continue;
    hasBase = true;
    if (isRegional(cp)) regionalCount++;
    const w = isWideCp(cp) ? 2 : 1;
    if (w > baseW) baseW = w;
  }
  if (!hasBase) return 0;
  if (regionalCount >= 2) return 2; // flag = 2 colunas
  if (zwj) return 2;                // emoji composto (👨‍👩‍👧) ocupa 2
  if (hasVS16 && baseW < 2) return 2; // emoji com VS16
  return baseW;
}

/** Itera graphemes de uma string sem ANSI */
function graphemes(s) {
  s = s == null ? '' : String(s);
  return segmenter.segment(String(s));
}

/** Largura de um code point em colunas de terminal — mantido para compat, delega ao cluster */
function charW(cp) {
  return graphemeW(String.fromCodePoint(cp));
}

/** Largura visível (colunas reais) de uma string com códigos ANSI */
export function dwidth(s) {
  const str = String(s);
  let w = 0;
  let i = 0;
  while (i < str.length) {
    ANSI_STICKY.lastIndex = i;
    const m = ANSI_STICKY.exec(str);
    if (m) {
      i = ANSI_STICKY.lastIndex;
      continue;
    }
    // termina o trecho sem ANSI e mede por clusters
    let j = i;
    while (j < str.length) {
      ANSI_STICKY.lastIndex = j;
      if (ANSI_STICKY.exec(str)) break;
      j++;
    }
    for (const { segment } of graphemes(str.slice(i, j))) w += graphemeW(segment);
    i = j;
  }
  return w;
}

/** Corta a string (preservando ANSI) até caber em w colunas. Devolve {text, width, truncated} */
function cutAnsi(s, w) {
  const str = String(s);
  let out = '';
  let width = 0;
  let i = 0;
  while (i < str.length) {
    ANSI_STICKY.lastIndex = i;
    const m = ANSI_STICKY.exec(str);
    if (m) {
      out += m[0];
      i = ANSI_STICKY.lastIndex;
      continue;
    }
    let j = i;
    while (j < str.length) {
      ANSI_STICKY.lastIndex = j;
      if (ANSI_STICKY.exec(str)) break;
      j++;
    }
    for (const { segment } of graphemes(str.slice(i, j))) {
      const cw = graphemeW(segment);
      if (width + cw > w) return { text: out, width, truncated: true };
      out += segment;
      width += cw;
    }
    i = j;
  }
  return { text: out, width, truncated: false };
}

/**
 * Preenche/corta até w colunas reais (o fundo colorido se estende até a borda).
 * cutAnsi NÃO fecha com reset: se fechasse, a linha truncada perdia o fundo no
 * meio e a caixa saía "quebrada" — o espaço de padding segue com o bg ativo.
 */
const pad = (s, w) => {
  if (w <= 0) return '';
  const { text, width } = cutAnsi(s, w);
  return width >= w ? text : text + ' '.repeat(w - width);
};

/** Mantém o FINAL da string, cortado em w colunas (para a linha de input) */
const tail = (s, w) => {
  const str = vis(s);
  const segs = [...graphemes(str)].map((x) => x.segment);
  let width = 0;
  let i = segs.length;
  while (i > 0) {
    const cw = graphemeW(segs[i - 1]);
    if (width + cw > w) break;
    width += cw;
    i--;
  }
  return segs.slice(i).join('');
};

/** Número de graphemes (caracteres visíveis reais) de uma string */
function graphemeCount(text) {
  return [...graphemes(text)].length;
}

/** Quebra por palavra inteira, preservando códigos ANSI já aplicados (markdown inline) */
function wrapAnsi(text, width) {
  const w = Math.max(1, width | 0);
  const out = [];
  for (const raw of String(text).split('\n')) {
    // tokeniza: cada token é uma palavra (sequência de não-espaço) ou um espaço
    const tokens = [];
    let i = 0;
    while (i < raw.length) {
      ANSI_STICKY.lastIndex = i;
      const m = ANSI_STICKY.exec(raw);
      if (m) {
        tokens.push({ kind: 'ansi', text: m[0] });
        i = ANSI_STICKY.lastIndex;
        continue;
      }
      if (raw[i] === ' ' || raw[i] === '\t') {
        let j = i;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
        tokens.push({ kind: 'space', text: raw.slice(i, j) });
        i = j;
        continue;
      }
      let j = i;
      while (j < raw.length && raw[j] !== ' ' && raw[j] !== '\t') {
        ANSI_STICKY.lastIndex = j;
        if (ANSI_STICKY.exec(raw)) break;
        j++;
      }
      tokens.push({ kind: 'word', text: raw.slice(i, j) });
      i = j;
    }

    let cur = '';
    let cw = 0;
    for (const tok of tokens) {
      if (tok.kind === 'ansi') {
        cur += tok.text;
        continue;
      }
      if (tok.kind === 'space') {
        cur += tok.text;
        for (const ch of tok.text) cw += graphemeW(ch);
        continue;
      }
      // palavra: medir largura real (sem ANSI)
      let pw = 0;
      for (const { segment } of graphemes(tok.text)) pw += graphemeW(segment);
      if (cw + pw > w && cw > 0) {
        out.push(cur.replace(/[ \t]+$/, ''));
        cur = '';
        cw = 0;
      }
      cur += tok.text;
      cw += pw;
    }
    if (cur !== '' || out.length === 0) out.push(cur.replace(/[ \t]+$/, ''));
  }
  return out;
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COLLAPSE_ROWS = 8;

/** Quebra por palavra inteira, largura real de coluna (graphemes; emoji/CJK contam 2) */
function wrapPlain(text, width) {
  const w = Math.max(1, width | 0);
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (raw.length === 0) {
      out.push('');
      continue;
    }
    const tokens = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === ' ' || raw[i] === '\t') {
        let j = i;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
        tokens.push({ kind: 'space', text: raw.slice(i, j) });
        i = j;
        continue;
      }
      let j = i;
      while (j < raw.length && raw[j] !== ' ' && raw[j] !== '\t') j++;
      tokens.push({ kind: 'word', text: raw.slice(i, j) });
      i = j;
    }

    let cur = '';
    let cw = 0;
    for (const tok of tokens) {
      if (tok.kind === 'space') {
        cur += tok.text;
        for (const ch of tok.text) cw += graphemeW(ch);
        continue;
      }
      let pw = 0;
      for (const ch of tok.text) pw += graphemeW(ch);
      if (cw + pw > w && cw > 0) {
        out.push(cur.replace(/[ \t]+$/, ''));
        cur = '';
        cw = 0;
      }
      cur += tok.text;
      cw += pw;
    }
    if (cur !== '' || out.length === 0) out.push(cur.replace(/[ \t]+$/, ''));
  }
  return out;
}

/** Negrito **x**, itálico *x* e código `x` em linhas sem fundo (reaplica a cor base após cada reset) */
const inline = (s, base = '') => {
  const re = base || '';
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, `${C.b}$1${R}${re}`)
    .replace(/\*(.+?)\*/g, `${C.i}$1${R}${re}`)
    .replace(/`([^`]+)`/g, `${FG.accent}$1${R}${re}`);
};

export class TUI {
  constructor() {
    this.input = '';
    this.cursor = 0;
    this._pendingInput = null; // buffer de colagem (null = vazio)
    this.pastes = new Map(); // colagens grandes: id -> texto completo (o input mostra só um marcador)
    this._pasteSeq = 0;
    this._pasting = false; // dentro de um bracketed paste (\x1b[200~ ... \x1b[201~)
    this._pasteBuf = '';
    this._pendingTimer = null;
    this.entries = []; // { kind: text|user|thinking|tool, ... }
    this.partial = '';
    this.partialThink = '';
    this.input = '';
    this.cursor = 0; // posição de edição dentro do input
    this.history = [];
    this.hIdx = -1;
    this.scroll = 0;
    this.status = '';
    this.footer = '';
    this.busyLabel = '';
    this.spin = 0;
    this.timer = null;
    this.expanded = false; // ctrl+o
    this.menu = null;
    this.asker = null;
    this.onSubmit = () => {};
    this.onCtrlC = () => {};
    this.onCtrlD = () => {};
    this.onEsc = () => {};
    this.widgets = new Map();
    this.wtimer = null;
    this.onCycleThinking = () => {};
  }

  get cols() {
    const c = process.stdout.columns;
    if (c > 0) this._lastCols = c;
    return this._lastCols || 80;
  }
  get rows() {
    const r = process.stdout.rows;
    if (r > 0) this._lastRows = r;
    return this._lastRows || 24;
  }

  start() {
    // ?7l = sem quebra automática: linha maior que a tela corta à direita em vez de empurrar a tela
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[?2004h');
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (d) => this.onData(d));
    process.stdout.on('resize', () => {
      this._prevFrame = null; // largura/altura mudou: repinta tudo
      this.draw();
    });
    this._prevFrame = null;
    this.draw();
  }

  stop() {
    clearInterval(this.timer);
    this._prevFrame = null;
    process.stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l' + R);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  /* ---------- conteúdo ---------- */

  print(text = '', color = '') {
    this.commit();
    this.entries.push({ kind: 'text', text, color });
    this.scroll = 0;
    this._prevFrame = null;
    this.draw();
  }

  addUser(text) {
    this.commit();
    this.entries.push({ kind: 'user', text });
    this.scroll = 0;
    this.draw();
  }

  stream(delta) {
    this.partial += delta;
    this.scroll = 0;
    this.draw();
  }

  /**
   * Descarta o texto parcial em exibição. Chamado quando a tentativa falhou no
   * meio do stream e vai ser repetida: sem isso o texto da tentativa que falhou
   * ficava na tela e o da nova tentativa era somado em cima (texto duplicado).
   */
  discardPartial() {
    this.partial = '';
    this.partialThink = '';
    this.draw();
  }

  think(delta) {
    this.partialThink += delta;
    this.draw();
  }

  /** Bloco de raciocínio já fechado (usado ao recarregar histórico) */
  addThink(text) {
    if (!text) return;
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === 'thinking') last.text = String(text);
    else this.entries.push({ kind: 'thinking', text: String(text) });
    this._prevFrame = null;
    this.draw();
  }

  commit() {
    if (this.partialThink) {
      // Thinking consecutivo é MESCLADO no mesmo bloco. Antes cada rodada de tool
      // criava uma caixa nova e, como o corpo da tela é limitado, os blocos antigos
      // saíam de vista — dava a impressão de que o raciocínio tinha sido apagado.
      const last = this.entries[this.entries.length - 1];
      if (last && last.kind === 'thinking') last.text += '\n' + this.partialThink;
      else this.entries.push({ kind: 'thinking', text: this.partialThink });
      this.partialThink = '';
    }
    if (this.partial) {
      this.entries.push({ kind: 'text', text: this.partial });
      this.partial = '';
    }
  }

  clear() {
    this.entries = [];
    this.partial = '';
    this.partialThink = '';
    this.scroll = 0;
    this.draw();
  }

  /** Bloco de tool call (status run) */
  addTool(title, subtitle = '') {
    this.commit();
    const e = { kind: 'tool', title, subtitle, status: 'run', lines: [], startedAt: Date.now() };
    this.entries.push(e);
    this.scroll = 0;
    this.draw();
    return e;
  }

  pushTool(ui = {}) {
    const e = this.addTool(ui.title || 'tool', ui.subtitle || '');
    e.status = ui.status || 'ok';
    e.lines = ui.lines || [];
    if (ui.ms) {
      e.endedAt = e.startedAt + ui.ms;
    } else {
      e.startedAt = 0; // sem tempo medido: não mostra "0.0s"
    }
    this.draw();
    return e;
  }

  toolLine(entry, line) {
    entry.lines.push(line);
    if (entry.lines.length > 500) entry.lines.splice(0, entry.lines.length - 500);
    this.draw();
  }

  toggleExpand() {
    this.expanded = !this.expanded;
    this.draw();
  }

  setBusy(label) {
    this.busyLabel = label;
    if (label && !this.busyStart) this.busyStart = Date.now();
    if (!label) this.busyStart = 0;
    if (label && !this.timer) {
      this.timer = setInterval(() => {
        this.spin++;
        this.draw();
      }, 90);
    } else if (!label && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.draw();
  }

  /* ---------- widgets ao vivo (plugins) ---------- */

  setWidget(key, def) {
    this.widgets.set(key, def);
    if (!this.wtimer) this.wtimer = setInterval(() => this.draw(), 1000);
    this.draw();
  }

  removeWidgets(prefix) {
    for (const k of [...this.widgets.keys()]) if (k.startsWith(prefix)) this.widgets.delete(k);
    if (!this.widgets.size && this.wtimer) {
      clearInterval(this.wtimer);
      this.wtimer = null;
    }
    this.draw();
  }

  dockLines() {
    const MAX = 6;
    const out = [];
    const w = this.cols;
    for (const def of this.widgets.values()) {
      try {
        for (const l of def.render() || []) out.push(cutAnsi(String(l), w).text);
      } catch {}
    }
    if (out.length <= MAX) return out;
    return [...out.slice(0, MAX - 1), `${FG.dim}… +${out.length - (MAX - 1)} linhas de widgets`];
  }

  /* ---------- menus e perguntas ---------- */

  select(title, items, opts = {}) {
    return new Promise((resolve) => {
      this.menu = { title, items, idx: 0, query: '', resolve, keys: opts.keys || {}, hint: opts.hint || '' };
      this.draw();
    });
  }

  ask(prompt, initial = '') {
    return new Promise((resolve) => {
      this.input = initial;
      this.cursor = [...graphemes(initial)].length;
      this.asker = { prompt, resolve };
      this.draw();
    });
  }

  menuItems() {
    const m = this.menu;
    const q = m.query.toLowerCase();
    return m.items.filter((it) => it.label.toLowerCase().includes(q));
  }

  /* ---------- entrada ---------- */

  onData(data) {
    const START = '\x1b[200~';
    const END = '\x1b[201~';
    let rest = data;
    while (rest.length) {
      if (this._pasting) {
        const e = rest.indexOf(END);
        if (e < 0) {
          this._pasteBuf += rest;
          break;
        }
        this._pasteBuf += rest.slice(0, e);
        rest = rest.slice(e + END.length);
        this._pasting = false;
        const text = this._pasteBuf;
        this._pasteBuf = '';
        this.insertPaste(text);
        continue;
      }
      const st = rest.indexOf(START);
      const chunk = st < 0 ? rest : rest.slice(0, st);
      if (chunk) this.onKeysData(chunk);
      if (st < 0) break;
      rest = rest.slice(st + START.length);
      this._pasting = true;
    }
    this.draw();
  }

  /** Teclas e mouse de um pedaço de entrada (sem paste marcado) */
  onKeysData(data) {
    // sem bracketed paste (terminal antigo): um pedaço longo que não começa com escape é colagem
    if (data.length > 1 && !data.startsWith('\x1b') && !/^[\x00-\x1f]$/.test(data)) {
      return this.insertPaste(data);
    }
    const mouse = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g);
    if (mouse) {
      for (const raw of mouse) {
        const [, b, cx, cy, kind] = raw.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        const btn = Number(b);
        const col = Number(cx);
        const row = Number(cy);
        if (btn === 64) this.scroll = Math.min(this.scroll + 3, Math.max(0, this.totalLines() - 3));
        else if (btn === 65) this.scroll = Math.max(0, this.scroll - 3);
        else if (kind === 'M' && btn === 0) this.onClick(row, col); // clique esquerdo
      }
      return;
    }
    for (const key of data.match(/\x1b\[[0-9;]*[~A-Za-z]|\x1b.|[\s\S]/g) || []) this.onKey(key);
  }

  /**
   * Cola um bloco inteiro de texto no cursor, sem enviar nada.
   * Colagens grandes (várias linhas ou muito longas) viram um marcador curto
   * "[colado #n: ...]"; o texto completo fica em this.pastes e é expandido no envio.
   */
  insertPaste(raw) {
    this._flushPendingInput();
    const text = String(raw)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!text) return;
    const lines = text.split('\n').length;
    let insert = text;
    if (lines > 1 || text.length > 300) {
      const id = ++this._pasteSeq;
      this.pastes.set(id, text);
      insert = `[colado #${id}: ${lines} linha${lines > 1 ? 's' : ''}, ${text.length} chars]`;
    }
    const segs = [...graphemes(this.input)].map((x) => x.segment);
    const add = [...graphemes(insert)].map((x) => x.segment);
    segs.splice(this.cursor, 0, ...add);
    this.input = segs.join('');
    this.cursor += add.length;
  }

  /** Troca os marcadores "[colado #n: ...]" pelo texto real */
  expandPastes(text) {
    return text.replace(/\[colado #(\d+): [^\]]*\]/g, (m, id) => (this.pastes.has(+id) ? this.pastes.get(+id) : m));
  }

  /**
   * Clique na tela. Linhas do corpo pertencem a um bloco (entrada da TUI):
   * clicar em cima de uma caixa de tool (bash, read_file, write_file, edit_file…)
   * abre/fecha aquele bloco, independente do ctrl+o global.
   */
  onClick(row, col) {
    if (col < 1 || row < 1) return;
    const map = this._bodyMap;
    if (!map) return;
    const idx = row - map.top;
    if (idx < 0 || idx >= map.owners.length) return;
    const entry = map.owners[idx];
    if (!entry || entry.kind !== 'tool') return;
    if (!entry.lines?.length) return; // nada para expandir
    entry.expanded = !(entry.expanded ?? this.expanded);
    this.draw();
  }

  onKey(k) {
    if (k === '\x03') return this.onCtrlC(false);
    if (k === '\x04' && this.menu?.keys?.[k]) return this.menuKey(k);
    if (k === '\x04') return this.onCtrlD();
    if (this.menu) return this.menuKey(k);
    if (k === '\x1b') return this.onEsc(); // ESC sozinho: interrompe a IA
    // tecla não-imprimível: grava antes o texto digitado (evita backspace apagar no vazio
    // e depois o texto pendente reaparecer)
    if (k.startsWith('\x1b') || /[\x00-\x1f\x7f]/.test(k)) this._flushPendingInput();

    if (k === '\x0f') return this.toggleExpand(); // ctrl+o
    if (k === '\x1b[Z') return this.onCycleThinking(); // shift+tab
    if (k === '\x1b[5~') this.scroll = Math.min(this.scroll + 10, Math.max(0, this.totalLines() - 3));
    else if (k === '\x1b[6~') this.scroll = Math.max(0, this.scroll - 10);
    else if (k === '\r' || k === '\n') this.submit();
    // seta esquerda (move um grapheme)
    else if (k === '\x1b[D') this.cursor = Math.max(0, this.cursor - 1);
    // seta direita (move um grapheme)
    else if (k === '\x1b[C') this.cursor = Math.min(graphemeCount(this.input), this.cursor + 1);
    // HOME
    else if (k === '\x1b[H') this.cursor = 0;
    // END
    else if (k === '\x1b[F') this.cursor = graphemeCount(this.input);
    // TAB: limpa o input inteiro (deleta frase inteira)
    // TAB: autocompleta caminho de arquivo/pasta no token antes do cursor
    else if (k === '\t') this.completePath();
    // backspace: apaga caractere antes do cursor (por grapheme)
    else if (k === '\x7f' || k === '\b') {
      if (this.cursor > 0) {
        const segs = [...graphemes(this.input)].map((x) => x.segment);
        segs.splice(this.cursor - 1, 1);
        this.input = segs.join('');
        this.cursor--;
      }
    }
    // Delete: apaga caractere depois do cursor (por grapheme)
    else if (k === '\x1b[3~') {
      const segs = [...graphemes(this.input)].map((x) => x.segment);
      if (this.cursor < segs.length) {
        segs.splice(this.cursor, 1);
        this.input = segs.join('');
      }
    }
    else if (k === '\x1b[A') this.historyNav(-1);
    else if (k === '\x1b[B') this.historyNav(1);
    else if (!k.startsWith('\x1b')) {
      // buffer de colagem: acumula caracteres rápidos e faz um só draw
      if (this._pendingInput == null) {
        this._pendingInput = '';
        this._pendingTimer = null;
      }
      this._pendingInput += k;
      clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        this._flushPendingInput();
      }, 15);
    }
  }

  /**
   * Autocomplete de caminho (Tab). Completa o último token antes do cursor.
   * Pasta termina com "/", arquivo termina normal. Vários candidatos: completa
   * o prefixo comum e, se não avançar, lista as opções.
   */
  completePath() {
    this._flushPendingInput();
    const segs = [...graphemes(this.input)].map((x) => x.segment);
    const before = segs.slice(0, this.cursor).join('');
    const after = segs.slice(this.cursor).join('');
    const token = before.match(/(\S*)$/)[1];
    const start = before.length - token.length;

    const home = os.homedir();
    const isHome = token === '~' || token.startsWith('~/');
    const expanded = isHome ? home + token.slice(1) : token;
    const slash = expanded.lastIndexOf('/');
    const dirPart = slash >= 0 ? expanded.slice(0, slash + 1) : '';
    const base = expanded.slice(slash + 1);
    const searchDir = dirPart ? dirPart : '.';

    let entries;
    try {
      entries = fs.readdirSync(searchDir, { withFileTypes: true });
    } catch {
      return; // diretório inexistente: nada a completar
    }
    const matches = entries
      .filter((e) => e.name.startsWith(base))
      .filter((e) => !e.name.startsWith('.') || base.startsWith('.'))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    if (!matches.length) return;

    let completed;
    if (matches.length === 1) {
      const m = matches[0];
      completed = dirPart + m.name + (m.isDir ? '/' : '');
    } else {
      // prefixo comum entre os candidatos
      let common = matches[0].name;
      for (const m of matches) {
        while (!m.name.startsWith(common)) common = common.slice(0, -1);
      }
      if (common.length > base.length) {
        completed = dirPart + common;
      } else {
        // nada a completar: mostra as opções
        const list = matches
          .slice(0, 40)
          .map((m) => (m.isDir ? m.name + '/' : m.name))
          .join('   ');
        this.print(list + (matches.length > 40 ? `   … (+${matches.length - 40})` : ''), FG.dim);
        return;
      }
    }

    // volta o "~" se o usuário digitou ~
    if (isHome && completed.startsWith(home)) completed = '~' + completed.slice(home.length);
    const newBefore = before.slice(0, start) + completed;
    this.input = newBefore + after;
    this.cursor = graphemeCount(newBefore);
    this.draw();
  }

  /** Flush do buffer de colagem (chamado antes de teclas de controle ou após pausa na digitação) */
  _flushPendingInput() {
    if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
    if (this._pendingInput && this._pendingInput.length > 0) {
      const segs = [...graphemes(this.input)].map((x) => x.segment);
      const newSegs = [...graphemes(this._pendingInput)].map((x) => x.segment);
      segs.splice(this.cursor, 0, ...newSegs);
      this.input = segs.join('');
      this.cursor += newSegs.length;
      this._pendingInput = null;
      if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
      this.draw();
    }
  }

  menuKey(k) {
    const m = this.menu;
    const list = this.menuItems();
    if (m.keys[k]) {
      const pick = list[m.idx];
      this.menu = null;
      m.resolve({ action: m.keys[k], value: pick ? pick.value : null });
      return this.draw();
    }
    if (k === '\x1b[A') m.idx = Math.max(0, m.idx - 1);
    else if (k === '\x1b[B') m.idx = Math.min(Math.max(0, list.length - 1), m.idx + 1);
    else if (k === '\r' || k === '\n') {
      const pick = list[m.idx];
      this.menu = null;
      m.resolve(pick ? pick.value : null);
    } else if (k === '\x1b') {
      this.menu = null;
      m.resolve(null);
    } else if (k === '\x7f' || k === '\b') {
      m.query = m.query.slice(0, -1);
      m.idx = 0;
    } else if (!k.startsWith('\x1b')) {
      m.query += k;
      m.idx = 0;
    }
    this.draw();
  }

  historyNav(dir) {
    if (!this.history.length) return;
    this.hIdx = Math.min(Math.max(this.hIdx + (dir < 0 ? 1 : -1), -1), this.history.length - 1);
    const entry = this.hIdx === -1 ? '' : this.history[this.history.length - 1 - this.hIdx];
    this.input = String(entry ?? '').replace(/\s*\r?\n\s*/g, ' ');
    this.cursor = [...graphemes(this.input)].length;
  }

  submit() {
    const shown = this.input;
    const text = this.expandPastes(shown);
    this.input = '';
    this.cursor = 0;
    this.hIdx = -1;
    if (this.asker) {
      const a = this.asker;
      this.asker = null;
      return a.resolve(text.trim());
    }
    if (shown.trim()) this.history.push(shown);
    this.onSubmit(text);
  }

  /* ---------- render ---------- */

  renderText(e, w) {
    const out = [];
    const base = e.color || '';
    let code = false;
    for (const raw of san(e.text).split('\n')) {
      if (raw.trim().startsWith('```')) {
        code = !code;
        continue;
      }
      const width = Math.max(4, w - 2);
      if (code) {
        for (const ch of wrapPlain(raw, width)) out.push(pad(`${BG.code}${FG.text}  ${ch}`, w) + R);
        continue;
      }
      // inline() vem ANTES do wrap: quebrar primeiro partia pares de `code`/`**bold**` na metade
      for (const ch of wrapAnsi(inline(raw, base), w)) {
        if (/^#{1,6}\s/.test(vis(ch))) out.push(`${C.b}${FG.accent}${vis(ch).replace(/^#+\s/, '')}${R}`);
        else out.push(base + ch + R);
      }
    }
    return out;
  }

  renderUser(e, w) {
    return wrapPlain('❯ ' + san(e.text), Math.max(4, w - 2)).map((ch) => pad(`${BG.user}${FG.text} ${ch}`, w) + R);
  }

  renderThink(e, w, live = false) {
    const label = live ? 'Pensando…' : `pensou (${e.text.length} chars)`;
    const out = [`${FG.dim}${C.i}∴ ${label}${R}`];
    if (this.expanded) for (const ch of wrapPlain(san(e.text), Math.max(4, w))) out.push(`${FG.dim}${C.i}${ch}${R}`);
    else if (e.text) {
      // preview de 1 linha: sem isso o bloco parecia ter sido apagado ao terminar
      const first = san(e.text).split('\n').find((l) => l.trim()) || '';
      if (first) out.push(pad(`${FG.dim}${C.i}  ${cutAnsi(first, Math.max(4, w - 2)).text}`, Math.max(4, w)) + R);
    }
    return out;
  }

  /** "3.4s" / "1m02s" a partir de milissegundos */
  static fmtElapsed(ms) {
    if (!ms || ms < 0) return '0.0s';
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  }

  /** Milissegundos decorridos nesta caixa (congela quando ela termina) */
  elapsedOf(e) {
    if (!e || !e.startedAt) return 0;
    return (e.endedAt || Date.now()) - e.startedAt;
  }

  renderTool(e, w) {
    const shell = SHELL_TOOLS.test(String(e.title || ''));
    const bg = shell
      ? e.status === 'err' ? BG.bashErr : BG.bashOk   // shell: corpo sempre preto
      : e.status === 'ok' ? BG.ok : e.status === 'err' ? BG.err : BG.run;
    const bgHead = shell ? BG.bashHead : bg;
    // trilha lateral: a cor de estado fica só nela, o resto da caixa é preto
    const rail = shell
      ? e.status === 'err' ? RAIL_ERR : e.status === 'run' ? RAIL_RUN : RAIL_OK
      : e.status === 'err' ? FG.err : e.status === 'run' ? FG.warn : FG.ok;
    const MARK = '\u258c'; // ▌
    const fgTitle = shell ? SHELL_FG_BOLD : `${C.b}${FG.text}`;
    const fgSub = shell ? SHELL_FG : FG.dim;
    const fgIcon = shell
      ? e.status === 'err' ? `${C.b}${FG.err}` : e.status === 'run' ? `${C.b}${FG.warn}` : `${C.b}${FG.ok}`
      : e.status === 'err' ? FG.err : FG.ok;
    const icon =
      e.status === 'run'
        ? `${fgIcon}${SPIN[this.spin % SPIN.length]}`
        : e.status === 'err'
          ? `${fgIcon}\u2718`
          : `${fgIcon}\u2714`;
    // tempo decorrido sempre visivel, congelado quando a caixa termina
    const elapsed = e.startedAt ? `${shell ? SHELL_FG : FG.dim}  ${TUI.fmtElapsed(this.elapsedOf(e))}` : '';
    const sub = e.subtitle ? `${fgSub}  ${e.subtitle}` : '';
    const head = `${bgHead}${rail}${MARK}${bgHead}${fgTitle} ${e.title}${R}${bgHead}${sub}${elapsed}${R}${bgHead}  ${icon}${R}${bgHead}`;
    const out = [pad(head, w) + R];

    const rows = e.lines;
    // aberto = estado do próprio bloco (clique) ou, se nunca clicado, o global (ctrl+o)
    const open = e.expanded ?? this.expanded;
    const limit = open || rows.length <= COLLAPSE_ROWS ? rows.length : COLLAPSE_ROWS;
    const hidden = rows.length - limit;
    const inner = Math.max(4, w - 4); // ▌(1) + espaço(1) + │(1) + espaço(1) = 4 colunas de moldura

    const shown = rows.slice(0, limit);
    for (const row of shown) {
      const col = shell
        ? row.t === 'e'
          ? `${C.b}${FG.err}`
          : row.t === '+'
            ? FG.add
            : row.t === '-'
              ? FG.del
              : SHELL_FG
        : row.t === '+' ? FG.add : row.t === '-' ? FG.del : row.t === 'e' ? FG.err : row.t === ' ' ? FG.text : FG.dim;
      const prefix = row.t === '+' ? '+ ' : row.t === '-' ? '- ' : row.t === 'e' ? '! ' : '  ';
      // san(): \r de barra de progresso e \t da saída voltavam o cursor / estouravam a largura
      for (const ch of wrapPlain(prefix + san(row.s), inner))
        out.push(pad(`${bg}${rail}${MARK}${bg}${col} \u2502 ${ch}`, w) + R);
    }

    // rodapé: diz o que o clique faz neste bloco (antes a dica ficava no topo e sumia)
    if (rows.length > 0) {
      const tip =
        hidden > 0
          ? `\u25bc ${hidden} linhas ocultas — clique ou ctrl+o para expandir`
          : `\u25b2 clique ou ctrl+o para recolher`;
      out.push(pad(`${bg}${rail}${MARK}${bg}${shell ? SHELL_FG : FG.dim} ${tip}`, w) + R);
    }
    return out;
  }

  renderAll(w, owners = null) {
    const out = [];
    const key = `${w}|${this.expanded}`;
    for (const e of this.entries) {
      // Cache por entrada. Para tools a chave inclui estado/linhas, senão o bloco congelava
      // em "run"; com o cache por linha, cada quadro só re-renderiza o que realmente mudou.
      const ekey =
        e.kind === 'tool'
          ? `${key}|${e.expanded ?? ''}|${e.status}|${e.status === 'run' ? this.spin : ''}|${e.lines.length}|${e.lines[e.lines.length - 1]?.s ?? ''}|${e.subtitle ?? ''}|${e.endedAt ?? 0}`
          : e.kind === 'thinking'
            ? `${key}|${e.text.length}`
            : key;
      if (!e._cache || e._cache.key !== ekey) {
        let lines = [];
        if (e.kind === 'tool') lines = this.renderTool(e, w);
        else if (e.kind === 'text') lines = this.renderText(e, w);
        else if (e.kind === 'user') lines = this.renderUser(e, w);
        else if (e.kind === 'thinking') lines = this.renderThink(e, w);
        e._cache = { key: ekey, lines };
      }
      for (const _l of e._cache.lines) out.push(_l);
      if (owners) for (let k = 0; k < e._cache.lines.length; k++) owners.push(e);
      out.push(''); // separador entre blocos: não é clicável
      if (owners) owners.push(null);
    }
    if (this.partialThink) {
      const lines = this.renderThink({ text: this.partialThink }, w, true);
      for (const l of lines) out.push(l);
      if (owners) for (let k = 0; k < lines.length; k++) owners.push(null);
    }
    if (this.partial) {
      const lines = this.renderText({ text: this.partial }, w);
      for (const l of lines) out.push(l);
      if (owners) for (let k = 0; k < lines.length; k++) owners.push(null);
    }
    return out;
  }

  totalLines() {
    return this.renderAll(this.cols).length;
  }

  menuLines(cols) {
    const m = this.menu;
    const list = this.menuItems();
    const w = cols;
    const maxShow = 10;
    const start = Math.max(0, Math.min(m.idx - Math.floor(maxShow / 2), list.length - maxShow));
    const lines = [
      `${C.b}${FG.accent}${m.title}${R}`,
      `${FG.dim}Search: ${R}${m.query}`,
    ];
    if (!list.length) lines.push(`${FG.dim}  nenhum resultado${R}`);
    list.slice(start, start + maxShow).forEach((it, i) => {
      const idx = start + i;
      const sel = idx === m.idx;
      const label = dwidth(it.label) > w - 4 ? cutAnsi(it.label, w - 5).text + '…' : it.label;
      lines.push(
        sel
          ? pad(`${BG.sel}${C.b}${FG.text} ▸ ${label}`, w) + R
          : pad(`${FG.text}   ${label}`, w),
      );
    });
    const extra = m.hint ? ` • ${m.hint}` : '';
    lines.push(`${FG.dim}Type to search • ↑↓ move • enter confirm • esc cancel${extra}${R}`);
    return lines;
  }

    /** Renderiza a linha de input com cursor visível, respeitando a largura disponível */
  renderInput(prompt, room) {
    const visPrompt = vis(prompt);
    const promptW = dwidth(visPrompt);
    const leftOver = Math.max(0, room - promptW - 2);

    // trabalha com graphemes para emoji/acento não partirem no meio
    const segs = [...graphemes(this.input)].map((x) => (/[\x00-\x1f\x7f]/.test(x.segment) ? ' ' : x.segment));
    const widths = segs.map((s) => graphemeW(s));

    // cursor limitado pelo número de graphemes
    const cur = Math.max(0, Math.min(this.cursor, segs.length));

    // cursor em índice de grapheme
    let cIdx = cur;
    let cW = 0;
    for (let i = 0; i < cIdx && i < segs.length; i++) cW += widths[i];

    // coluna do cursor na linha física (prompt + espaço + texto antes do cursor)
    this._cursorCol = 1 + dwidth(visPrompt) + 1 + cW; // 1-based coluna

    const totalW = dwidth(this.input);
    if (totalW <= leftOver) {
      const padSpaces = ' '.repeat(leftOver - totalW);
      if (cIdx < segs.length) {
        const before = segs.slice(0, cIdx).join('');
        const ch = segs[cIdx] || '';
        const after = segs.slice(cIdx + 1).join('');
        return prompt + ' ' + before + '\x1b[7m' + ch + R + '\x1b[27m' + after + padSpaces + ' ' + R;
      } else {
        return prompt + ' ' + this.input + padSpaces + ' ' + R;
      }
    }

    // janela rolável centrada no cursor
    let targetStart = Math.max(0, cW - Math.floor(leftOver / 2));
    let start = 0;
    let acc = 0;
    while (start < segs.length && acc + widths[start] <= targetStart) { acc += widths[start]; start++; }

    let used = 0;
    let end = start;
    while (end < segs.length && used + widths[end] <= leftOver) { used += widths[end]; end++; }

    const before = segs.slice(0, start).join('');
    const show = segs.slice(start, end).join('');
    const beforeW = dwidth(before);
    const showW = dwidth(show);
    const rightPad = Math.max(0, leftOver - beforeW - showW);

    if (cIdx >= start && cIdx < end) {
      const beforeCur = segs.slice(start, cIdx).join('');
      const ch = segs[cIdx] || '';
      const afterCur = segs.slice(cIdx + 1, end).join('');
      return prompt + ' ' + before + beforeCur + '\x1b[7m' + ch + R + '\x1b[27m' + afterCur + ' '.repeat(rightPad) + ' ' + R;
    } else if (cIdx < start) {
      const ch = segs[0] || '';
      const rest = segs.slice(1, end).join('');
      return prompt + ' ' + '\x1b[7m' + ch + R + '\x1b[27m' + rest + ' '.repeat(leftOver - dwidth(segs.slice(0, end).join(''))) + ' ' + R;
    } else {
      const last = end - 1;
      const beforeShow = segs.slice(start, last).join('');
      const ch = segs[last] || '';
      return prompt + ' ' + beforeShow + '\x1b[7m' + ch + R + '\x1b[27m' + ' '.repeat(rightPad + 1) + ' ' + R;
    }
  }

  /** Agenda um desenho; várias chamadas seguidas viram um só quadro (~25 fps no máximo) */
  draw() {
    if (this.drawTimer) return;
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      this.paint();
    }, 40);
  }

  paint() {
    const cols = this.cols;
    const rows = this.rows;
    const dock = this.dockLines();
    if (this.busyLabel) {
      const frame = ['|', '/', '-', '\\'][this.spin % 4];
      const dots = '.'.repeat((this.spin % 3) + 1).padEnd(3);
      const secs = Math.floor((Date.now() - (this.busyStart || Date.now())) / 1000);
      dock.push(`${FG.warn}${frame} Working${dots} ${FG.dim}· ${this.busyLabel} · ${secs}s · ESC para interromper${R}`);
    }
    const bodyH = Math.max(3, rows - 4 - dock.length);
    const owners = [];
    const all = this.renderAll(cols, owners);
    const end = Math.max(0, all.length - this.scroll);
    // slice do corpo junto com os donos: é isso que permite saber em qual bloco
    // o usuário clicou (o número da linha sozinho não diz nada)
    const from = Math.max(0, end - bodyH);
    let body = all.slice(from, end);
    const bodyOwners = owners.slice(from, end);
    const shift = Math.max(0, bodyH - body.length);
    while (body.length < bodyH) body.unshift('');
    // header ocupa a linha 1 da tela, então body[0] está na linha 2
    this._bodyMap = { top: 2, shift, owners: shift ? [...Array(shift).fill(null), ...bodyOwners] : bodyOwners };
    if (this.menu) {
      const m = this.menuLines(cols).slice(-bodyH);
      const keep = Math.max(0, bodyH - m.length);
      body = [...(keep ? body.slice(-keep) : []), ...m];
      this._bodyMap = null; // menu aberto: clique não deve expandir bloco nenhum
    }

    const left = `${BG.head}${C.b}${FG.text} ✦ Kiro Code ${R}${BG.head}${FG.dim} ${this.status}`;
    const header = pad(left, cols);

    const sep = `${FG.dim}${'─'.repeat(cols)}${R}`;
    const prompt = this.asker ? `${FG.warn}${this.asker.prompt}${R} ` : `${C.green}${C.b}❯${R} `;
    const room = Math.max(1, cols - dwidth(vis(prompt)) - 1);
    const input = this.renderInput(prompt, room);
    const scrollNote = this.scroll > 0 ? `  ↑ ${this.scroll} acima` : '';
    const foot = `${FG.dim}${this.footer}${scrollNote}${R}`;

    // Nada de '\n' entre as linhas: um '\n' depois de uma linha exatamente da largura da tela
    // dispara o wrap pendente do terminal e rola a tela (metade da TUI sumia no /resume).
    // Cada linha vai para sua posição absoluta com CUP.
    const rowsToDraw = [header, ...body, ...dock, sep, input, foot].slice(0, rows);
    const next = [];
    for (let i = 0; i < rows; i++) next.push(i < rowsToDraw.length ? pad(rowsToDraw[i], cols) + R : '');
    // guarda a linha física da input para posicionar o cursor real do terminal
    this._inputRow = rowsToDraw.length - 2; // input está antes do foot
    this.paintDiff(next, cols, rows);
  }

  /**
   * Só reescreve as linhas que mudaram. Antes o quadro inteiro era reescrito a cada 40ms
   * (spinner, input, status) e o terminal repintava a tela toda — era isso que tremia.
   */
  paintDiff(next, cols, rows) {
    const prev = this._prevFrame && this._prevFrame.rows === rows && this._prevFrame.cols === cols ? this._prevFrame.lines : null;
    let frame = '\x1b[?2026h';
    const dirtyAll = !prev || prev.length !== next.length;
    let cursorTo = this._cursorRow;
    const pendingCursor = rows - 1; // linha do footer: mantém o cursor ali (invisível, mas estável)

    for (let i = 0; i < next.length; i++) {
      const line = next[i];
      if (!dirtyAll && prev[i] === line) continue;
      frame += `\x1b[${i + 1};1H`;
      // R antes do \x1b[K: sem reset o terminal apaga usando o fundo ATIVO (BCE) e
      // sobravam faixas coloridas / caixas fantasmas no lugar das linhas limpas.
      if (line) frame += line + R + '\x1b[K';
      else frame += R + '\x1b[K';
      cursorTo = i;
    }
    // posiciona o cursor real do terminal na linha da input (edição)
    // isso precisa ser enviado mesmo se nada mudou na tela (setas movem só o cursor)
    if (this._inputRow != null && this._cursorCol != null) {
      frame += `\x1b[${this._inputRow + 1};${this._cursorCol}H`;
    } else {
      frame += `\x1b[${pendingCursor + 1};1H`;
    }
    frame += '\x1b[?2026l';
    process.stdout.write(frame);
    this._prevFrame = { rows, cols, lines: next };
    this._cursorRow = pendingCursor;
  }
}
