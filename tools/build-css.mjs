#!/usr/bin/env node
// Regenerates the inline Tailwind CSS block (between /* tw:start */ and /* tw:end */) in each page.
//
// The pages have no build step: they're opened as-is. Run this only after adding or changing
// Tailwind classes, so each page's inline stylesheet includes them.
//
//   node tools/build-css.mjs                 (index.html and submit.html)
//   node tools/build-css.mjs submit.html     (one page)
//
// Uses Tailwind CSS 3.4.17 via npx (or set TAILWIND_BIN to a local tailwindcss binary).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '/* tw:start */';
const END = '/* tw:end */';
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['index.html', 'submit.html'];

for (const page of pages) {
  const file = fileURLToPath(new URL('../' + page, import.meta.url));
  const html = readFileSync(file, 'utf8');
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('tw:start / tw:end markers not found in ' + page);

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
    console.log('Inlined ' + css.length + ' bytes of compiled CSS into ' + page);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
