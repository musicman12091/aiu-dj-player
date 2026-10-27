// Browser integration checks with real Web Audio signals and an injected capture stream.
// This does NOT verify the operating-system picker, Suno, or Discord capture.
// PUPPETEER_RESOLVE_FROM=/path/to/package.json CHROME=/path/to/chromium \
//   node tools/verify-visualizer.mjs [http://127.0.0.1:8765/index.html]
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(process.env.PUPPETEER_RESOLVE_FROM || import.meta.url);
const puppeteer = require('puppeteer-core');
let DECK = process.argv[2];
let server;
if (!DECK) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!/^\/[a-zA-Z0-9_.-]+$/.test(path)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(join(root, path.slice(1)));
      response.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  DECK = 'http://127.0.0.1:' + server.address().port + '/index.html';
}
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const ARTIFACT_DIR = process.env.VIZ_TEST_ARTIFACT_DIR || '/tmp/aiu-visualizer-tests';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log('  ok  ' + message);
}

async function boot(browser, { missingModule = false, force2d = false, mobile = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, deviceScaleFactor: 1 } : { width: 1400, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (missingModule && new URL(url).pathname.endsWith('/audio-reactivity.js')) return req.abort();
    if (/^https?:/.test(url) && new URL(url).origin !== new URL(DECK).origin) return req.abort();
    req.continue();
  });
  await page.evaluateOnNewDocument(({ force2d, mobile }) => {
    localStorage.setItem('aiu_worker_url', 'http://127.0.0.1:9');
    localStorage.removeItem('aiu_host_key');
    localStorage.removeItem('aiu_visualizer');
    localStorage.setItem('aiu_auto_advance', 'off');
    window.__vizTest = { requests: [], connections: [], contexts: [], streams: [] };
    const originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {
      window.__vizTest.connections.push({ source: this, destination });
      return originalConnect.call(this, destination, ...rest);
    };
    if (force2d) {
      const originalContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (/webgl/.test(type)) return null;
        return originalContext.call(this, type, ...args);
      };
    }
    if (mobile) {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: undefined });
      return;
    }
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value(options) {
        const test = window.__vizTest;
        test.requests.push({ options, userGesture: navigator.userActivation.isActive });
        const context = new AudioContext({ latencyHint: 'interactive' });
        context.resume();
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 80;
        const gain = context.createGain();
        gain.gain.value = 0.2;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        canvas.getContext('2d').fillRect(0, 0, 16, 16);
        const video = canvas.captureStream(1).getVideoTracks()[0];
        const getSettings = video.getSettings.bind(video);
        video.getSettings = () => ({ ...getSettings(), displaySurface: 'browser' });
        const stream = new MediaStream([...destination.stream.getAudioTracks(), video]);
        test.contexts.push(context);
        test.streams.push(stream);
        test.current = { context, oscillator, gain, stream, canvas };
        return Promise.resolve(stream);
      }
    });
  }, { force2d, mobile });
  await page.goto(DECK, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__aiuDeck && !!document.getElementById('btnAdvanceNext'));
  await delay(150);
  return { page, errors };
}

async function start(page) {
  await page.click('#btnVizSync');
  await page.waitForFunction(() => window.__aiuDeck.viz.capture.active && window.__aiuDeck.viz.feat.level > 0.05);
  await delay(350);
}

