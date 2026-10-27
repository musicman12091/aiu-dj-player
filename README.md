# AI: Underground — DJ Deck

**Live deck:** https://musicman12091.github.io/aiu-dj-player/

A single-page DJ deck for running live Suno listening parties from a phone or a desktop window (built for a Samsung Galaxy A57 and a Chrome window shared in Discord).

Current version: **v4.0**

**Guest request page:** https://musicman12091.github.io/aiu-dj-player/submit.html (needs the Worker)

## Two ways it runs

| | Without a Worker (default) | With the `aiu-dj-worker` Cloudflare Worker |
|---|---|---|
| Song lookups | Free public services (Microlink, allorigins, corsproxy.io): roughly 12–25 short links a day | Your Worker, which follows `suno.com/s/…` links itself: no daily lookup cap worth worrying about |
| Playback | Suno's embedded player. Auto-next waits for a tap when the length is unknown | Suno's embedded player, loaded straight into the iframe. Auto-next counts down `durationSeconds` from `/resolve`. Direct `/stream` and `cdn1.suno.ai` probes stay off (`STREAM_ENABLED` is false). The deck does not warn that a direct file could not play |
| Install | Add to Home Screen / install as an app. `manifest.json` opens the deck; the shortcut opens guest requests | Same manifest and service worker. The worker API and Suno embeds are not cached |
| Queue storage | This browser only | Saved to Cloudflare KV as well, so it survives cache clears and shows on other devices |
| Guest requests | Not available | Guests send songs from `submit.html`; they land in your Pending tab with their name and note |

The WebGL/canvas visualizer is gone. Queue, Pre-cue, and auto-next behavior are unchanged by that removal.

## Connecting the Worker

Deploy the Worker first: see [`worker/README.md`](worker/README.md). Then open this link once on the phone that runs the party, with your two values filled in:

```
https://musicman12091.github.io/aiu-dj-player/#worker=https://aiu-dj-worker.musicman12091.workers.dev&key=<your host key>
```

The deck and the guest page already use that Worker address when `#worker=` is missing. The deck saves a `#key=` on the phone and immediately wipes it from the address bar. Other devices can open the plain GitHub Pages URL to follow the queue read-only.

## What it does

- **Now Playing**
  - **Suno player:** `#sunoEmbedFrame` loads `suno.com/embed/<id>` as soon as the song starts. That is normal playback. `cdn1.suno.ai/<id>.mp3` is locked (CloudFront 403 MissingKey) and the page file is a scrambled `.m4a` that only Suno's player can decode, so the deck does not try `/stream` or the CDN unless `STREAM_ENABLED` is turned on in both the deck and the Worker.
  - **Pre-cue (Next):** the slot in front of the song that is playing. The next Playlist song is moved here and pre-loaded in a hidden Suno embed (no autoplay, so it stays silent). The deck shows that title the whole time something is playing.
  - **Auto-next countdown:** the deck owns switching: archive Now Playing to Played, promote Pre-cue, refill Pre-cue, navigate the Suno iframe, and request autoplay. Its clock estimates the end from `durationSeconds` plus a 6-second load allowance; it cannot read Suno's internal `ended`, pause, or seek events. Missing length now triggers up to four bounded lookup attempts and an explicit **Retry length** control, instead of a permanent stopped clock. Length arriving through queue sync also arms the current clock against this device's start time. Hold and Auto-next OFF preserve remaining time across delayed callbacks. Resume/reload starts a fresh clock. A slow short-link lookup cannot queue a second stale advance or override Hold.
  - **Embed autoplay:** after a host gesture, the deck navigates each new embed with `?autoplay=1` and delegates the autoplay permission. This requests playback; it cannot confirm that Suno started sound or bypass a browser refusal. If the browser blocks playback, use the Suno play control. Tests distinguish requesting autoplay from verified audible playback.
  - **Playback status:** an expandable panel reports this device's clock/queue blocker and lets the host copy a diagnostic snapshot without the host key. The queue is shared across devices, but Play Next controls the device where it is pressed; it is not a remote PC transport command.
  - **Auto-next On/Off** switch, remembered on the phone.
  - After a reload, a **▶ Resume** button brings back the last song. Nothing starts playing by itself.
