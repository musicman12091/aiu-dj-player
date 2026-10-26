// aiu-dj-worker — backend for the AI: Underground DJ Deck
//
// GET  /resolve?url=<suno link | short link | song id>  → song id + metadata
// GET  /stream?id=<song id>                             → Suno MP3 relayed with CORS + byte ranges
// GET  /queue                                           → saved deck state (public read)
// POST /queue   (header X-AIU-Host-Key)                 → save deck state (≤ 500 tracks)
// GET  /                                                → health / config check
//
// Bindings: AIU_QUEUE_KV (KV namespace), AIU_HOST_KEY (secret), STREAM_ENABLED ("true"/"false").
// TEST_SUNO_ORIGIN / TEST_CDN_ORIGINS exist only for local tests; never set them in production.

const VERSION = '3.0.0';
const UUID_SRC = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_FULL = new RegExp('^' + UUID_SRC + '$');
const SONG_PATH = new RegExp('/(?:song|embed)/(' + UUID_SRC + ')', 'i');
const QUEUE_KEY = 'queue:v1';
const MAX_TRACKS = 500;
const MAX_QUEUE_BYTES = 1000000;
const MAX_HTML_BYTES = 1500000;
const RESOLVE_CACHE_MAX = 500;
const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000;
const UA = 'AIU-DJ-Worker/' + VERSION + ' (+https://musicman12091.github.io/aiu-dj-player/)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, X-AIU-Host-Key',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-AIU-Source',
  'Access-Control-Max-Age': '86400'
};

// Per-isolate memory cache for /resolve (the Cache API is a no-op on workers.dev).
const resolveMemo = new Map();

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
            endpoints: ['/resolve?url=', '/stream?id=', '/queue'],
            queueBound: !!env.AIU_QUEUE_KV,
            writesProtected: !!env.AIU_HOST_KEY,
            streamEnabled: streamEnabled(env),
            maxTracks: MAX_TRACKS
          });
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
  return String(env.STREAM_ENABLED || 'true').toLowerCase() !== 'false';
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
    audioUrl: new RegExp(uuid + '\\.mp3', 'i').test(ogAudio) ? ogAudio : null,
    durationSeconds: findDuration(html, uuid, head)
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' } });
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
  const c = classifyInput(input);
  if (c.error) return json({ ok: false, error: c.error }, 400);

  const memoKey = c.kind + ':' + (c.uuid || c.code);
  const hit = resolveMemo.get(memoKey);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return json(Object.assign({}, hit.body, { cached: true }));

  let uuid = c.uuid || null;
  let html = null;
  if (c.kind === 'short') {
    const r = await followShortLink(c.code, env);
    if (!r.uuid) {
      return json({ ok: false, error: r.upstreamStatus === 403 || r.upstreamStatus === 429 ? 'upstream_blocked' : 'not_found', upstreamStatus: r.upstreamStatus || null }, r.upstreamStatus === 403 || r.upstreamStatus === 429 ? 502 : 404);
    }
    uuid = r.uuid;
    html = r.html;
  }

  let meta = { title: null, artist: null, coverUrl: null, audioUrl: null, durationSeconds: null };
  let metaStatus = 'ok';
  if (!html) {
    try {
      const res = await fetchHtml(origins(env).suno + '/song/' + uuid);
      if (res.ok) html = await readCapped(res, MAX_HTML_BYTES);
      else metaStatus = 'upstream_' + res.status;
    } catch (err) {
      metaStatus = 'upstream_error';
    }
  }
  if (html) meta = parseSongPage(html, uuid);

  const self = url.origin;
  const body = {
    ok: true,
    songUuid: uuid,
    title: meta.title,
    artist: meta.artist,
    originalUrl: 'https://suno.com/song/' + uuid,
    embedUrl: 'https://suno.com/embed/' + uuid,
    audioUrl: meta.audioUrl || 'https://cdn1.suno.ai/' + uuid + '.mp3',
    streamProxyUrl: streamEnabled(env) ? self + '/stream?id=' + uuid : null,
    coverUrl: meta.coverUrl,
    durationSeconds: meta.durationSeconds,
    metaStatus: metaStatus
  };
  if (metaStatus === 'ok') {
    if (resolveMemo.size >= RESOLVE_CACHE_MAX) resolveMemo.delete(resolveMemo.keys().next().value);
    resolveMemo.set(memoKey, { at: Date.now(), body: body });
  }
  return json(body);
}

// ---------- /stream ----------

async function handleStream(request, url, env) {
  if (!streamEnabled(env)) return json({ ok: false, error: 'stream_disabled' }, 404);
  const id = (url.searchParams.get('id') || '').toLowerCase();
  if (!UUID_FULL.test(id)) return json({ ok: false, error: 'invalid_id' }, 400);

  const range = request.headers.get('Range');
  const tried = [];
  for (const base of origins(env).cdn) {
    const upstream = await fetch(base + '/' + id + '.mp3', {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: Object.assign({ 'User-Agent': UA }, range ? { Range: range } : {})
    });
    tried.push(upstream.status);
    if (upstream.status === 200 || upstream.status === 206 || upstream.status === 416) {
      const h = new Headers(CORS);
      for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
        const v = upstream.headers.get(name);
        if (v) h.set(name, v);
      }
      const type = upstream.headers.get('Content-Type') || '';
      h.set('Content-Type', /^audio\//i.test(type) ? type : 'audio/mpeg');
      if (!h.has('Accept-Ranges')) h.set('Accept-Ranges', 'bytes');
      h.set('Cache-Control', upstream.status === 416 ? 'no-store' : 'public, max-age=86400');
      h.set('X-AIU-Source', new URL(base).hostname);
      return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: h });
    }
    if (upstream.body) {
      try {
        await upstream.body.cancel();
      } catch (err) {
        // ignore
      }
    }
  }
  const locked = tried.some((s) => s === 401 || s === 403);
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
    if (typeof v === 'string') out[k] = v.slice(0, 600);
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

  const clean = {
    tracks: data.tracks.map(cleanTrack).filter(Boolean),
    nowPlaying: cleanTrack(data.nowPlaying),
    activeTab: typeof data.activeTab === 'string' ? data.activeTab.slice(0, 20) : 'incoming',
    deckVersion: typeof data.deckVersion === 'string' ? data.deckVersion.slice(0, 20) : null
  };
  const updatedAt = Date.now();
  try {
    await env.AIU_QUEUE_KV.put(QUEUE_KEY, JSON.stringify({ data: clean, updatedAt: updatedAt, version: 1 }));
  } catch (err) {
    return json({ ok: false, error: 'kv_write_failed', detail: String((err && err.message) || err).slice(0, 200) }, 503);
  }
  return json({ ok: true, updatedAt: updatedAt, tracks: clean.tracks.length });
}
