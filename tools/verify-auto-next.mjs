// Deck auto-next checks. Uses system Chrome via puppeteer-core.
// Suno requests are intercepted: these checks verify iframe URLs request autoplay,
// not that a real Suno player has started audible playback.
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
      activeTab: 'queued', nowPlaying: payload.nowPlaying || null, submissionsOpen: true, tracks: payload.tracks
    }));
    localStorage.setItem('aiu_visualizer', 'off');
    localStorage.removeItem('aiu_auto_advance');
    if (payload.cache) localStorage.setItem('aiu_resolve_cache_v2', JSON.stringify(payload.cache));
    else localStorage.removeItem('aiu_resolve_cache_v2');
    localStorage.setItem('aiu_worker_url', payload.worker);
    localStorage.removeItem('aiu_host_key');
    localStorage.removeItem('aiu_sync_meta');
  }, { tracks: tracks, worker: (hooks && hooks.worker) || 'http://127.0.0.1:9', cache: hooks && hooks.cache, nowPlaying: hooks && hooks.nowPlaying });
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
      autoText: document.getElementById('autoText').textContent,
      deadline: window.__aiuDeck.player.embedDeadline,
      lengthKnown: window.__aiuDeck.player.embedLengthKnown,
      played: st.tracks.filter(function (t) { return t.status === 'played'; }).map(function (t) { return t.id; })
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

async function waitUntil(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(function (resolve) { setTimeout(resolve, 25); });
  }
}

async function jumpClock(page, milliseconds) {
  await page.evaluate(function (amount) {
    if (!window.__autoTestRealNow) {
      window.__autoTestRealNow = Date.now.bind(Date);
      window.__autoTestClockOffset = 0;
      Date.now = function () { return window.__autoTestRealNow() + window.__autoTestClockOffset; };
    }
    window.__autoTestClockOffset += amount;
  }, milliseconds);
}

function resolvedResponse(req, duration) {
  return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, songUuid: AAA, title: 'Alpha', artist: 'A', durationSeconds: duration
  }) });
}

