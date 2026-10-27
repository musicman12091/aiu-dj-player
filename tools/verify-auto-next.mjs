// Deck auto-next checks. Uses system Chrome via puppeteer-core.
//   NODE_PATH=/path/to/node_modules node tools/verify-auto-next.mjs
// Serves nothing; pass the deck URL as argv[2] (default http://127.0.0.1:8765/index.html).

import { createRequire } from 'node:module';

const require = createRequire(process.env.PUPPETEER_RESOLVE_FROM || import.meta.url);
const puppeteer = require('puppeteer-core');

const DECK = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const AAA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BBB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CCC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function track(id, uuid, title, extra) {
  return Object.assign({
    id: id,
    songUuid: uuid,
    title: title,
    artist: 'A',
    originalUrl: 'https://suno.com/song/' + uuid,
    status: 'queued',
    titled: true,
    durationSeconds: 2
  }, extra || {});
}

async function boot(browser, tracks, hooks) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', function (req) {
    const u = req.url();
    if (hooks && hooks.request && hooks.request(req, u)) return;
    if (u.indexOf('suno.com') !== -1 || u.indexOf('suno.ai') !== -1 || u.indexOf('workers.dev') !== -1) {
      req.abort();
      return;
    }
    req.continue();
  });
  await page.goto(DECK, { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (payload) {
    localStorage.setItem('aiu_a57_dj_deck_v2', JSON.stringify({
      activeTab: 'queued', nowPlaying: null, submissionsOpen: true, tracks: payload.tracks
    }));
    localStorage.setItem('aiu_visualizer', 'off');
    localStorage.removeItem('aiu_auto_advance');
    localStorage.removeItem('aiu_resolve_cache_v2');
    localStorage.setItem('aiu_worker_url', payload.worker);
    localStorage.removeItem('aiu_host_key');
  }, { tracks: tracks, worker: (hooks && hooks.worker) || 'http://127.0.0.1:9' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnAdvanceNext');
  return page;
}

async function snap(page) {
  return page.evaluate(function () {
    const st = window.__aiuDeck.getState();
    const src = document.getElementById('sunoEmbedFrame').getAttribute('src') || '';
    return {
      title: st.nowPlaying && st.nowPlaying.title,
      id: st.nowPlaying && st.nowPlaying.id,
      uuid: st.nowPlaying && st.nowPlaying.songUuid,
      src: src,
      status: document.getElementById('statusText').textContent,
      autoText: document.getElementById('autoText').textContent
    };
  });
}

function assert(cond, msg, detail) {
  if (cond) {
    console.log('  ok  ' + msg);
    return;
  }
  console.error('  FAIL ' + msg);
  if (detail) console.error('       ' + JSON.stringify(detail));
  process.exitCode = 1;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  console.log('1. countdown reaches 0 and loads a different song with autoplay');
  {
    const page = await boot(browser, [
      track('a', AAA, 'Alpha'),
      track('b', BBB, 'Bravo'),
      track('c', CCC, 'Charlie')
    ]);
    await page.click('#btnAdvanceNext');
    await new Promise(function (r) { setTimeout(r, 10000); });
    const s = await snap(page);
    assert(s.title === 'Bravo', 'title is Bravo', s);
    assert(s.uuid === BBB, 'uuid changed', s);
    assert(s.src.indexOf('autoplay=1') !== -1, 'next embed asks Suno to autoplay', s);
    await page.close();
  }

  console.log('2. a duplicate of the current song is not treated as the next track');
  {
    const page = await boot(browser, [
      track('id1', AAA, 'Alpha'),
      track('id2', AAA, 'Alpha again'),
      track('id3', BBB, 'Bravo'),
      track('id4', CCC, 'Charlie')
    ]);
    await page.click('#btnAdvanceNext');
    await page.evaluate(function () {
      const st = window.__aiuDeck.getState();
      const cur = st.tracks.find(function (t) { return t.id === st.nowPlaying.id; });
      if (cur) cur.status = 'queued';
    });
    await new Promise(function (r) { setTimeout(r, 10000); });
    const s = await snap(page);
    assert(s.uuid === BBB && s.title === 'Bravo', 'countdown advances to Bravo, not another Alpha', s);
    assert(s.src.indexOf(BBB) !== -1 && s.src.indexOf('autoplay=1') !== -1, 'Bravo embed autoplays', s);
    await page.close();
  }

  console.log('3. length that arrives after the song started still ends on time');
  {
    const worker = 'http://127.0.0.1:8765/mock-worker';
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: null, titled: true }),
      track('b', BBB, 'Bravo', { durationSeconds: 30 }),
      track('c', CCC, 'Charlie', { durationSeconds: 30 })
    ], {
      worker: worker,
      request: function (req, u) {
        if (u.indexOf('/mock-worker/queue') !== -1) {
          req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
          return true;
        }
        if (u.indexOf('/mock-worker/resolve') !== -1) {
          setTimeout(function () {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                songUuid: AAA,
                title: 'Alpha',
                artist: 'A',
                durationSeconds: 1
              })
            });
          }, 6000);
          return true;
        }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await new Promise(function (r) { setTimeout(r, 9500); });
    const s = await snap(page);
    assert(s.uuid === BBB && s.title === 'Bravo', 'advances once the real end has passed, without waiting a fresh full length', s);
    assert(s.src.indexOf('autoplay=1') !== -1, 'late advance still uses autoplay', s);
    await page.close();
  }
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.error('auto-next checks failed');
} else {
  console.log('auto-next checks passed');
}
