// Slot machine for Now Playing / Pre-cue / Playlist.
// Run: node --test tools/deck-slots.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const slots = require('../deck-slots.js');

const AAA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BBB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CCC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DDD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function row(id, uuid, title, status) {
  return {
    id: id,
    songUuid: uuid,
    title: title,
    artist: 'A',
    originalUrl: 'https://suno.com/song/' + uuid,
    status: status || 'queued',
    titled: true,
    durationSeconds: 30
  };
}

test('seal parks the next playlist song in Pre-cue, not the song that is playing', () => {
  const state = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha' },
    // The bug: Pre-cue was never a slot, so the "next" row is the song already playing.
    preCue: { id: 'a', songUuid: AAA, title: 'Alpha' },
    tracks: [
      row('a', AAA, 'Alpha', 'queued'),
      row('b', BBB, 'Bravo', 'queued'),
      row('c', CCC, 'Charlie', 'queued')
    ]
  };
  slots.seal(state);
  assert.equal(state.tracks.find((t) => t.id === 'a').status, 'playing');
  assert.equal(state.preCue.id, 'b');
  assert.equal(state.preCue.songUuid, BBB);
  assert.notEqual(state.preCue.songUuid, state.nowPlaying.songUuid);
});

test('each advance plays the Pre-cue song and refills Pre-cue from Playlist', () => {
  const state = {
    nowPlaying: null,
    preCue: null,
    tracks: [
      row('a', AAA, 'Alpha'),
      row('b', BBB, 'Bravo'),
      row('c', CCC, 'Charlie')
    ]
  };
  const heard = [];
  for (let i = 0; i < 3; i++) {
    slots.seal(state);
    const cue = state.preCue;
    assert.ok(cue, 'a song is armed in Pre-cue before the advance');
    if (state.nowPlaying) {
      assert.notEqual(cue.id, state.nowPlaying.id);
      assert.notEqual(cue.songUuid, state.nowPlaying.songUuid);
    }
    const track = state.tracks.find((t) => t.id === cue.id);
    slots.commitPlayed(state, track, 1_000 + i);
    heard.push(state.nowPlaying.songUuid);
  }
  assert.deepEqual(heard, [AAA, BBB, CCC]);
  assert.equal(state.tracks.find((t) => t.id === 'a').status, 'played');
  assert.equal(state.tracks.find((t) => t.id === 'b').status, 'played');
  assert.equal(state.tracks.find((t) => t.id === 'c').status, 'playing');
  assert.equal(state.preCue, null);
});

test('a same-uuid copy is not Pre-cue while a different song is still queued', () => {
  const state = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha', startedAt: 5 },
    preCue: null,
    tracks: [
      row('a', AAA, 'Alpha', 'playing'),
      row('a2', AAA, 'Alpha again'),
      row('b', BBB, 'Bravo'),
      row('c', CCC, 'Charlie')
    ]
  };
  slots.seal(state);
  assert.equal(state.preCue.id, 'b');
  slots.commitPlayed(state, state.tracks.find((t) => t.id === 'b'), 50);
  assert.equal(state.nowPlaying.songUuid, BBB);
  assert.notEqual(state.preCue.songUuid, BBB);
});

test('an intentional repeat can be Pre-cue only when nothing else is left', () => {
  const state = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha' },
    preCue: null,
    tracks: [
      row('a', AAA, 'Alpha', 'playing'),
      row('a2', AAA, 'Alpha again')
    ]
  };
  slots.seal(state);
  assert.equal(state.preCue.id, 'a2');
  assert.equal(state.preCue.songUuid, AAA);
});

test('Play Next arms that song as Pre-cue without dropping the previous one from Playlist', () => {
  const state = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha' },
    preCue: null,
    tracks: [
      row('a', AAA, 'Alpha', 'playing'),
      row('b', BBB, 'Bravo'),
      row('c', CCC, 'Charlie')
    ]
  };
  slots.seal(state);
  assert.equal(state.preCue.id, 'b');
  const charlie = state.tracks.find((t) => t.id === 'c');
  charlie.status = 'queued';
  state.preCue = slots.snapshot(charlie);
  slots.seal(state);
  assert.equal(state.preCue.id, 'c');
  assert.equal(state.tracks.find((t) => t.id === 'b').status, 'queued');
  slots.commitPlayed(state, charlie, 80);
  assert.equal(state.nowPlaying.id, 'c');
  assert.equal(state.preCue.id, 'b');
});

test('remote sync cannot put the song playing on this deck back into Pre-cue', () => {
  const local = {
    nowPlaying: { id: 'b', songUuid: BBB, title: 'Bravo', startedAt: 20 },
    preCue: { id: 'c', songUuid: CCC, title: 'Charlie' },
    tracks: [
      row('a', AAA, 'Alpha', 'played'),
      row('b', BBB, 'Bravo', 'playing'),
      row('c', CCC, 'Charlie'),
      row('d', DDD, 'Delta')
    ]
  };
  const remote = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha' },
    preCue: { id: 'b', songUuid: BBB, title: 'Bravo' },
    tracks: [
      row('a', AAA, 'Alpha', 'playing'),
      row('b', BBB, 'Bravo', 'queued'),
      row('c', CCC, 'Charlie', 'queued'),
      row('d', DDD, 'Delta', 'queued')
    ]
  };
  const out = slots.reconcileRemote(local, remote, { playingLocally: true });
  assert.equal(out.nowPlaying.id, 'b');
  assert.equal(out.nowPlaying.songUuid, BBB);
  assert.ok(out.preCue);
  assert.notEqual(out.preCue.id, 'b');
  assert.notEqual(out.preCue.songUuid, BBB);
  assert.equal(out.preCue.id, 'c');
  assert.equal(out.tracks.find((t) => t.id === 'b').status, 'playing');
});

test('sync with no local Pre-cue still refuses the playing song and arms the next different one', () => {
  const local = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha' },
    preCue: null,
    tracks: [row('a', AAA, 'Alpha', 'playing'), row('b', BBB, 'Bravo')]
  };
  const remote = {
    nowPlaying: { id: 'a', songUuid: AAA, title: 'Alpha' },
    preCue: { id: 'a', songUuid: AAA, title: 'Alpha' },
    tracks: [row('a', AAA, 'Alpha', 'queued'), row('b', BBB, 'Bravo', 'queued')]
  };
  const out = slots.reconcileRemote(local, remote, { playingLocally: true });
  assert.equal(out.preCue.id, 'b');
  assert.equal(out.tracks.find((t) => t.id === 'a').status, 'playing');
});