- **Fetch and Submit:** paste Suno song links, `suno.com/s/…` short links (with or without `https://`), bare song IDs, or a whole Discord message. Playlist links, cover-image links and duplicates are refused with a message. Song length shows on each card when known.
- **Tabs**
  - **Pending:** new links waiting for approval (⚡ Play Next / + Add Queue / ✕).
  - **Playlist:** the running order (↑ ↓ / ▶ Play Now / ✕).
  - **Played:** every song that played, with start times. **📋 Copy list** copies it for artist shoutouts.
  - **Failed:** links that couldn't be looked up or played (↻ Retry / Open ↗ / ✕).
- **Safety**
  - ✕ and Clear show a 5-second **Undo** bar.
  - ↻ Reload and ⚠ Failed need a second tap within 3 seconds.
  - All buttons are at least 44 px, and pinch-to-zoom works.
  - Next looks a short link up *before* switching. If it's dead, the current song keeps playing.

## Install the deck

`index.html` and `submit.html` are one installable app (`display: standalone`).

- Both pages link `manifest.json`, set `theme-color` to `#090b10`, and set the Apple web-app metas (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`).
- `sw.js` precaches the app shell (both HTML pages, `deck-slots.js`, the manifest, and the PNG icons) and falls back to that cache when this origin is offline. It does not intercept `aiu-dj-worker.musicman12091.workers.dev` or Suno. Cloudflare Pages serves `manifest.json` and `sw.js` from the repo root (`_headers` sets the manifest type and keeps the service worker uncached).
- Icons are PNG files in `icons/` (192 and 512, plus a maskable 512 and the Submit shortcut). Chrome does not treat the data-URI SVG from the ticket as an installable icon, so the manifest points at these files. The artwork matches that SVG: green **AIU** on `#10b981`, and a sky **+** for guest requests.

**Playback timing:** auto-next still uses a deck-owned estimate. Use Hold when pausing inside Suno; the parent page cannot read that internal pause event.

## Guest request page (`submit.html`)

A separate page for party guests. Share it with the deck's **🔗 Copy guest link** button (Pending tab).

One screen, top to bottom on a phone. On a wide window the request form sits beside the playlist.

- **Name + 4-digit PIN.** The first person to use a name claims it with their PIN. The phone remembers both, so guests only enter them once. **Switch** signs out. Guests can also just fill them in and submit; that signs them in.
- **Fetch and Submit** (big button), then a large link field, then an optional note about the song (up to 280 characters). The Worker looks the song up straight away, so guests see the real title and it reaches you with title, artist and length. They can paste a whole Discord message; the first song link is used.
- **Your requests:** a live status for each (sent → waiting for approval → in the playlist #n → playing now → played) and an **Unsubmit** button until it starts playing. Unsubmit needs a second tap within 3 seconds.
- **Playlist:** Now playing (with who requested it and their note), then every approved song with album art, title, artist, length and who requested it, in its own scrolling box. The counter at the top right shows how many approved songs there are and their total running time ("6 songs · 23 min"; a + means some lengths are unknown). Guests can't reorder anything. Their own songs show **Unsubmit**.
- **Recently played** underneath. Everything refreshes every 30 seconds.
- **PIN safety:** PINs are stored scrambled (salted hash), so nobody can read them back. Five wrong PINs in a row lock that name for 15 minutes, and one phone gets 20 wrong PINs or new names per 10 minutes.
- **Forgotten PIN:** tap **🔑 Reset PIN** on the deck's Pending tab and type their name. Their next PIN claims the name again.
- **Refused with a plain message:** playlist links, cover-image links, non-Suno links, a song already playing / queued / waiting, a second request from the same person within 15 seconds, and anything while requests are paused.
- **On the deck:** songs a guest unsubmits disappear from Pending or Playlist at the next inbox check (within about 20 seconds), with a status line saying who took back what. Requests appear in **Pending** marked REQUEST, with "🙋 requested by …" and the note. The Pending tab lights up and the status line names the requester. Nothing plays until you approve it. Who requested a song stays with it into Now Playing, Played and the shoutout copy list.
- **Guest requests: OPEN / PAUSED** (Pending tab) closes the inbox within seconds. Only a device with the host key can change it.
- Unapproved requests the deck never picked up are deleted by Cloudflare after 3 days.

## Queue sync (Worker)

- The deck saves to KV 6 seconds after the last change, so a burst of edits is one save, and never holds changes back more than 20 seconds. It also saves when you switch away from the browser.
- Cloudflare's free plan allows **1,000 saves a day**, resetting at 6 pm Regina time. The header chip shows how many the deck has used. Each guest request also uses one or two. A four-hour party with a few dozen requests typically uses a quarter to a third of the allowance.
- If saves are refused (limit reached, offline), the queue stays safe on the phone and the deck retries later.
- Every 30 seconds, and whenever you come back to the tab, the deck checks for a newer saved queue from another device. The song playing on this phone is never interrupted by that.
- Up to 500 songs are saved. If there are more, the oldest Played entries are left out first. Nothing waiting to play is ever dropped.
- Saving needs the host key. Without it a device is read-only.
- The first time a phone that already has a queue connects, its songs are merged into the saved queue, not replaced.

## Where data lives

- On the phone: browser local storage (queue, history, remembered lookups, Worker address, host key, and Auto-next). Different browsers, including an app's built-in browser, keep separate copies. An installed PWA keeps that same storage for its origin.
- With the Worker: one copy of the queue in your Cloudflare KV namespace `AIU_QUEUE_KV`.

## Audio and Suno's terms

Songs play in Suno's own embedded player. The deck does not download, store, or re-upload audio files. `/resolve` is used for the title, art, and length. Relaying a file through the Worker is off: `STREAM_ENABLED` defaults to `false` in `worker/wrangler.toml` and in the deck. Set both to `true` only if a clear file stream works again. Suno's terms may still not allow relaying.

## Files

| File | Purpose |
|---|---|
| `index.html` | The deck: markup, inline compiled CSS, and script. No build step is needed to run it. |
| `audio-reactivity.js` | Unused by the deck after the visualizer was removed. Kept so `tools/audio-reactivity.test.mjs` still runs. |
| `deck-slots.js` | Now Playing / Pre-cue / Playlist rules, shared with `tools/deck-slots.test.mjs`. |
| `submit.html` | The guest request page. Same single-file setup. |
| `manifest.json` | Installable PWA manifest for the deck and the guest page. |
| `sw.js` | App-shell service worker. Does not cache the Worker API or Suno. |
| `icons/` | PNG icons used by the manifest and Apple touch icon. |
| `tools/build-css.mjs` | Optional. Regenerates the inline Tailwind CSS (v3.4.17) in both pages after you add or change classes: `node tools/build-css.mjs` |
| `worker/src/index.js` | The Cloudflare Worker (`/resolve`, `/stream`, `/queue`, `/playlist`, `/submit`, `/inbox`). One file, no dependencies. |
| `worker/wrangler.toml` | Worker settings for `wrangler deploy` (KV binding included; the host key is a secret and is never committed). |

## Version history

| Version | Ticket | Change |
|---|---|---|
| v1.0 | AIU-GH-001 | Spike: persistent Suno embed + A/B/C rehearsal queue |
| v1.1 | AIU-GH-002 | Short-link resolver |
| v2.0 | AIU-GH-003 | Decluttered mobile deck: Pending / Playlist / Failed |
| v2.1–v2.3 | AIU-GH-003a | Resolve before play, keep full-link IDs, redirect decoding, no cover-image IDs |
| v2.4 | Audit Option C | Inline CSS, Played history, undo and tap-twice safety, 44 px targets, pinch zoom, priority lookup lane, stricter link parsing, duplicate check, cleaned lookup storage |
| v3.0 | Worker + auto-play | Cloudflare Worker lookups, direct streaming with hands-free auto-advance, Suno-embed fallback with length-based countdown, live Web Audio visualizer, KV queue sync with host key, Resume after reload, Media Session |
| v3.1 | Guest requests | `submit.html` guest page (Submit / Playlist tabs), Worker inbox with cooldown, duplicate and open/closed checks, requests in Pending with requester + note, requester credited in Now Playing / Played / copy list, open/paused switch, copy guest link, 20-second cap on save delay |
| v3.4 | THADEUS-001/002/003 | Resolve returns the audio URL scraped from the Suno embed (or og:audio). If `/stream` fails, the deck plays that URL — or `cdn1.suno.ai/<id>.mp3` — in `#nativeAudioPlayer` without `crossorigin`, then Suno's embed. Deck and guest page default to `https://aiu-dj-worker.musicman12091.workers.dev`. Guest playlist and recently played stay visible while requests are paused; a live session keeps the inbox open. Five-scene 60fps visualizer with a scene pill and a beat engine when the analyser is silent. |
| v3.5 | THADEUS-004 | Suno's embed is the player. The deck skips `/stream` and `cdn1.suno.ai` (`STREAM_ENABLED` defaults to false on the deck and the Worker) and no longer shows "Direct stream unavailable". Auto-next still counts down `durationSeconds` from `/resolve`, and the five-scene visualizer still runs on every song. |
| v3.6 | THADEUS-005 | Auto-next archives the song that just finished (even if its row was still queued) and loads the next distinct Playlist song. After one click on the deck, later embeds use Suno's `?autoplay=1`. The deck and the guest page use a two-column layout on a wide window; phones stay a single column. |
| v3.7 | THADEUS-006 | The embed countdown advances by itself. The end time stays tied to when the song started, a repeat of the current song is not treated as next while another song is queued, and the clock keeps trying (animation frame, a short worker tick, and when the tab wakes) instead of clearing itself before the next song has loaded. |
| v3.8 | THADEUS-007 | Three slots: Now Playing, Pre-cue, Playlist. Auto-next and Play Next swap the pre-cued song in and refill Pre-cue from Playlist. A hidden Suno embed pre-loads the next song without autoplay. Queue sync cannot store the audible song as Pre-cue. |

| v3.9 | THADEUS playback + visualizer repair | Real tab-audio visualizer; resilient estimated auto-next clock, bounded metadata recovery, sync recovery, pause/restart handling, transition guards, and per-device playback diagnostics. Removes procedural beat fallbacks. |
| v4.0 | THADEUS-009 | Removes the WebGL/canvas visualizer. Suno embed stays the player (`STREAM_ENABLED` false, no direct-stream warning). Host deck and guest page install as a standalone PWA. Pre-cue, auto-next, and Play Next stay. |

## Repair verification

`node --test tools/audio-reactivity.test.mjs tools/deck-slots.test.mjs tools/deck-shell.test.mjs tools/worker-resolve-cache.test.mjs` covers the unused audio-feature module, queue slots, the visualizer-free PWA shell, and duration-cache recovery. `tools/verify-visualizer.mjs` runs the shell checks. `tools/verify-auto-next.mjs` still uses puppeteer-core and a locally installed Chromium/Chrome (set `PUPPETEER_RESOLVE_FROM` and `CHROME` as needed). Serve the deck locally for the auto-next test. Browser tests use mocked Suno navigation, never production queue writes. They do not confirm real Suno playback.

Worker 3.4.1 retries cached title-only metadata after 15 seconds; complete duration metadata retains the six-hour cache. This allows subsequent deck length retries to recover instead of repeatedly receiving an incomplete cached result.
