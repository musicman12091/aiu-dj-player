// aiu-dj-worker — backend for the AI: Underground DJ Deck
//
// GET  /resolve?url=<suno link | short link | song id>  → song id + metadata
// GET  /stream?id=<song id>                             → Suno MP3 relayed with CORS + byte ranges
// GET  /queue                                           → saved deck state (public read)
// POST /queue   (header X-AIU-Host-Key)                 → save deck state (≤ 500 tracks)
// GET  /playlist                                        → slim public view for the guest page
// POST /login   { name, pin }                          → check a guest name + 4-digit PIN (first use claims the name)
// POST /submit  { url, name, pin, blurb }               → guest song request into the inbox
// POST /unsubmit { name, pin, songUuid, subId }         → guest takes back their own song (until it plays)
// GET  /inbox[?since=]  (header X-AIU-Host-Key)         → waiting guest requests + take-backs (deck pulls these)
// POST /inbox/ack { ids, withdrawn } (header X-AIU-Host-Key) → remove requests/take-backs the deck has handled
// POST /account/reset { name } (header X-AIU-Host-Key)  → forget a guest's PIN so they can pick a new one
// GET  /                                                → health / config check
//
// Bindings: AIU_QUEUE_KV (KV namespace), AIU_HOST_KEY (secret), STREAM_ENABLED ("true" to relay audio; default off),
// SUBMIT_GAP_SECONDS (optional, default 15: minimum gap between requests from one address).
// TEST_SUNO_ORIGIN / TEST_CDN_ORIGINS exist only for local tests; never set them in production.

const VERSION = '3.4.1';
const UUID_SRC = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_FULL = new RegExp('^' + UUID_SRC + '$');
const SONG_PATH = new RegExp('/(?:song|embed)/(' + UUID_SRC + ')', 'i');
const QUEUE_KEY = 'queue:v1';
const MAX_TRACKS = 500;
const MAX_QUEUE_BYTES = 1000000;
const MAX_HTML_BYTES = 1500000;
const RESOLVE_CACHE_MAX = 500;
const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000;
const RESOLVE_INCOMPLETE_TTL_MS = 15 * 1000;
const UA = 'AIU-DJ-Worker/' + VERSION + ' (+https://musicman12091.github.io/aiu-dj-player/)';
// Browser-like headers. Suno serves the real audio_url to document navigations, not to bot UAs.
const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUB_PREFIX = 'sub:';
const INBOX_MARK = 'inbox:last';
const SUB_TTL_SECONDS = 3 * 24 * 60 * 60; // unclaimed requests disappear after 3 days
const MAX_INBOX = 100;
const MAX_NAME = 40;
const MAX_BLURB = 280;
const MAX_SUBMIT_BYTES = 4000;
const ACCT_PREFIX = 'acct:';
const PIN_RE = /^[0-9]{4}$/;
const PIN_MAX_FAILS = 5; // wrong PINs in a row before the name locks
const PIN_LOCK_MS = 15 * 60 * 1000; // how long a locked name stays locked
const ADDR_TRIES_MAX = 20; // wrong PINs + new names from one address per window
const ADDR_WINDOW_MS = 10 * 60 * 1000;
const WITHDRAWN_KEY = 'withdrawn:v1';
const MAX_WITHDRAWN = 200;
const WITHDRAWN_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, X-AIU-Host-Key',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-AIU-Source',
  'Access-Control-Max-Age': '86400'
};

// Per-isolate memory cache for /resolve (the Cache API is a no-op on workers.dev).
const resolveMemo = new Map();
// Per-isolate memory of recent requests by (hashed) address, for the submit cooldown.
// Kept in memory rather than KV so a request costs one KV write, not two.
const submitSeen = new Map();
// Per-isolate count of wrong PINs and new names by (hashed) address, on top of the per-name lock.
const addrTries = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      switch (url.pathname) {
        case '/':
        case '/health':
          return json({
            ok: true,
            service: 'aiu-dj-worker',
            version: VERSION,
            endpoints: ['/resolve?url=', '/stream?id=', '/queue', '/playlist', '/login', '/submit', '/unsubmit', '/inbox', '/account/reset'],
            queueBound: !!env.AIU_QUEUE_KV,
            writesProtected: !!env.AIU_HOST_KEY,
            streamEnabled: streamEnabled(env),
            maxTracks: MAX_TRACKS
          });
        case '/playlist':
          if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
          return await handlePlaylist(env);
        case '/login':
          return await handleLogin(request, env);
        case '/submit':
          return await handleSubmit(request, url, env);
        case '/unsubmit':
          return await handleUnsubmit(request, env);
        case '/account/reset':
          return await handleAccountReset(request, env);
        case '/inbox':
        case '/inbox/ack':
          return await handleInbox(request, url, env);
        case '/resolve':
          if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
          return await handleResolve(url, env);
        case '/stream':
          if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: 'method_not_allowed' }, 405);
          return await handleStream(request, url, env);
        case '/queue':
          return await handleQueue(request, env);
        default:
          return json({ ok: false, error: 'not_found' }, 404);
      }
    } catch (err) {
      return json({ ok: false, error: 'internal_error', detail: String((err && err.message) || err).slice(0, 200) }, 500);
    }
  }
};

// ---------- helpers ----------

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      CORS,
      extraHeaders || {}
    )
  });
}

function streamEnabled(env) {
  // Off unless the variable is exactly true. A missing value must not probe cdn1.suno.ai.
  return String(env.STREAM_ENABLED || 'false').toLowerCase() === 'true';
}