async function features(page) {
  return page.evaluate(() => {
    const viz = window.__aiuDeck.viz;
    return { ...viz.feat, motion: viz.motionTime, hasSignal: viz.signal && viz.signal.hasSignal, gl: !!viz.gl, glFailed: viz.glFailed, label: document.getElementById('vizLabel').textContent };
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
try {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  console.log('1. Real generated bass/treble input drives features and visuals');
  const { page, errors } = await boot(browser);
  check(await page.$eval('#btnVizSync', (button) => !button.disabled), 'audio-sync control available');
  check((await features(page)).level === 0, 'no capture means zero measured energy');
  await start(page);
  const captureRequest = await page.evaluate(() => window.__vizTest.requests[0]);
  check(captureRequest.userGesture, 'capture requested during the button gesture');
  check(captureRequest.options.audio && captureRequest.options.video, 'capture requests both tab audio and required video');
  check(captureRequest.options.selfBrowserSurface === 'include' && captureRequest.options.preferCurrentTab === true, 'current tab is offered and preferred');
  check(captureRequest.options.audio.suppressLocalAudioPlayback === false, 'original Suno output is not intentionally muted');
  const bass = await features(page);
  check(bass.bass > bass.high && bass.hasSignal, '80 Hz signal appears in bass rather than treble');
  check(bass.motion > 0 && /Live audio/.test(bass.label), 'measured signal advances shader time and labels live audio');
  check(await page.evaluate(() => {
    const capture = window.__aiuDeck.viz.capture;
    return window.__vizTest.connections.every((item) => item.source.context !== capture.context || item.destination !== capture.context.destination);
  }), 'capture analysis has no connection to the speakers');
  const gl = await page.evaluate(() => {
    const viz = window.__aiuDeck.viz;
    return { active: !!viz.gl, programs: viz.gl ? viz.gl.progs.length : 0, error: viz.gl ? viz.gl.gl.getError() : null };
  });
  check(gl.active && gl.programs === 5 && gl.error === 0, 'all five WebGL programs compile and draw without GL errors');
  for (let scene = 1; scene < 5; scene++) await page.click('#btnVizScene');
  await page.screenshot({ path: join(ARTIFACT_DIR, 'visualizer-desktop.png'), fullPage: true });
  await page.evaluate(() => { window.__vizTest.current.oscillator.frequency.value = 6000; });
  await page.waitForFunction(() => window.__aiuDeck.viz.feat.high > window.__aiuDeck.viz.feat.bass);
  await delay(350);
  const treble = await features(page);
  check(treble.high > treble.bass && treble.high > bass.high, '6000 Hz change moves response to treble');

  console.log('2. Silence decays to idle; no procedural beat continues');
  await page.evaluate(() => { window.__vizTest.current.gain.gain.value = 0; });
  await page.waitForFunction(() => window.__aiuDeck.viz.feat.level <= 0.001, { timeout: 5000 });
  const silentA = await features(page);
  await delay(250);
  const silentB = await features(page);
  check(!silentB.hasSignal && Math.abs(silentB.motion - silentA.motion) < 0.000001, 'silent input stops geometry travel');
  check(/waiting for sound/.test(silentB.label), 'silence is explicitly labelled');
  await page.evaluate(() => { window.__vizTest.current.gain.gain.value = 0.2; });
  await page.waitForFunction(() => window.__aiuDeck.viz.feat.level > 0.05);
  check((await features(page)).motion > silentB.motion, 'returning audio resumes motion');

  console.log('3. Stopping/revoking capture cleans up and leaves the source generator running');
  await page.click('#btnVizSync');
  await page.waitForFunction(() => !window.__aiuDeck.viz.capture.active && window.__aiuDeck.viz.feat.level === 0);
  check(await page.evaluate(() => window.__vizTest.streams[0].getTracks().every((track) => track.readyState === 'ended')), 'Stop audio sync ends captured tracks');
  check(await page.evaluate(() => window.__vizTest.current.context.state === 'running'), 'stopping sync does not stop the original source context');
  check(await page.$eval('#btnVizSync', (button) => button.textContent === 'Sync to music'), 'button returns to connect state');
  await start(page);
  await page.evaluate(() => {
    const track = window.__vizTest.current.stream.getAudioTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended')); // stop() itself deliberately does not fire ended.
  });
  await page.waitForFunction(() => !window.__aiuDeck.viz.capture.active && window.__aiuDeck.viz.feat.level === 0);
  check(await page.$eval('#vizSyncStatus', (status) => /stopped/i.test(status.textContent)), 'revoked capture has reconnect status');
  check(errors.length === 0, 'desktop has no uncaught page errors: ' + errors.join('; '));
  await page.close();

  console.log('4. 2D fallback also renders real measured audio');
  {
    const { page, errors } = await boot(browser, { force2d: true });
    await start(page);
    const state = await features(page);
    check(state.glFailed && !state.gl && state.level > 0.05, 'real audio uses 2D when WebGL is unavailable');
    check(await page.evaluate(() => {
      const canvas = document.getElementById('visualizerCanvas');
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let cyan = 0;
      for (let i = 0; i < bytes.length; i += 4) if (bytes[i + 1] > 100 && bytes[i + 2] > 100) cyan++;
      return cyan > 20;
    }), 'fallback draws visible frequency/waveform pixels');
    check(errors.length === 0, '2D fallback has no uncaught errors');
    await page.close();
  }

  console.log('5. Missing module does not prevent queue boot');
  {
    const { page, errors } = await boot(browser, { missingModule: true });
    check(await page.evaluate(() => !!window.__aiuDeck.getState() && window.__aiuDeck.viz.capture === null), 'deck state exists without visualizer module');
    check(await page.$eval('#btnVizSync', (button) => button.disabled), 'unavailable sync is disabled');
    await page.click('[data-tab="played"]');
    check(await page.evaluate(() => window.__aiuDeck.getState().activeTab === 'played'), 'queue tab controls remain functional');
    check(errors.length === 0, 'missing module produces no uncaught script error');
    await page.close();
  }

  console.log('6. Mobile unsupported state stays usable');
  {
    const { page, errors } = await boot(browser, { mobile: true });
    check(await page.$eval('#btnVizSync', (button) => button.disabled), 'phone without capture API disables sync');
    check(await page.$eval('#vizSyncStatus', (status) => /host PC/.test(status.textContent)), 'phone explains host-PC capture');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone layout does not overflow horizontally');
    await page.screenshot({ path: join(ARTIFACT_DIR, 'visualizer-phone.png'), fullPage: true });
    check(errors.length === 0, 'phone has no uncaught page errors');
    await page.close();
  }
  console.log('PASS: ' + checks + ' browser checks. Synthetic capture only; live Suno/Discord rehearsal remains required.');
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