function emptyQueueResponse(req) {
  return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
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
    assert(mid.src.indexOf(AAA) !== -1 && mid.src.indexOf('autoplay=1') !== -1, 'Alpha embed requests autoplay', mid);
    await waitForSong(page, BBB, CCC);
    const s = await snap(page);
    assert(s.title === 'Bravo', 'title is Bravo', s);
    assert(s.uuid === BBB, 'uuid changed', s);
    assert(s.uuid !== mid.uuid, 'countdown did not repeat Alpha', s);
    assert(s.played.includes('a'), 'finished Alpha is archived in Played', s);
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
    assert(s.src.indexOf(BBB) !== -1 && s.src.indexOf('autoplay=1') !== -1, 'Bravo embed requests autoplay', s);
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
    assert(s.src.indexOf('autoplay=1') !== -1, 'late advance still requests autoplay', s);
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
    assert(s.src.indexOf(BBB) !== -1 && s.src.indexOf('autoplay=1') !== -1, 'manual swap requests autoplay for the new song', s);
    await page.click('#btnAdvanceNext');
    await waitForSong(page, CCC, '');
    s = await snap(page);
    assert(s.uuid === CCC && !s.preCueId, 'third Play Next is Charlie and Pre-cue is empty', s);
    assert(s.slotTitle === 'Nothing in Pre-cue', 'empty Pre-cue is labeled', s);
    await page.close();
  }
  console.log('5. missing metadata retries and recovers the same-song stall');
  {
    let resolveCalls = 0;
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: null, metaTried: false }),
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], {
      worker: 'http://127.0.0.1:8765/retry-worker',
      request: function (req, u) {
        if (u.includes('/retry-worker/queue')) { emptyQueueResponse(req); return true; }
        if (u.includes('/retry-worker/resolve')) {
          resolveCalls++;
          resolvedResponse(req, resolveCalls === 1 ? null : 1);
          return true;
        }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, BBB);
    await waitUntil(function () { return resolveCalls >= 1; }, 'first metadata lookup never ran');
    await page.waitForFunction(function () { return !window.__aiuDeck.getState().tracks.find(function (t) { return t.id === 'a'; }).resolving; });
    let s = await snap(page);
    assert(!s.lengthKnown && !s.deadline, 'missing metadata never invents a song duration', s);
    await jumpClock(page, 120000);
    await waitForSong(page, BBB, CCC);
    s = await snap(page);
    assert(resolveCalls >= 2, 'metadata lookup retries after an earlier missing duration', { resolveCalls });
    assert(s.played.includes('a') && s.uuid === BBB && s.preCueUuid === CCC, 'retry recovery archives Alpha, loads Bravo, and arms Charlie', s);
    assert(s.src.includes(BBB) && s.src.includes('autoplay=1'), 'recovered transition requests autoplay on the new embed', s);
    await page.close();
  }

  console.log('6. a stale title-only cache cannot permanently disable auto-next');
  {
    let resolveCalls = 0;
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: null, metaTried: true }),
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], {
      worker: 'http://127.0.0.1:8765/cache-worker',
      cache: { ['t:' + AAA]: { title: 'Alpha', author: 'A', durationSeconds: null, metaTried: true } },
      request: function (req, u) {
        if (u.includes('/cache-worker/queue')) { emptyQueueResponse(req); return true; }
        if (u.includes('/cache-worker/resolve')) { resolveCalls++; resolvedResponse(req, 1); return true; }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, BBB);
    await waitUntil(function () { return resolveCalls > 0; }, 'stale cache prevented a fresh metadata lookup');
    await page.waitForFunction(function () { return window.__aiuDeck.player.embedLengthKnown; });
    await jumpClock(page, 10000);
    await waitForSong(page, BBB, CCC);
    const s = await snap(page);
    assert(resolveCalls > 0, 'title-only cache and old metaTried flag allow a new resolver request', { resolveCalls });
    assert(s.played.includes('a') && s.uuid === BBB, 'fresh duration allows the deck to archive and advance', s);
    await page.close();
  }

  console.log('7. metadata retries are bounded and Retry length can recover');
  {
    let resolveCalls = 0;
    let allowDuration = false;
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: null }),
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], {
      worker: 'http://127.0.0.1:8765/manual-worker',
      request: function (req, u) {
        if (u.includes('/manual-worker/queue')) { emptyQueueResponse(req); return true; }
        if (u.includes('/manual-worker/resolve')) { resolveCalls++; resolvedResponse(req, allowDuration ? 1 : null); return true; }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, BBB);
    await waitUntil(function () { return resolveCalls >= 1; }, 'first metadata lookup never ran');
    for (let expected = 2; expected <= 4; expected++) {
      await page.waitForFunction(function () { return !window.__aiuDeck.getState().tracks.find(function (t) { return t.id === 'a'; }).resolving; });
      await jumpClock(page, 120000);
      await waitUntil(function () { return resolveCalls >= expected; }, 'automatic retry ' + expected + ' never ran');
    }
    await page.waitForFunction(function () { return !window.__aiuDeck.getState().tracks.find(function (t) { return t.id === 'a'; }).resolving; });
    await jumpClock(page, 3600000);
    await new Promise(function (resolve) { setTimeout(resolve, 1200); });
    assert(resolveCalls === 4, 'automatic attempts stop after four metadata requests', { resolveCalls });
    let s = await snap(page);
    assert(s.uuid === AAA && !s.deadline, 'exhausted metadata retries keep the current song and do not invent an end time', s);
    allowDuration = true;
    await page.click('#btnRetryLength');
    await waitForSong(page, BBB, CCC);
    s = await snap(page);
    assert(resolveCalls === 5, 'Retry length explicitly permits one fresh metadata request', { resolveCalls });
    assert(s.played.includes('a') && s.uuid === BBB, 'manual metadata recovery uses the normal archive-and-advance transition', s);
    await page.close();
  }

  console.log('8. synced duration uses local playback time despite a conflicting remote timestamp');
  {
    let remoteSnapshot = null;
    let resolveCalls = 0;
    let remoteReads = 0;
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: null, metaTried: true }),
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], {
      worker: 'http://127.0.0.1:8765/sync-worker',
      request: function (req, u) {
        if (u.includes('/sync-worker/queue')) {
          if (remoteSnapshot) {
            remoteReads++;
            req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, updatedAt: Date.now() + 120000, data: remoteSnapshot }) });
          } else emptyQueueResponse(req);
          return true;
        }
        if (u.includes('/sync-worker/resolve')) { resolveCalls++; resolvedResponse(req, null); return true; }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, BBB);
    await waitUntil(function () { return resolveCalls > 0; }, 'metadata lookup never ran');
    await page.waitForFunction(function () { return !window.__aiuDeck.getState().tracks.find(function (t) { return t.id === 'a'; }).resolving; });
    remoteSnapshot = await page.evaluate(function () { return JSON.parse(JSON.stringify(window.__aiuDeck.getState())); });
    const remoteRow = remoteSnapshot.tracks.find(function (t) { return t.id === 'a'; });
    remoteRow.durationSeconds = 1;
    remoteRow.startedAt = remoteSnapshot.nowPlaying.startedAt + 3600000;
    remoteSnapshot.nowPlaying.durationSeconds = 1;
    // Locally this song has ended; an incorrect timestamp from another device
    // must not add another hour before the newly available duration can advance it.
    await jumpClock(page, 10000);
    await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
    await waitUntil(function () { return remoteReads > 0; }, 'queue sync was not requested');
    await waitForSong(page, BBB, CCC);
    const s = await snap(page);
    assert(s.played.includes('a') && s.uuid === BBB && s.preCueUuid === CCC, 'synced length advances an overdue local song despite the remote row timestamp being an hour ahead', s);
    assert(s.src.includes(BBB) && s.src.includes('autoplay=1'), 'recovered local clock loads the next embed and requests playback', s);
    await page.close();
  }

  console.log('9. Resume and Reload start a new local clock instead of reusing an old deadline');
  {
    const oldStart = Date.now() - 3600000;
    const active = track('a', AAA, 'Alpha', { durationSeconds: 180, status: 'playing', startedAt: oldStart });
    const page = await boot(browser, [active,
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], { nowPlaying: active });
    await page.click('#btnMountFirstTrack');
    await waitForSong(page, AAA, BBB);
    let remaining = await page.evaluate(function () { return window.__aiuDeck.player.embedDeadline - Date.now(); });
    assert(remaining > 170000 && remaining < 190000, 'Resume gives the restarted embed a fresh full-length clock', { remaining });
    await page.evaluate(function () {
      const st = window.__aiuDeck.getState();
      st.nowPlaying.startedAt -= 3600000;
      st.tracks.find(function (t) { return t.id === 'a'; }).startedAt -= 3600000;
    });
    await page.click('#btnReloadCurrent');
    await page.click('#btnReloadCurrent');
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    const s = await snap(page);
    remaining = await page.evaluate(function () { return window.__aiuDeck.player.embedDeadline - Date.now(); });
    assert(s.uuid === AAA && remaining > 170000 && remaining < 190000, 'Reload restarts Alpha clock without skipping straight to Bravo', { snapshot: s, remaining });
    await page.close();
  }

  console.log('10. Hold and Auto-next OFF preserve time across a long callback gap');
  {
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: 180 }),
      track('b', BBB, 'Bravo', { durationSeconds: 180 }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ]);
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, BBB);
    let before = await page.evaluate(function () { return window.__aiuDeck.player.embedDeadline - Date.now(); });
    await page.click('#btnHold');
    await jumpClock(page, 120000);
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    await page.click('#btnHold');
    let after = await page.evaluate(function () { return window.__aiuDeck.player.embedDeadline - Date.now(); });
    let s = await snap(page);
    assert(s.uuid === AAA && after > before - 2500 && after < before + 1000, 'Hold preserves remaining duration after a simulated two-minute callback gap', { before, after, snapshot: s });
    before = after;
    await page.click('#btnAutoToggle');
    await jumpClock(page, 120000);
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    await page.click('#btnAutoToggle');
    after = await page.evaluate(function () { return window.__aiuDeck.player.embedDeadline - Date.now(); });
    s = await snap(page);
    assert(s.uuid === AAA && after > before - 2500 && after < before + 1000, 'Auto-next OFF also preserves remaining duration across the callback gap', { before, after, snapshot: s });
    await page.close();
  }

  console.log('11. a slow short-link resolution cannot queue a second auto-advance');
  {
    let resolveCalls = 0;
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: 1 }),
      track('b', 'short-nextclip', 'Bravo short link', { durationSeconds: null }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], {
      worker: 'http://127.0.0.1:8765/slow-next-worker',
      request: function (req, u) {
        if (u.includes('/slow-next-worker/queue')) { emptyQueueResponse(req); return true; }
        if (u.includes('/slow-next-worker/resolve')) {
          resolveCalls++;
          setTimeout(function () {
            req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
              ok: true, songUuid: BBB, title: 'Bravo', artist: 'B', durationSeconds: 180
            }) });
          }, 1500);
          return true;
        }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, 'short-nextclip');
    await jumpClock(page, 10000);
    await waitUntil(function () { return resolveCalls > 0; }, 'auto-next never started the short-link lookup');
    await waitForSong(page, BBB, CCC);
    // Let any stale transport follow-up run; it must not skip the newly loaded song.
    await new Promise(function (resolve) { setTimeout(resolve, 750); });
    const s = await snap(page);
    assert(resolveCalls === 1, 'the slow next-track lookup is not duplicated by timer ticks', { resolveCalls });
    assert(s.uuid === BBB && s.preCueUuid === CCC && !s.played.includes('b'), 'stale auto-next retries do not skip Bravo after it loads', s);
    assert(s.played.includes('a') && s.src.includes(BBB) && s.src.includes('autoplay=1'), 'the delayed transition archives Alpha and requests Bravo playback', s);
    await page.close();
  }

  console.log('12. Hold during a pending next-track lookup blocks transition until Resume');
  {
    let resolveCalls = 0;
    const page = await boot(browser, [
      track('a', AAA, 'Alpha', { durationSeconds: 1 }),
      track('b', 'short-heldnext', 'Bravo short link', { durationSeconds: null }),
      track('c', CCC, 'Charlie', { durationSeconds: 180 })
    ], {
      worker: 'http://127.0.0.1:8765/held-next-worker',
      request: function (req, u) {
        if (u.includes('/held-next-worker/queue')) { emptyQueueResponse(req); return true; }
        if (u.includes('/held-next-worker/resolve')) {
          resolveCalls++;
          setTimeout(function () {
            req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
              ok: true, songUuid: BBB, title: 'Bravo', artist: 'B', durationSeconds: 180
            }) });
          }, 1500);
          return true;
        }
        return false;
      }
    });
    await page.click('#btnAdvanceNext');
    await waitForSong(page, AAA, 'short-heldnext');
    await jumpClock(page, 10000);
    await waitUntil(function () { return resolveCalls > 0; }, 'auto-next never started the pending lookup');
    // Allow a retry tick to queue while the first transition is awaiting metadata.
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
    await page.click('#btnHold');
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    let s = await snap(page);
    assert(s.uuid === AAA && !s.played.includes('a') && s.preCueId === 'b', 'Hold prevents both the in-flight transition and its deferred retry from archiving Alpha', s);
    assert(await page.evaluate(function () { return window.__aiuDeck.player.embedHold; }), 'countdown remains held after the short-link lookup finishes');
    await page.click('#btnHold');
    await waitForSong(page, BBB, CCC);
    await new Promise(function (resolve) { setTimeout(resolve, 750); });
    s = await snap(page);
    assert(resolveCalls === 1, 'Resume reuses the successfully resolved next track without a second lookup', { resolveCalls });
    assert(s.uuid === BBB && s.played.includes('a') && !s.played.includes('b') && s.preCueUuid === CCC, 'Resume performs exactly one normal transition to Bravo', s);
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