function origins(env) {
  return {
    suno: (env.TEST_SUNO_ORIGIN || 'https://suno.com').replace(/\/+$/, ''),
    cdn: env.TEST_CDN_ORIGINS
      ? String(env.TEST_CDN_ORIGINS).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
      : ['https://cdn1.suno.ai', 'https://cdn2.suno.ai']
  };
}

function safeCodePoint(n) {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch (err) {
    return '';
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Undo JSON-escaped slashes, HTML-escaped slashes and URL-encoding so song paths become visible.
function normalizeForIds(raw) {
  let s = String(raw || '')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&#x2[fF];|&#47;/g, '/');
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/%25/g, '%')
      .replace(/%2[fF]/g, '/')
      .replace(/%3[aA]/g, ':')
      .replace(/%3[fF]/g, '?')
      .replace(/%3[dD]/g, '=')
      .replace(/%26/g, '&');
  }
  return s;
}

function songIdFromUrlish(s) {
  const m = normalizeForIds(s).match(SONG_PATH);
  return m ? m[1].toLowerCase() : null;
}

// Classify user input. Only suno.com / suno.ai links and bare song IDs are accepted.
function classifyInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'missing_url' };
  if (s.length > 2048) return { error: 'url_too_long' };
  if (UUID_FULL.test(s)) return { kind: 'song', uuid: s.toLowerCase() };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch (err) {
    return { error: 'invalid_url' };
  }
  const host = u.hostname.toLowerCase();
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch (err) {
    // keep raw path
  }
  if (!/(^|\.)suno\.(com|ai)$/.test(host)) return { error: 'not_suno' };
  if (/\/image_|\.(jpe?g|png|webp|gif|avif)$/i.test(path)) return { error: 'image_url' };
  if (/^\/playlists?\//i.test(path)) return { error: 'playlist' };
  let m = path.match(/^\/s\/([A-Za-z0-9_-]{4,32})\/?$/);
  if (m) return { kind: 'short', code: m[1] };
  m = path.match(SONG_PATH);
  if (m) return { kind: 'song', uuid: m[1].toLowerCase() };
  m = path.match(new RegExp('^/(' + UUID_SRC + ')\\.(?:mp3|m4a|wav)$', 'i'));
  if (m) return { kind: 'song', uuid: m[1].toLowerCase() };
  return { error: 'not_a_song_link' };
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      try {
        await reader.cancel();
      } catch (err) {
        // ignore
      }
      break;
    }
  }
  return out + decoder.decode();
}

function headOf(html) {
  const i = html.search(/<\/head>/i);
  return i === -1 ? html.slice(0, 200000) : html.slice(0, i);
}

function metaContent(head, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = head.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'));
  if (a) return a[1];
  const b = head.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + p + '["\']', 'i'));
  return b ? b[1] : '';
}

