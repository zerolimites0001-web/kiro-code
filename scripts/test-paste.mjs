import assert from 'node:assert/strict';
import { TerminalInput } from '../src/terminal-input.js';
import { TUI } from '../src/tui.js';

function harness() {
  let time = 1000;
  const keys = [], text = [];
  const input = new TerminalInput({
    onKeys: (s) => keys.push(s), onPaste: (s) => text.push(s), now: () => time,
  });
  return { input, keys, text, wait: (ms) => { time += ms; } };
}

// Todo ponto de divisão dos delimitadores/payload, incluindo CRLF separado.
const wire = '\x1b[200~primeira\r\nsegunda\nterceira\x1b[201~';
for (let split = 0; split <= wire.length; split++) {
  const h = harness();
  h.input.feed(wire.slice(0, split));
  h.input.feed(wire.slice(split));
  assert.equal(h.text.join(''), 'primeira\nsegunda\nterceira');
  assert.deepEqual(h.keys, []);
}
{
  const h = harness();
  for (const ch of wire) h.input.feed(ch);
  assert.equal(h.text.join(''), 'primeira\nsegunda\nterceira');
  assert.deepEqual(h.keys, []);
  h.wait(300);
  h.input.feed('\r');
  assert.deepEqual(h.keys, ['\r']); // só o Enter manual após colar envia
}
{
  const h = harness();
  for (const part of ['Texto colado', '\r', '\n', 'em partes', '\n', 'fim']) {
    h.input.feed(part);
    h.wait(30);
  }
  assert.equal(h.text.join(''), 'Texto colado\nem partes\nfim');
  assert.deepEqual(h.keys, []); // fallback Android sem bracketed-paste
}
{
  const h = harness();
  h.input.feed('\x1b[D');
  h.input.feed('\x1b');
  h.input.flushEscape();
  assert.deepEqual(h.keys, ['\x1b[D', '\x1b']);
}
// Integração: nenhuma chamada de submit/onSubmit durante colagem multilinha.
{
  const tui = new TUI();
  tui.draw = () => {};
  let sent = 0;
  tui.onSubmit = () => { sent++; };
  for (const part of ['\x1b[20', '0~olá\n', 'texto\r', '\ncom emoji 💛', '\x1b[201', '~']) {
    tui.onData(part);
  }
  assert.equal(sent, 0);
  assert.equal(tui.input, 'olá\ntexto\ncom emoji 💛');
  clearTimeout(tui._pasteEscapeTimer);
  tui.terminalInput.pasteUntil = 0;
  tui.onData('\r');
  assert.equal(sent, 1);
  clearTimeout(tui._pasteEscapeTimer);
}
console.log('Paste: delimitadores fragmentados, Android sem delimitador, CRLF, emoji e envio manual OK.');
