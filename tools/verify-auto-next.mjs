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
    const pre = document.getElementById('sunoPreCueFrame');
    return {
      title: st.nowPlaying && st.nowPlaying.title,
      id: st.nowPlaying && st.nowPlaying.id,
      uuid: st.nowPlaying && st.nowPlaying.songUuid,
      src: src,
      preCueTitle: st.preCue && st.preCue.title,
      preCueId: st.preCue && st.preCue.id,
      preCueUuid: st.preCue && st.preCue.songUuid,
      preSrc: pre ? (pre.getAttribute('src') || '') : '',
      slotTitle: document.getElementById('preCueTitle').textContent,
      status: document.getElementById('statusText').textContent,
      autoText: document.getElementById('autoText').textContent
    };
  });
}

function waitForSong(page, uuid, precueUuid) {
  return page.waitForFunction(function (song, cue) {
    const st = window.__aiuDeck.getState();
    if (!st.nowPlaying || st.nowPlaying.songUuid !== song) return false;
    if (cue && (!st.preCue || st.preCue.songUuid !== cue)) return false;
    if (!cue && st.preCue) return false;
    return true;
  }, { timeout: 12000 }, uuid, precueUuid || '');
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
    await waitForSong(page, AAA, BBB);
    const mid = await snap(page);
    assert(mid.slotTitle === 'Bravo', 'Pre-cue slot shows the upcoming song while Alpha plays', mid);
    assert(mid.preCueUuid === BBB && mid.preCueId !== mid.id, 'Pre-cue is a different row from Now Playing', mid);
    assert(mid.preSrc.indexOf(BBB) !== -1, 'hidden iframe preloads Bravo', mid);
    assert(mid.preSrc.indexOf('autoplay') === -1, 'preload does not autoplay', mid);
    assert(mid.src.indexOf(AAA) !== -1 && mid.src.indexOf('autoplay=1') !== -1, 'Alpha embed autoplays', mid);
    await waitForSong(page, BBB, CCC);
    const s = await snap(page);
    assert(s.title === 'Bravo', 'title is Bravo', s);
    assert(s.uuid === BBB, 'uuid changed', s);
    assert(s.uuid !== mid.uuid, 'countdown did not repeat Alpha', s);
    assert(s.preCueUuid === CCC, 'Playlist refilled Pre-cue with Charlie', s);
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
    await waitForSong(page, AAA, BBB);
    await page.evaluate(function () {
      const st = window.__aiuDeck.getState();
      const cur = st.tracks.find(function (t) { return t.id === st.nowPlaying.id; });
      if (cur) cur.status = 'queued';
      st.preCue = {
        id: st.nowPlaying.id,
        songUuid: st.nowPlaying.songUuid,
        title: st.nowPlaying.title
      };
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

  console.log('4. manual Play Next uses Pre-cue and does not repeat');
  {
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: 180 }),
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ]);
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, BBB);
    let s = await snap(page);
    assert(s.slotTitle === 'Bravo', 'slot shows Bravo before the manual swap', s);
    await page.click('#btnAdvanceNext');
    await waitForSong(page, BBB, CCC);
    s = await snap(page);
    assert(s.uuid === BBB && s.preCueUuid === CCC, 'manual Play Next swapped Pre-cue to Now Playing and refilled', s);
    assert(s.src.indexOf(BBB) !== -1 && s.src.indexOf('autoplay=1') !== -1, 'manual swap autoplays the new song', s);
    await page.click('#btnAdvanceNext');
    await waitForSong(page, CCC, '');
    s = await snap(page);
    assert(s.uuid === CCC && !s.preCueId, 'third Play Next is Charlie and Pre-cue is empty', s);
    assert(s.slotTitle === 'Nothing in Pre-cue', 'empty Pre-cue is labeled', s);
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
