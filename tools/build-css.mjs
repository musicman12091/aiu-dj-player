#!/usr/bin/env node
// Regenerates the inline Tailwind CSS block in index.html (between /* tw:start */ and /* tw:end */).
//
// The deck itself has no build step: index.html is opened as-is. Run this only after
// adding or changing Tailwind classes, so the inline stylesheet includes them.
//
//   node tools/build-css.mjs
//
// Uses Tailwind CSS 3.4.17 via npx (or set TAILWIND_BIN to a local tailwindcss binary).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../index.html', import.meta.url));
const html = readFileSync(file, 'utf8');
const START = '/* tw:start */';
const END = '/* tw:end */';
const a = html.indexOf(START);
const b = html.indexOf(END);
if (a < 0 || b < a) throw new Error('tw:start / tw:end markers not found in index.html');

const dir = mkdtempSync(join(tmpdir(), 'deck-css-'));
try {
  // Scan the page without the old CSS so stale classes don't keep themselves alive.
  const content = join(dir, 'content.html');
  writeFileSync(content, html.slice(0, a) + html.slice(b + END.length));
  writeFileSync(join(dir, 'in.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  const args = ['-i', join(dir, 'in.css'), '-o', join(dir, 'out.css'), '--content', content, '--minify'];
  if (process.env.TAILWIND_BIN) {
    execFileSync(process.env.TAILWIND_BIN, args, { stdio: 'inherit' });
  } else {
    execFileSync('npx', ['--yes', 'tailwindcss@3.4.17', ...args], { stdio: 'inherit' });
  }
  const css = readFileSync(join(dir, 'out.css'), 'utf8').trim();
  writeFileSync(file, html.slice(0, a) + START + '\n' + css + '\n' + END + html.slice(b + END.length));
  console.log('Inlined ' + css.length + ' bytes of compiled CSS into index.html');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
