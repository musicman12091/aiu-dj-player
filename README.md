# AI: Underground — DJ Deck

**Live deck:** https://musicman12091.github.io/aiu-dj-player/

A single-page DJ deck for running live Suno listening parties from a phone (built and tested on a Samsung Galaxy A57 with Discord screen share).

Current version: **v3.3**

**Guest request page:** https://musicman12091.github.io/aiu-dj-player/submit.html (needs the Worker)

## Two ways it runs

| | Without a Worker (default) | With the `aiu-dj-worker` Cloudflare Worker |
|---|---|---|
| Song lookups | Free public services (Microlink, allorigins, corsproxy.io): roughly 12–25 short links a day | Your Worker, which follows `suno.com/s/…` links itself: no daily lookup cap worth worrying about |
| Playback | Suno's embedded player; tap Next when a song ends | Direct audio stream relayed by the Worker, auto-advancing the moment a song ends. Falls back to Suno's player automatically if a song's stream is refused |
| Visualizer | Synthwave scene (beat is simulated) | Live frequency bars and waveform from the actual audio |
| Queue storage | This browser only | Saved to Cloudflare KV as well, so it survives cache clears and shows on other devices |
| Guest requests | Not available | Guests send songs from `submit.html`; they land in your Pending tab with their name and note |

With no Worker set, v3.0 behaves exactly like v2.4 (same regression tests).

## Connecting the Worker

Deploy the Worker first: see [`worker/README.md`](worker/README.md). Then open this link once on the phone that runs the party, with your two values filled in:

```
https://musicman12091.github.io/aiu-dj-player/#worker=https://aiu-dj-worker.<your-subdomain>.workers.dev&key=<your host key>
```

The deck saves both on the phone and immediately wipes them from the address bar. Other devices can open the link with only `#worker=…` (no key) to watch the queue read-only.

## What it does

- **Now Playing**
  - **Live stream (Worker):** `<audio id="nativeAudioPlayer">` plays `…/stream?id=<song>`. When it ends, the next Playlist song starts with no tap. Lock screen and notification show the song (Media Session); the notification's ⏭ works too.
  - **Suno player fallback:** if the stream is refused (403/404), fails, or doesn't start within 12 seconds, the song moves to Suno's embed. The deck counts down the song's length (from the Worker) plus a 6-second start allowance, then moves on. **Hold** and **+30s** adjust the countdown. If the length is unknown, it says so and waits for Next.
  - **Auto-next On/Off** switch, remembered on the phone.
  - **Visualizer:** three psychedelic scenes, a new one each song: **Kaleidoscope**, **Colour tunnel** and **Liquid waves**. While the Worker stream plays they react to the real audio (bass, mids, highs, beat). While Suno's player is in use they follow a simulated 120 BPM beat, because audio inside Suno's player can't be read by the page. They render at reduced resolution and about 40 frames a second to spare the battery. Tap the visualizer to turn it off. With reduced motion turned on they run slowly with no beat flashes. Phones without WebGL get the older bars and synthwave scene.
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

## Guest request page (`submit.html`)

A separate page for party guests. Share it with the deck's **🔗 Copy guest link** button (Pending tab).

One screen, top to bottom:

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

- On the phone: browser local storage (queue, history, remembered lookups, Worker address, host key, Auto-next and visualizer settings). Different browsers, including an app's built-in browser, keep separate copies.
- With the Worker: one copy of the queue in your Cloudflare KV namespace `AIU_QUEUE_KV`.

## Audio and Suno's terms

Without the Worker, all audio plays through Suno's own embedded player. With the Worker, the audio file is relayed (not stored) from Suno's CDN through your Worker, so the browser can play it continuously and analyze it for the visualizer. Relaying is a different arrangement from embedding, and Suno's terms may not allow it. The Worker has a kill switch: set `STREAM_ENABLED` to `false` and every song plays through Suno's embed instead.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole deck: markup, inline compiled CSS, and script. No build step is needed to run it. |
| `submit.html` | The guest request page. Same single-file setup. |
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
