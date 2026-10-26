# aiu-dj-worker

The Cloudflare Worker behind DJ Deck v3.4 (worker 3.3.0). One file (`src/index.js`), no dependencies, free plan. Live address: `https://aiu-dj-worker.musicman12091.workers.dev`.

| Endpoint | What it does |
|---|---|
| `GET /resolve?url=<suno link>` | Follows `suno.com/s/…` redirects, refuses playlist and cover-image links, and returns `{ ok, songUuid, title, artist, originalUrl, embedUrl, audioUrl, audioUrlSource, streamProxyUrl, coverUrl, durationSeconds }`. `audioUrl` is scraped from `suno.com/embed/<id>` (JSON `audio_url` / `media_urls`, or `og:audio`). Titles are decoded (`&#xE9;` → é). Only Suno addresses are accepted, so it can't be used as an open proxy. |
| `GET /stream?id=<song id>` | Relays a clear audio file (the scraped URL when it is a real container, then `cdn1` / `cdn2`) with `Access-Control-Allow-Origin: *` and byte ranges. Encrypted blobs and 403s are refused so the deck can try the file directly from the listener's browser, then Suno's embed. |
| `GET /queue` | The saved queue (anyone can read). |
| `POST /queue` | Saves the queue (up to 500 songs, 1 MB). Needs header `X-AIU-Host-Key`. |
| `GET /playlist` | Slim public view for the guest page: now playing, up next, recently played, how many are waiting, open/paused. `inboxOpen` stays true while a session queue is active so Playlist and Recently Played still show when new requests are paused. Notes on songs still waiting for approval aren't included. |
| `POST /submit` | Guest request `{ url, name, pin, blurb }`. Needs a valid name + PIN (a new name is claimed). Looks the song up, refuses duplicates and anything while paused, allows one request per address every 15 seconds, and stores it for the deck (kept up to 3 days). |
| `GET /inbox` | Waiting guest requests, plus `withdrawn` (songs guests took back). Needs `X-AIU-Host-Key`. `?since=<marker>` answers instantly when nothing new has arrived. |
| `POST /login` | `{ name, pin }` checks a guest's name + 4-digit PIN. The first PIN used with a name claims it. PINs are stored as salted SHA-256 hashes. 5 wrong in a row lock the name for 15 minutes (`locked`, `retryAfter`); otherwise `wrong_pin` with `triesLeft`. |
| `POST /unsubmit` | `{ name, pin, songUuid, subId }` takes back the guest's own song while it's waiting or in the playlist. Refuses `not_yours`, `already_playing`, `already_played`. The deck removes it at its next inbox check; `/playlist` hides it straight away. |
| `POST /inbox/ack` | `{ ids, withdrawn }` removes requests the deck has taken in and take-backs it has applied. Needs `X-AIU-Host-Key`. |
| `POST /account/reset` | `{ name }` forgets a guest's PIN so their next one claims the name again. Needs `X-AIU-Host-Key`. |
| `GET /health` | Status check. |

## Settings

| Name | Type | Value |
|---|---|---|
| `AIU_QUEUE_KV` | KV namespace binding | namespace `AIU_QUEUE_KV` (id `d1e4316a4a454f0da817d7cc5efc64a4`) |
| `AIU_HOST_KEY` | **Secret** | A long random string you make up. The deck needs the same value to save the queue. Never commit it. |
| `STREAM_ENABLED` | Variable (optional) | `true` (default) or `false` to turn off audio relaying |
| `SUBMIT_GAP_SECONDS` | Variable (optional) | Seconds between guest requests from one address. Default `15`. |

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

- **KV: 1,000 saves a day**, resetting at 00:00 UTC (6 pm Regina). The deck batches edits, and each guest request costs one or two, so a party with a few dozen requests uses roughly a quarter to a third. Deletes and listings have their own 1,000-a-day allowances. The deck only lists the inbox when something new arrived, plus once every 5 minutes. Reads are 100,000 a day.
- **Requests: 100,000 a day.** Each song uses a lookup plus a few audio requests, so this isn't the limit for a party.
- Lookups are remembered in the Worker's memory for up to 6 hours, which spares Suno repeat requests.

## Testing locally

`TEST_SUNO_ORIGIN` and `TEST_CDN_ORIGINS` point the Worker at a local mock of Suno for automated tests. Never set them in production.
