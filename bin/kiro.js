#!/usr/bin/env node
import { run } from '../src/app.js';

run().catch((err) => {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  console.error('\x1b[31mErro fatal:\x1b[0m', err?.stack || err);
  process.exit(1);
});