// Song page's own ID: og:url / canonical first, then any /song/ path.
function songIdFromHtml(html) {
  const head = normalizeForIds(headOf(html));
  const tags = [/<meta[^>]+og:url[^>]*>/i, /<link[^>]+rel=["']canonical["'][^>]*>/i];
  for (const re of tags) {
    const tag = head.match(re);
    if (tag) {
      const m = tag[0].match(SONG_PATH);
      if (m) return m[1].toLowerCase();
    }
  }
  const any = normalizeForIds(html.slice(0, 400000)).match(SONG_PATH);
  return any ? any[1].toLowerCase() : null;
}

function cleanTitle(s) {
  const t = decodeEntities(s).replace(/\s*\|\s*Suno\s*$/i, '').trim();
  if (!t || /^suno(\s*[|\-–—:]|\s*$)/i.test(t)) return '';
  return t;
}

function findDuration(html, uuid, head) {
  const metaDur = parseFloat(metaContent(head, 'music:duration') || metaContent(head, 'video:duration') || '');
  if (metaDur > 0 && metaDur < 7200) return Math.round(metaDur * 100) / 100;
  const re = /\\?"duration\\?"\s*:\s*([0-9]+(?:\.[0-9]+)?)/;
  let from = 0;
  for (let n = 0; n < 25; n++) {
    const i = html.indexOf(uuid, from);
    if (i === -1) break;
    const win = html.slice(Math.max(0, i - 2500), i + 2500);
    const m = win.match(re);
    if (m) {
      const v = parseFloat(m[1]);
      if (v > 1 && v < 7200) return Math.round(v * 100) / 100;
    }
    from = i + uuid.length;
  }
  return null;
}

function pageHeaders() {
  return {
    'User-Agent': PAGE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://suno.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
}

// Undo JSON escaping so "audio_url":"https://..." is visible in Next.js payloads.
function loosen(html) {
  return String(html || '')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&#x2[fF];|&#47;/g, '/');
}

function forbiddenAudio(u) {
  return /\/api\/forbidden(?:\/|$|\?)/i.test(String(u || ''));
}

function audioScore(u) {
  let s = 0;
  if (/\.mp3(\?|$)/i.test(u)) s += 8;
  else if (/\.wav(\?|$)/i.test(u) || /\.aac(\?|$)/i.test(u)) s += 6;
  else if (/\.m4a(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) s += 4;
  else if (/\.(ogg|opus|webm)(\?|$)/i.test(u)) s += 3;
  if (/cdn1\.suno\.ai/i.test(u)) s += 1;
  return s;
}

// A playable https URL that belongs to this song. Rejects the "api/forbidden" placeholder.
function allowedAudioUrl(u, uuid) {
  let parsed;
  try {
    parsed = new URL(String(u || ''));
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (forbiddenAudio(parsed.href)) return false;
  const host = parsed.hostname.toLowerCase();
  const hostOk = host.endsWith('.suno.ai') || host.endsWith('.suno.com') || host.endsWith('.cloudfront.net') || host === 'suno.com' || host === 'suno.ai';
  if (!hostOk) return false;
  if (uuid && parsed.href.toLowerCase().indexOf(String(uuid).toLowerCase()) === -1) return false;
  return /\.(mp3|m4a|aac|wav|ogg|opus|webm|mp4)(\?|$)/i.test(parsed.pathname);
}

// Canonical file URL from the embed/song payload: og:audio, JSON audio_url, then media_urls.
function extractAudioUrl(html, uuid) {
  const text = loosen(html);
  const head = headOf(text);
  const found = [];
  const push = (raw) => {
    const u = decodeEntities(raw || '').trim();
    if (allowedAudioUrl(u, uuid) && found.indexOf(u) === -1) found.push(u);
  };
  push(metaContent(head, 'og:audio'));
  push(metaContent(head, 'og:audio:url'));
  push(metaContent(head, 'og:audio:secure_url'));
  let m;
  const reAudio = /"audio_url"\s*:\s*"(https:[^"]+)"/g;
  while ((m = reAudio.exec(text))) push(m[1]);
  const reMedia = /"url"\s*:\s*"(https:[^"]+)"/g;
  while ((m = reMedia.exec(text))) push(m[1]);
  found.sort((a, b) => audioScore(b) - audioScore(a));
  return found.length ? found[0] : null;
}

function audioMagic(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const b = bytes;
  const four = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (four === 'OggS' || four === 'RIFF' || four === 'fLaC') return true;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // ID3
  if (b.length >= 8 && String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp') return true;
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
  return false;
}

function parseSongPage(html, uuid) {
  const head = headOf(html);
  const ogTitle = metaContent(head, 'og:title');
  const tm = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = decodeEntities(tm ? tm[1] : '').trim();
  let title = cleanTitle(ogTitle);
  let artist = '';
  const noSuffix = pageTitle.replace(/\s*\|\s*Suno\s*$/i, '');
  if (title && noSuffix.toLowerCase().startsWith((title + ' by ').toLowerCase())) {
    artist = noSuffix.slice(title.length + 4).trim();
  } else {
    const by = noSuffix.match(/^(.*) by (.+)$/);
    if (by) {
      if (!title) title = cleanTitle(by[1]);
      artist = by[2].trim();
    }
  }
  if (!title) title = cleanTitle(pageTitle);
  const ogImage = decodeEntities(metaContent(head, 'og:image'));
  const ogAudio = decodeEntities(metaContent(head, 'og:audio') || metaContent(head, 'og:audio:url'));
  return {
    title: title || null,
    artist: artist || null,
    coverUrl: /^https:\/\//.test(ogImage) ? ogImage : null,
    audioUrl: extractAudioUrl(html, uuid),
    durationSeconds: findDuration(html, uuid, head)
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, { redirect: 'manual', headers: pageHeaders() });
  return res;
}

// Follow suno.com/s/<code> hop by hop so the song ID can be read from any redirect,
// including /auth/session-recovery?...redirect=%2Fsong%2F<id>.
async function followShortLink(code, env) {
  const { suno } = origins(env);
  let next = suno + '/s/' + code;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetchHtml(next);
    const loc = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const abs = new URL(loc, next).toString();
      const id = songIdFromUrlish(abs);
      if (id) return { uuid: id };
      next = abs;
      continue;
    }
    if (res.ok) {
      const html = await readCapped(res, MAX_HTML_BYTES);
      const id = songIdFromHtml(html);
      return { uuid: id, html: id ? html : null };
    }
    return { uuid: null, upstreamStatus: res.status };
  }
  return { uuid: null, upstreamStatus: 'too_many_redirects' };
}

async function handleResolve(url, env) {
  const input = url.searchParams.get('url') || url.searchParams.get('id') || '';
  const r = await resolveSong(input, env, url.origin);
  return json(r.body, r.status);
}

