# aiu-dj-worker

The Cloudflare Worker behind DJ Deck v3.0. One file (`src/index.js`), no dependencies, free plan.

| Endpoint | What it does |
|---|---|
| `GET /resolve?url=<suno link>` | Follows `suno.com/s/…` redirects, refuses playlist and cover-image links, and returns `{ ok, songUuid, title, artist, originalUrl, embedUrl, audioUrl, streamProxyUrl, coverUrl, durationSeconds }`. Titles are decoded (`&#xE9;` → é). Only Suno addresses are accepted, so it can't be used as an open proxy. |
| `GET /stream?id=<song id>` | Relays `cdn1.suno.ai/<id>.mp3` (cdn2 as backup) with `Access-Control-Allow-Origin: *` and byte ranges (206), so the deck's `<audio crossorigin="anonymous">` and visualizer work. Returns 403 `stream_locked` or 404 `stream_unavailable` when Suno refuses, and the deck switches to Suno's embed. |
| `GET /queue` | The saved queue (anyone can read). |
| `POST /queue` | Saves the queue (up to 500 songs, 1 MB). Needs header `X-AIU-Host-Key`. |
| `GET /health` | Status check. |

## Settings

| Name | Type | Value |
|---|---|---|
| `AIU_QUEUE_KV` | KV namespace binding | namespace `AIU_QUEUE_KV` (id `d1e4316a4a454f0da817d7cc5efc64a4`) |
| `AIU_HOST_KEY` | **Secret** | A long random string you make up. The deck needs the same value to save the queue. Never commit it. |
| `STREAM_ENABLED` | Variable (optional) | `true` (default) or `false` to turn off audio relaying |

## Deploy option A: Cloudflare dashboard (no tools needed)

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker** → name it `aiu-dj-worker` → **Deploy**.
2. **Edit code** → delete everything → paste all of `src/index.js` → **Deploy**.
3. Worker → **Settings** → **Bindings** → **Add** → **KV namespace** → variable name `AIU_QUEUE_KV`, namespace `AIU_QUEUE_KV` → **Deploy**.
4. **Settings** → **Variables and Secrets** → **Add** → type **Secret**, name `AIU_HOST_KEY`, value = your host key → **Deploy**.
5. Copy the Worker's `https://aiu-dj-worker.<subdomain>.workers.dev` address from its overview page. Opening `<that address>/health` should show `"queueBound":true,"writesProtected":true`.

## Deploy option B: wrangler

```
cd worker
npx wrangler deploy
npx wrangler secret put AIU_HOST_KEY
```

## Free-plan limits that matter

- **KV: 1,000 saves a day**, resetting at 00:00 UTC (6 pm Regina). The deck batches edits, so a party uses a small share. Reads are 100,000 a day.
- **Requests: 100,000 a day.** Each song uses a lookup plus a few audio requests, so this isn't the limit for a party.
- Lookups are remembered in the Worker's memory for up to 6 hours, which spares Suno repeat requests.

## Testing locally

`TEST_SUNO_ORIGIN` and `TEST_CDN_ORIGINS` point the Worker at a local mock of Suno for automated tests. Never set them in production.
