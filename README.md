# AI: Underground — DJ Deck

**Live deck:** https://musicman12091.github.io/aiu-dj-player/

A single-page DJ deck for running live Suno listening parties from a phone (built and tested on a Samsung Galaxy A57 with Discord screen share). Songs play through Suno's official embedded player. The deck never copies or hosts audio.

Current version: **v2.4**

## What it does

- **Now Playing:** one persistent Suno player. Editing the queue never reloads it.
- **Fetch and Submit:** paste Suno song links, `suno.com/s/…` short links (with or without `https://`), bare song IDs, or a whole Discord message. Playlist links, cover-image links and duplicates are refused with a message.
- **Tabs:**
  - **Pending:** new links waiting for approval (⚡ Play Next / + Add Queue / ✕).
  - **Playlist:** the running order (↑ ↓ / ▶ Play Now / ✕).
  - **Played:** a history of every song that played this session, with start times. **📋 Copy list** copies it for artist shoutouts.
  - **Failed:** links that couldn't be looked up or played (↻ Retry / Open ↗ / ✕).
- **Safety:**
  - ✕ and Clear show a 5-second **Undo** bar.
  - ↻ Reload and ⚠ Failed need a second tap within 3 seconds.
  - All buttons are at least 44 px tall, and pinch-to-zoom works.
- **Next Track:** looks up a short link *before* switching. If the link is dead, the current song keeps playing and Next skips to the next playable song.

## How short links are looked up

`suno.com/s/…` links have to be turned into a real song ID before Suno's player can load them. The browser can't do this directly, so the deck asks free public services in order: Microlink, then allorigins, then corsproxy.io.

- **Microlink's free plan allows 25 lookups a day.** corsproxy.io's free plan does not cover live websites, and allorigins is unreliable. Expect short links and song titles to stop resolving after roughly 12–25 songs a day.
- **Full `suno.com/song/…` links always play.** They only use a lookup for the title.
- Lookups needed to start a song run in their own lane, so they never wait behind background retries.
- Results are remembered on the device. They're stored under `aiu_resolve_cache_v2`; v2.4 discards older stored results.

The planned v3 replaces these services with a small Cloudflare Worker.

## Where data lives

Everything (queue, history, remembered lookups) is saved in the browser's local storage on the device that's running the deck. Different browsers, including an app's built-in browser, keep separate queues. Clearing the browser's site data clears the deck.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole deck: markup, inline compiled CSS, and script. No build step is needed to run it. |
| `tools/build-css.mjs` | Optional. Regenerates the inline Tailwind CSS (v3.4.17) after you add or change classes: `node tools/build-css.mjs` |

## Version history

| Version | Ticket | Change |
|---|---|---|
| v1.0 | AIU-GH-001 | Spike: persistent Suno embed + A/B/C rehearsal queue |
| v1.1 | AIU-GH-002 | Short-link resolver |
| v2.0 | AIU-GH-003 | Decluttered mobile deck: Pending / Playlist / Failed |
| v2.1–v2.3 | AIU-GH-003a | Resolve before play, keep full-link IDs, redirect decoding, no cover-image IDs |
| v2.4 | Audit Option C | Inline CSS, Played history, undo and tap-twice safety, 44 px targets, pinch zoom, priority lookup lane, stricter link parsing, duplicate check, cleaned lookup storage |