// Shared by /resolve and /submit. Returns { status, body }.
async function resolveSong(input, env, selfOrigin) {
  const c = classifyInput(input);
  if (c.error) return { status: 400, body: { ok: false, error: c.error } };

  const memoKey = c.kind + ':' + (c.uuid || c.code);
  const hit = resolveMemo.get(memoKey);
  // A title-only page is not enough to arm the deck's auto-next timer. Briefly
  // cache it to limit repeat lookups, then allow duration recovery on retry.
  const hitTtl = hit && hit.body.durationSeconds > 0 ? RESOLVE_TTL_MS : RESOLVE_INCOMPLETE_TTL_MS;
  if (hit && Date.now() - hit.at < hitTtl) return { status: 200, body: Object.assign({}, hit.body, { cached: true }) };

  let uuid = c.uuid || null;
  let html = null;
  if (c.kind === 'short') {
    const r = await followShortLink(c.code, env);
    if (!r.uuid) {
      const blocked = r.upstreamStatus === 403 || r.upstreamStatus === 429;
      return { status: blocked ? 502 : 404, body: { ok: false, error: blocked ? 'upstream_blocked' : 'not_found', upstreamStatus: r.upstreamStatus || null } };
    }
    uuid = r.uuid;
    html = r.html;
  }

  const pages = [];
  if (html) pages.push(html);
  let metaStatus = 'ok';
  const { suno } = origins(env);
  // Embed first (that's where the player payload lives), then the song page for og:audio / title.
  const fetched = await Promise.all(['/embed/' + uuid, '/song/' + uuid].map(async (path) => {
    try {
      const res = await fetchHtml(suno + path);
      if (res.ok) return await readCapped(res, MAX_HTML_BYTES);
      if (res.body) {
        try { await res.body.cancel(); } catch (err) { /* ignore */ }
      }
      return { status: res.status };
    } catch (err) {
      return { status: 'error' };
    }
  }));
  let upstreamStatus = null;
  for (const item of fetched) {
    if (typeof item === 'string') pages.push(item);
    else if (!upstreamStatus && item && item.status) upstreamStatus = item.status;
  }
  if (!pages.length) metaStatus = 'upstream_' + (upstreamStatus || 'error');

  let meta = { title: null, artist: null, coverUrl: null, audioUrl: null, durationSeconds: null };
  for (const page of pages) {
    const parsed = parseSongPage(page, uuid);
    if (!meta.title && parsed.title) meta.title = parsed.title;
    if (!meta.artist && parsed.artist) meta.artist = parsed.artist;
    if (!meta.coverUrl && parsed.coverUrl) meta.coverUrl = parsed.coverUrl;
    if (!meta.durationSeconds && parsed.durationSeconds) meta.durationSeconds = parsed.durationSeconds;
    if (parsed.audioUrl && (!meta.audioUrl || audioScore(parsed.audioUrl) > audioScore(meta.audioUrl))) meta.audioUrl = parsed.audioUrl;
  }

  const self = selfOrigin;
  const scraped = meta.audioUrl;
  const body = {
    ok: true,
    songUuid: uuid,
    title: meta.title,
    artist: meta.artist,
    originalUrl: 'https://suno.com/song/' + uuid,
    embedUrl: 'https://suno.com/embed/' + uuid,
    audioUrl: scraped || 'https://cdn1.suno.ai/' + uuid + '.mp3',
    audioUrlSource: scraped ? 'page' : 'cdn_guess',
    streamProxyUrl: streamEnabled(env) ? self + '/stream?id=' + uuid : null,
    coverUrl: meta.coverUrl,
    durationSeconds: meta.durationSeconds,
    metaStatus: metaStatus
  };
  if (metaStatus === 'ok') {
    if (resolveMemo.size >= RESOLVE_CACHE_MAX) resolveMemo.delete(resolveMemo.keys().next().value);
    resolveMemo.set(memoKey, { at: Date.now(), body: body });
  }
  return { status: 200, body: body };
}

// ---------- /stream ----------

async function openAudio(request, upstreamUrl) {
  const range = request.headers.get('Range');
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
  const upstream = await fetch(upstreamUrl, {
    method: method,
    redirect: 'follow',
    headers: Object.assign(
      {
        'User-Agent': PAGE_UA,
        Referer: 'https://suno.com/',
        Origin: 'https://suno.com',
        Accept: 'audio/*,*/*;q=0.8'
      },
      range ? { Range: range } : {}
    )
  });
  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
    if (upstream.body) {
      try { await upstream.body.cancel(); } catch (err) { /* ignore */ }
    }
    return { upstream: null, status: upstream.status };
  }
  if (method === 'HEAD' || upstream.status === 416) return { upstream: upstream, status: upstream.status };
  const type = upstream.headers.get('Content-Type') || '';
  const startAtZero = !range || /^bytes=0-/i.test(range);
  if (startAtZero && upstream.body) {
    const reader = upstream.body.getReader();
    const first = await reader.read();
    const prefix = first.value || new Uint8Array();
    const peeked = new Response(new ReadableStream({
      async start(controller) {
        if (prefix.byteLength) controller.enqueue(prefix);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }
    }), { status: upstream.status, headers: upstream.headers });
    // Clear audio starts with a known container. Encrypted Suno blobs do not — leave those
    // for the browser to request directly from the listener's own IP.
    if (!/^audio\//i.test(type) || !audioMagic(prefix)) {
      try { await peeked.body.cancel(); } catch (err) { /* ignore */ }
      return { upstream: null, status: 415 };
    }
    return { upstream: peeked, status: upstream.status };
  }
  if (!/^audio\//i.test(type)) {
    if (upstream.body) {
      try { await upstream.body.cancel(); } catch (err) { /* ignore */ }
    }
    return { upstream: null, status: 415 };
  }
  return { upstream: upstream, status: upstream.status };
}

function proxyAudio(request, opened, sourceHost) {
  const upstream = opened.upstream;
  const h = new Headers(CORS);
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const v = upstream.headers.get(name);
    if (v) h.set(name, v);
  }
  const type = upstream.headers.get('Content-Type') || '';
  h.set('Content-Type', /^audio\//i.test(type) ? type : 'audio/mpeg');
  if (!h.has('Accept-Ranges')) h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', upstream.status === 416 ? 'no-store' : 'public, max-age=86400');
  h.set('X-AIU-Source', sourceHost);
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: h });
}

async function handleStream(request, url, env) {
  if (!streamEnabled(env)) return json({ ok: false, error: 'stream_disabled' }, 404);
  const id = (url.searchParams.get('id') || '').toLowerCase();
  if (!UUID_FULL.test(id)) return json({ ok: false, error: 'invalid_id' }, 400);

  const candidates = [];
  try {
    const resolved = await resolveSong(id, env, url.origin);
    const scraped = resolved && resolved.body && resolved.body.audioUrlSource === 'page' ? resolved.body.audioUrl : '';
    if (scraped && allowedAudioUrl(scraped, id)) candidates.push(scraped);
  } catch (err) {
    // CDN guesses below still run
  }
  for (const base of origins(env).cdn) candidates.push(base + '/' + id + '.mp3');

  const tried = [];
  const seen = {};
  for (const target of candidates) {
    if (seen[target]) continue;
    seen[target] = true;
    let opened;
    try {
      opened = await openAudio(request, target);
    } catch (err) {
      tried.push('error');
      continue;
    }
    tried.push(opened.status);
    if (opened.upstream) {
      let host = 'audio';
      try { host = new URL(target).hostname; } catch (err) { /* ignore */ }
      return proxyAudio(request, opened, host);
    }
  }
  const locked = tried.some((s) => s === 401 || s === 403 || s === 415);
  return json({ ok: false, error: locked ? 'stream_locked' : 'stream_unavailable', upstreamStatus: tried }, locked ? 403 : 404);
}

