import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : /\.(m?js)$/.test(entry.name) ? [file] : [];
  });
}
const files = ['bin', 'src', 'examples', 'scripts'].flatMap((dir) => walk(path.join(root, dir)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Sintaxe válida em ${files.length} arquivos JavaScript. Nenhum módulo da aplicação foi executado.`);
