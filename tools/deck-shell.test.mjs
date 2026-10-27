// THADEUS-009: visualizer removed, direct-stream warning stays off, PWA shell is wired.
// Run: node --test tools/deck-shell.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const submitHtml = await readFile(new URL('../submit.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

function outsideCompiledCss(html) {
  return html.replace(/<style id="tailwind-compiled">[\s\S]*?<\/style>/, '');
}

test('host deck has no visualizer DOM, shaders, or audio-hook script', () => {
  const page = outsideCompiledCss(indexHtml);
  for (const gone of [
    'visualizerCanvas',
    'vizGL',
    'btnVizScene',
    'btnVizSync',
    'vizLabel',
    'modeBadge',
    'audio-reactivity.js',
    'getContext(\'webgl\'',
    'gl_FragColor',
    'Cyber Tunnel',
    'Sync to music',
    '<canvas'
  ]) {
    assert.equal(page.includes(gone), false, gone + ' still in the deck');
  }
  assert.match(page, /id="npTitle"/);
  assert.match(page, /id="npArtist"/);
  assert.match(page, /id="npExternalLink"/);
  assert.match(page, /id="sunoEmbedFrame"/);
  assert.match(page, /id="sunoPreCueFrame"/);
  assert.match(page, /id="preCueSlot"/);
  assert.match(page, /id="btnAdvanceNext"/);
  assert.match(page, /Play Next/);
  assert.match(page, /id="btnReloadCurrent"/);
  assert.match(page, /id="btnMarkFailed"/);
  assert.match(page, /id="btnAutoToggle"/);
  assert.match(page, /id="btnHold"/);
  assert.match(page, /id="btnPlus30"/);
  assert.match(page, /id="addLinkForm"/);
  assert.match(page, /data-tab="incoming"/);
  assert.match(page, /data-tab="queued"/);
  assert.match(page, /data-tab="failed"/);
  assert.match(page, /function startEmbedFrameClock/);
  assert.match(page, /function maybeEmbedAdvance/);
});

test('direct stream stays off and the warning banner is not in the page', () => {
  assert.match(indexHtml, /const STREAM_ENABLED = false;/);
  assert.equal(indexHtml.includes('Direct stream unavailable'), false);
  assert.equal(indexHtml.includes('canPlayDirectAudio'), false);
  assert.match(indexHtml, /if \(!STREAM_ENABLED\)/);
});

test('both pages link the manifest, Apple web-app metas, and the service worker', () => {
  for (const html of [indexHtml, submitHtml]) {
    assert.match(html, /<link rel="manifest" href="\.\/manifest\.json"\s*\/?>/);
    assert.match(html, /<meta name="theme-color" content="#090b10"\s*\/?>/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"\s*\/?>/);
    assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"\s*\/?>/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="AIU Deck"\s*\/?>/);
    assert.match(html, /navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
  }
});

test('manifest is a standalone portrait app with installable PNG icons', () => {
  assert.equal(manifest.name, 'AI: Underground DJ Deck');
  assert.equal(manifest.short_name, 'AIU Deck');
  assert.equal(manifest.start_url, './index.html');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.equal(manifest.background_color, '#090b10');
  assert.equal(manifest.theme_color, '#090b10');
  const anyIcons = manifest.icons.filter((icon) => icon.purpose === 'any');
  assert.deepEqual(anyIcons.map((icon) => icon.sizes).sort(), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\.\/icons\/.+\.png$/);
    assert.equal(icon.type, 'image/png');
    const png = readFileSync(new URL('../' + icon.src.slice(2), import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(String(width) + 'x' + String(height), icon.sizes);
  }
  assert.equal(manifest.shortcuts[0].short_name, 'Submit');
  assert.equal(manifest.shortcuts[0].url, './submit.html');
  const shortcut = manifest.shortcuts[0].icons[0];
  const shortcutPng = readFileSync(new URL('../' + shortcut.src.slice(2), import.meta.url));
  assert.equal(shortcutPng.readUInt32BE(16), 192);
});

test('service worker caches the app shell and leaves the Worker and Suno alone', () => {
  assert.match(sw, /if \(url\.origin !== self\.location\.origin\) return;/);
  assert.match(sw, /addEventListener\('fetch'/);
  assert.equal(sw.includes('aiu-dj-worker.musicman12091.workers.dev'), false);
  assert.equal(sw.includes('suno.com'), false);
  for (const file of ['index.html', 'submit.html', 'deck-slots.js', 'manifest.json', 'icon-192.png', 'icon-512.png']) {
    assert.match(sw, new RegExp(file.replace('.', '\\.')));
  }
});
