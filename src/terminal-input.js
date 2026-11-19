// Decodifica colagens sem tratar as quebras de linha como Enter/Enviar.
// Suporta delimitadores bracketed-paste fragmentados entre eventos stdin.
const START = '\x1b[200~';
const END = '\x1b[201~';

export class TerminalInput {
  constructor({ onKeys, onPaste, now = Date.now, graceMs = 250 }) {
    this.onKeys = onKeys;
    this.onPaste = onPaste;
    this.now = now;
    this.graceMs = graceMs;
    this.buffer = '';
    this.pasting = false;
    this.pasteUntil = 0;
    this.lastCR = false;
  }

  insert(text) {
    if (!text) return;
    // CRLF pode estar dividido entre dois pacotes do terminal.
    if (this.lastCR && text.startsWith('\n')) text = text.slice(1);
    this.lastCR = text.endsWith('\r');
    text = text.replace(/\r\n?/g, '\n');
    // Não executar escapes/controles que vierem dentro da área de transferência.
    text = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (text) this.onPaste(text);
  }

  plain(text) {
    if (!text) return;
    const now = this.now();
    const plain = !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
    // Alguns terminais Android não implementam bracketed paste. Um pacote
    // de texto com vários caracteres inicia uma janela de colagem; pacotes
    // seguintes (inclusive CR/LF isolados) continuam no editor, sem enviar.
    if (plain && (text.length > 1 || now < this.pasteUntil)) {
      this.pasteUntil = now + this.graceMs;
      this.insert(text);
    } else {
      this.lastCR = false;
      this.onKeys(text);
    }
  }

  feed(data) {
    this.buffer += String(data);
    while (this.buffer) {
      const marker = this.pasting ? END : START;
      const at = this.buffer.indexOf(marker);
      if (at >= 0) {
        const text = this.buffer.slice(0, at);
        if (this.pasting) this.insert(text); else this.plain(text);
        this.buffer = this.buffer.slice(at + marker.length);
        this.pasting = !this.pasting;
        this.lastCR = false;
        if (!this.pasting) this.pasteUntil = this.now() + this.graceMs;
        continue;
      }
      // Guarda só o sufixo que pode ser parte de um delimitador incompleto.
      let keep = 0;
      for (let n = 1; n < marker.length && n <= this.buffer.length; n++) {
        if (marker.startsWith(this.buffer.slice(-n))) keep = n;
      }
      const text = keep ? this.buffer.slice(0, -keep) : this.buffer;
      this.buffer = keep ? this.buffer.slice(-keep) : '';
      if (this.pasting) this.insert(text); else this.plain(text);
      break;
    }
  }

  // Libera um Escape isolado sem deixar o início de um paste vazar como tecla.
  flushEscape() {
    if (!this.pasting && this.buffer === '\x1b') {
      this.buffer = '';
      this.onKeys('\x1b');
    }
  }
}