// ---------- /queue ----------

async function keysMatch(given, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(String(given || ''));
  const b = enc.encode(String(expected || ''));
  if (a.byteLength !== b.byteLength || a.byteLength === 0) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    if (k.length > 40) continue;
    if (typeof v === 'string') out[k] = v.slice(0, k === 'audioUrl' ? 2000 : 600);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return typeof out.id === 'string' && typeof out.songUuid === 'string' ? out : null;
}

async function handleQueue(request, env) {
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const stored = await env.AIU_QUEUE_KV.get(QUEUE_KEY, 'json');
    return json({ ok: true, data: stored ? stored.data : null, updatedAt: stored ? stored.updatedAt : 0 });
  }

  if (request.method !== 'POST' && request.method !== 'PUT') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.AIU_HOST_KEY) return json({ ok: false, error: 'host_key_not_configured' }, 503);
  if (!(await keysMatch(request.headers.get('X-AIU-Host-Key'), env.AIU_HOST_KEY))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (Number(request.headers.get('Content-Length') || 0) > MAX_QUEUE_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  const text = await request.text();
  if (text.length > MAX_QUEUE_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) return json({ ok: false, error: 'invalid_queue' }, 400);
  if (data.tracks.length > MAX_TRACKS) return json({ ok: false, error: 'too_many_tracks', max: MAX_TRACKS }, 413);

  const nowPlaying = cleanTrack(data.nowPlaying);
  let preCue = cleanTrack(data.preCue);
  // The audible song is not a legal Pre-cue. Keeping it there made the next
  // advance reload the song that was already playing.
  if (preCue && nowPlaying && preCue.id === nowPlaying.id) preCue = null;
  const clean = {
    tracks: data.tracks.map(cleanTrack).filter(Boolean),
    nowPlaying: nowPlaying,
    preCue: preCue,
    activeTab: typeof data.activeTab === 'string' ? data.activeTab.slice(0, 20) : 'incoming',
    deckVersion: typeof data.deckVersion === 'string' ? data.deckVersion.slice(0, 20) : null,
    submissionsOpen: data.submissionsOpen !== false
  };
  const updatedAt = Date.now();
  try {
    await env.AIU_QUEUE_KV.put(QUEUE_KEY, JSON.stringify({ data: clean, updatedAt: updatedAt, version: 1 }));
  } catch (err) {
    return json({ ok: false, error: 'kv_write_failed', detail: String((err && err.message) || err).slice(0, 200) }, 503);
  }
  return json({ ok: true, updatedAt: updatedAt, tracks: clean.tracks.length });
}

// ---------- guest requests ----------

// Returns a Response when the caller isn't the host, otherwise null.
async function hostCheck(request, env) {
  if (!env.AIU_HOST_KEY) return json({ ok: false, error: 'host_key_not_configured' }, 503);
  if (!(await keysMatch(request.headers.get('X-AIU-Host-Key'), env.AIU_HOST_KEY))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  return null;
}

// Plain one-line text: no control characters or direction-override tricks, collapsed spaces,
// cut to `max` characters without splitting emoji.
function cleanText(s, max) {
  const chars = Array.from(String(s || '')).map((ch) => {
    const c = ch.codePointAt(0);
    const bad = c < 32 || c === 127 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    return bad ? ' ' : ch;
  });
  return Array.from(chars.join('').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

async function addressTag(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const data = new TextEncoder().encode('aiu:' + ip + ':' + (env.AIU_HOST_KEY || ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function submitGapMs(env) {
  const s = Number(env.SUBMIT_GAP_SECONDS);
  return (s >= 0 && s <= 3600 ? s : 15) * 1000;
}

function randomTag(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

async function readQueue(env) {
  const stored = await env.AIU_QUEUE_KV.get(QUEUE_KEY, 'json');
  return stored && stored.data ? stored : null;
}

// GET /playlist — what guests see: now playing, up next, recent, how many are waiting.
async function handlePlaylist(env) {
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);
  const stored = await readQueue(env);
  const d = stored ? stored.data : null;
  const withdrawn = await readWithdrawn(env);
  const tracks = (d && Array.isArray(d.tracks) ? d.tracks : []).filter((t) => !isWithdrawn(t, withdrawn));
  const pick = (t) => ({
    id: t.id,
    owner: typeof t.owner === 'string' ? t.owner : null,
    songUuid: t.songUuid,
    title: t.title || null,
    artist: t.artist && t.artist !== '@SunoArtist' ? t.artist : null,
    durationSeconds: typeof t.durationSeconds === 'number' ? t.durationSeconds : null,
    coverUrl: typeof t.coverUrl === 'string' ? t.coverUrl : null,
    submittedBy: t.submittedBy || null,
    blurb: t.blurb || null,
    startedAt: typeof t.startedAt === 'number' ? t.startedAt : null
  });
  let nowPlaying = null;
  if (d && d.nowPlaying) {
    const rec = tracks.find((t) => t.id === d.nowPlaying.id) || {};
    nowPlaying = pick(Object.assign({}, d.nowPlaying, { owner: rec.owner, submittedBy: rec.submittedBy, blurb: rec.blurb, coverUrl: d.nowPlaying.coverUrl || rec.coverUrl }));
  }
  const played = tracks.filter((t) => t.status === 'played').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const explicitlyPaused = !!(d && d.submissionsOpen === false);
  const sessionActive = !!nowPlaying || tracks.some((t) => t.status === 'incoming' || t.status === 'queued' || t.status === 'playing');
  const npId = nowPlaying && nowPlaying.id;
  let queued = tracks.filter((t) => t.status === 'queued' && t.id !== npId);
  const cue = d && d.preCue;
  if (cue && cue.id && cue.id !== npId) {
    const idx = queued.findIndex((t) => t.id === cue.id);
    if (idx > 0) {
      const row = queued[idx];
      queued.splice(idx, 1);
      queued.unshift(row);
    }
  }
  return json({
    ok: true,
    updatedAt: stored ? stored.updatedAt : 0,
    // New requests follow the DJ's pause switch. A live session still counts as an open inbox
    // so desktop and the guest page show Playlist / Recently Played instead of "not open yet".
    submissionsOpen: !explicitlyPaused,
    inboxOpen: sessionActive || !explicitlyPaused,
    nowPlaying: nowPlaying,
    upNext: queued.slice(0, 100).map(pick),
    recent: played.slice(0, 10).map(pick),
    pendingCount: tracks.filter((t) => t.status === 'incoming').length,
    pendingSongs: tracks.filter((t) => t.status === 'incoming').map((t) => t.songUuid),
    playedSongs: played.map((t) => t.songUuid)
  });
}

// POST /submit — a guest request, signed with the guest's name + PIN.
// One KV write per accepted request (plus a tiny "new mail" marker; a new name costs one more).
async function handleSubmit(request, url, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);
  const text = await request.text();
  if (text.length > MAX_SUBMIT_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid_json' }, 400);
  const name = cleanText(body.name, MAX_NAME);
  const blurb = cleanText(body.blurb, MAX_BLURB);
  if (!name) return json({ ok: false, error: 'missing_name' }, 400);

  const stored = await readQueue(env);
  const q = stored ? stored.data : null;
  if (q && q.submissionsOpen === false) return json({ ok: false, error: 'submissions_closed' }, 403);

  const tag = await addressTag(request, env);
  const now = Date.now();
  const gap = submitGapMs(env);
  const last = submitSeen.get(tag);
  if (last && now - last < gap) {
    return json({ ok: false, error: 'slow_down', retryAfter: Math.ceil((gap - (now - last)) / 1000) }, 429);
  }

  const acct = await checkAccount(request, env, name, body.pin);
  if (!acct.ok) return json(acct.body, acct.status);

  const r = await resolveSong(body.url, env, url.origin);
  if (!r.body.ok) return json(r.body, r.status);
  const song = r.body;

  const withdrawn = await readWithdrawn(env);
  const tracks = (q && Array.isArray(q.tracks) ? q.tracks : []).filter((t) => !isWithdrawn(t, withdrawn));
  const active = tracks.find((t) => t.songUuid === song.songUuid && (t.status === 'incoming' || t.status === 'queued' || t.status === 'playing'));
  const playingNow = q && q.nowPlaying && q.nowPlaying.songUuid === song.songUuid;
  if (active || playingNow) {
    const where = playingNow || (active && active.status === 'playing') ? 'playing' : active.status === 'queued' ? 'queued' : 'pending';
    return json({ ok: false, error: 'already_in_queue', where: where, title: song.title }, 409);
  }

  const id = SUB_PREFIX + now.toString(36).padStart(9, '0') + ':' + randomTag(6);
  const record = {
    id: id,
    songUuid: song.songUuid,
    title: song.title,
    artist: song.artist,
    durationSeconds: song.durationSeconds,
    coverUrl: song.coverUrl,
    submittedBy: acct.name,
    owner: acct.owner,
    blurb: blurb || null,
    submittedAt: now
  };
  try {
    await env.AIU_QUEUE_KV.put(id, JSON.stringify(record), { expirationTtl: SUB_TTL_SECONDS });
  } catch (err) {
    return json({ ok: false, error: 'kv_write_failed' }, 503);
  }
  submitSeen.set(tag, now);
  if (submitSeen.size > 5000) submitSeen.delete(submitSeen.keys().next().value);
  try {
    await env.AIU_QUEUE_KV.put(INBOX_MARK, String(now));
  } catch (err) {
    // The marker only speeds up the deck's check; the deck also does a full check every few minutes.
  }
  return json({ ok: true, id: id, songUuid: song.songUuid, title: song.title, artist: song.artist, durationSeconds: song.durationSeconds, name: acct.name, owner: acct.owner, newName: acct.created });
}

// GET /inbox (host) — waiting requests. With ?since=<marker> it skips the listing when nothing new
// has arrived, which keeps the deck's polling inside KV's free daily allowance.
// POST /inbox/ack (host) — { ids: [...], withdrawn: [...] } removes requests the deck has taken in
// and take-backs the deck has applied.
// Every answer also carries `withdrawn`: songs guests took back, for the deck to remove.
async function handleInbox(request, url, env) {
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);
  const denied = await hostCheck(request, env);
  if (denied) return denied;

  if (url.pathname === '/inbox/ack') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
    let body;
    try {
      body = JSON.parse(await request.text());
    } catch (err) {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }
    const ids = (body && Array.isArray(body.ids) ? body.ids : [])
      .filter((k) => typeof k === 'string' && k.indexOf(SUB_PREFIX) === 0 && k.length <= 64)
      .slice(0, MAX_INBOX);
    await Promise.all(ids.map((k) => env.AIU_QUEUE_KV.delete(k).catch(() => null)));
    const done = (body && Array.isArray(body.withdrawn) ? body.withdrawn : []).filter((k) => typeof k === 'string');
    let cleared = 0;
    if (done.length) {
      const list = await readWithdrawn(env);
      const keep = list.filter((w) => done.indexOf(w.wid) === -1);
      cleared = list.length - keep.length;
      if (cleared) await writeWithdrawn(env, keep).catch(() => null);
    }
    return json({ ok: true, deleted: ids.length, cleared: cleared });
  }

  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const marker = Number(await env.AIU_QUEUE_KV.get(INBOX_MARK)) || 0;
  const withdrawn = await readWithdrawn(env);
  if (url.searchParams.has('since') && marker <= (Number(url.searchParams.get('since')) || 0)) {
    return json({ ok: true, items: [], withdrawn: withdrawn, marker: marker, skipped: true });
  }
  const list = await env.AIU_QUEUE_KV.list({ prefix: SUB_PREFIX, limit: MAX_INBOX });
  const values = await Promise.all(list.keys.map((k) => env.AIU_QUEUE_KV.get(k.name, 'json').catch(() => null)));
  const items = values.filter((v) => v && typeof v.id === 'string').sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
  return json({ ok: true, items: items, withdrawn: withdrawn, marker: marker, more: !list.list_complete });
}

// ---------- guest names + PINs ----------
//
// A guest's name is theirs once they've used it with a 4-digit PIN. The PIN is stored only as a
// salted SHA-256 hash, so nobody (the host included) can read it back. Five wrong PINs in a row lock
// the name for 15 minutes, which makes trying every PIN take weeks instead of minutes. The host can
// forget a name's PIN from the deck so the guest can pick a new one.

// The account key for a display name: "@Derek", "derek" and " Derek " are the same person.
function ownerKey(name) {
  return cleanText(name, MAX_NAME).replace(/^@+/, '').trim().toLowerCase();
}

async function pinHash(salt, pin) {
  const data = new TextEncoder().encode('aiu-pin:v1:' + salt + ':' + pin);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function addrBlocked(tag, now) {
  const rec = addrTries.get(tag);
  if (!rec || now - rec.start >= ADDR_WINDOW_MS) return 0;
  return rec.count >= ADDR_TRIES_MAX ? Math.ceil((ADDR_WINDOW_MS - (now - rec.start)) / 1000) : 0;
}

function addrBump(tag, now) {
  const rec = addrTries.get(tag);
  if (!rec || now - rec.start >= ADDR_WINDOW_MS) addrTries.set(tag, { start: now, count: 1 });
  else rec.count += 1;
  if (addrTries.size > 5000) addrTries.delete(addrTries.keys().next().value);
}

// Checks a name + PIN, claiming the name if nobody has it yet.
// → { ok: true, owner, name, created } or { ok: false, status, body }
async function checkAccount(request, env, rawName, rawPin) {
  const no = (status, body) => ({ ok: false, status: status, body: Object.assign({ ok: false }, body) });
  const name = cleanText(rawName, MAX_NAME);
  const owner = ownerKey(name);
  if (!owner) return no(400, { error: 'missing_name' });
  const pin = String(rawPin === undefined || rawPin === null ? '' : rawPin).trim();
  if (!pin) return no(400, { error: 'missing_pin' });
  if (!PIN_RE.test(pin)) return no(400, { error: 'bad_pin' });

  const now = Date.now();
  const tag = await addressTag(request, env);
  const wait = addrBlocked(tag, now);
  if (wait) return no(429, { error: 'too_many_tries', retryAfter: wait });

  const key = ACCT_PREFIX + owner;
  const acct = await env.AIU_QUEUE_KV.get(key, 'json');
  if (!acct || typeof acct.hash !== 'string') {
    const salt = randomTag(16);
    const record = { name: name, salt: salt, hash: await pinHash(salt, pin), fails: 0, lockedUntil: 0, createdAt: now };
    try {
      await env.AIU_QUEUE_KV.put(key, JSON.stringify(record));
    } catch (err) {
      return no(503, { error: 'kv_write_failed' });
    }
    addrBump(tag, now);
    return { ok: true, owner: owner, name: name, created: true };
  }

  if (acct.lockedUntil && acct.lockedUntil > now) {
    return no(429, { error: 'locked', retryAfter: Math.ceil((acct.lockedUntil - now) / 1000) });
  }
  const good = await keysMatch(await pinHash(acct.salt, pin), acct.hash);
  if (!good) {
    addrBump(tag, now);
    const fails = (acct.fails || 0) + 1;
    const locked = fails >= PIN_MAX_FAILS;
    acct.fails = locked ? 0 : fails;
    acct.lockedUntil = locked ? now + PIN_LOCK_MS : 0;
    await env.AIU_QUEUE_KV.put(key, JSON.stringify(acct)).catch(() => null);
    return locked
      ? no(429, { error: 'locked', retryAfter: Math.ceil(PIN_LOCK_MS / 1000) })
      : no(401, { error: 'wrong_pin', triesLeft: PIN_MAX_FAILS - fails });
  }
  if (acct.fails || acct.lockedUntil) {
    acct.fails = 0;
    acct.lockedUntil = 0;
    await env.AIU_QUEUE_KV.put(key, JSON.stringify(acct)).catch(() => null);
  }
  return { ok: true, owner: owner, name: acct.name || name, created: false };
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > MAX_SUBMIT_BYTES) return { error: json({ ok: false, error: 'too_large' }, 413) };
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object') return { body: body };
  } catch (err) {
    // fall through
  }
  return { error: json({ ok: false, error: 'invalid_json' }, 400) };
}

// POST /login — { name, pin }. Lets the guest page confirm a name + PIN before they submit.
async function handleLogin(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);
  const r = await readJsonBody(request);
  if (r.error) return r.error;
  const acct = await checkAccount(request, env, r.body.name, r.body.pin);
  if (!acct.ok) return json(acct.body, acct.status);
  return json({ ok: true, name: acct.name, owner: acct.owner, newName: acct.created });
}

// POST /account/reset (host) — { name }. Forgets that name's PIN; the next PIN used claims it again.
async function handleAccountReset(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);
  const denied = await hostCheck(request, env);
  if (denied) return denied;
  const r = await readJsonBody(request);
  if (r.error) return r.error;
  const owner = ownerKey(r.body.name);
  if (!owner) return json({ ok: false, error: 'missing_name' }, 400);
  const existed = !!(await env.AIU_QUEUE_KV.get(ACCT_PREFIX + owner));
  if (existed) await env.AIU_QUEUE_KV.delete(ACCT_PREFIX + owner);
  return json({ ok: true, owner: owner, existed: existed });
}

// ---------- take-backs ----------
//
// The deck owns the queue and saves the whole thing, so the Worker can't just delete a song from it:
// the deck's next save would put it back. Instead a take-back goes on a short list that the deck reads
// with its inbox check. The deck removes the song and clears the entry; until then /playlist hides it.

async function readWithdrawn(env) {
  let list = null;
  try {
    list = await env.AIU_QUEUE_KV.get(WITHDRAWN_KEY, 'json');
  } catch (err) {
    list = null;
  }
  const cutoff = Date.now() - WITHDRAWN_TTL_MS;
  return (Array.isArray(list) ? list : []).filter((w) => w && typeof w.wid === 'string' && typeof w.owner === 'string' && (w.at || 0) > cutoff);
}

async function writeWithdrawn(env, list) {
  await env.AIU_QUEUE_KV.put(WITHDRAWN_KEY, JSON.stringify(list.slice(-MAX_WITHDRAWN)));
}

// A take-back only ever applies to a song by the same owner.
function isWithdrawn(t, withdrawn) {
  if (!t || typeof t.owner !== 'string') return false;
  return withdrawn.some((w) => w.owner === t.owner && ((w.trackId && w.trackId === t.id) || (w.subId && w.subId === t.subId)));
}

// POST /unsubmit — { name, pin, songUuid, subId }. Takes back the guest's own song while it's waiting
// for approval or in the playlist. Once it has started playing it stays.
async function handleUnsubmit(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.AIU_QUEUE_KV) return json({ ok: false, error: 'kv_not_bound' }, 503);
  const r = await readJsonBody(request);
  if (r.error) return r.error;
  const body = r.body;
  const acct = await checkAccount(request, env, body.name, body.pin);
  if (!acct.ok) return json(acct.body, acct.status);
  const owner = acct.owner;

  const songUuid = typeof body.songUuid === 'string' && UUID_FULL.test(body.songUuid) ? body.songUuid.toLowerCase() : '';
  const subId = typeof body.subId === 'string' && body.subId.indexOf(SUB_PREFIX) === 0 && body.subId.length <= 64 ? body.subId : '';
  if (!songUuid && !subId) return json({ ok: false, error: 'missing_song' }, 400);

  const entry = { wid: randomTag(12), owner: owner, at: Date.now() };
  let title = null;
  let found = false;

  // 1. Still in the inbox: the deck hasn't taken it in yet.
  if (subId) {
    const sub = await env.AIU_QUEUE_KV.get(subId, 'json');
    if (sub) {
      if (sub.owner !== owner) return json({ ok: false, error: 'not_yours' }, 403);
      await env.AIU_QUEUE_KV.delete(subId);
      entry.subId = subId;
      entry.songUuid = sub.songUuid;
      title = sub.title || null;
      found = true;
    }
  }

  // 2. On the deck: waiting for approval or in the playlist.
  const stored = await readQueue(env);
  const q = stored ? stored.data : null;
  const tracks = q && Array.isArray(q.tracks) ? q.tracks : [];
  const matches = tracks.filter((t) => (subId && t.subId === subId) || (songUuid && t.songUuid === songUuid && (!subId || !t.subId || t.subId === subId)));
  const mine = matches.filter((t) => t.owner === owner);
  const live = mine.find((t) => t.status === 'incoming' || t.status === 'queued');
  if (live) {
    entry.trackId = live.id;
    entry.subId = entry.subId || live.subId;
    entry.songUuid = live.songUuid;
    title = title || live.title || null;
    found = true;
  } else if (!found) {
    const npMine = q && q.nowPlaying && mine.some((t) => t.id === q.nowPlaying.id);
    if (npMine || mine.some((t) => t.status === 'playing')) return json({ ok: false, error: 'already_playing' }, 409);
    if (mine.some((t) => t.status === 'played')) return json({ ok: false, error: 'already_played' }, 409);
    if (matches.length) return json({ ok: false, error: 'not_yours' }, 403);
    // Not in the inbox or the saved queue: the deck may be taking it in right now. Leave a take-back
    // for that request anyway; the deck only applies it to a song by this same owner.
    if (!subId) return json({ ok: false, error: 'not_found' }, 404);
    entry.subId = subId;
    entry.songUuid = songUuid || null;
  }

  const list = await readWithdrawn(env);
  list.push(entry);
  try {
    await writeWithdrawn(env, list);
  } catch (err) {
    return json({ ok: false, error: 'kv_write_failed' }, 503);
  }
  try {
    await env.AIU_QUEUE_KV.put(INBOX_MARK, String(entry.at));
  } catch (err) {
    // The deck still picks it up on its 5-minute full check.
  }
  return json({ ok: true, title: title, songUuid: entry.songUuid || songUuid || null });
}
