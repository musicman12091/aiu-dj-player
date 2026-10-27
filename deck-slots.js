// Now Playing / Pre-cue / Playlist.
// Pre-cue is the only song an advance is allowed to start. It is never the song
// already in the embed. The deck and tools/deck-slots.test.mjs both use this file.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiuSlots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function snapshot(track) {
    if (!track) return null;
    var uuid = track.songUuid || '';
    return {
      id: track.id,
      songUuid: uuid,
      title: track.title,
      artist: track.artist,
      originalUrl: track.originalUrl || (uuid ? 'https://suno.com/song/' + uuid : ''),
      startedAt: track.startedAt || null,
      durationSeconds: track.durationSeconds || null,
      coverUrl: track.coverUrl || null,
      submittedBy: track.submittedBy || null,
      blurb: track.blurb || null
    };
  }

  function queuedExcept(state, np) {
    var out = [];
    var tracks = state.tracks || [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t || t.status !== 'queued') continue;
      if (np && t.id === np.id) continue;
      out.push(t);
    }
    return out;
  }

  // A different song still waiting. Same-uuid copies are not "next" while one of
  // these exists — that copy is what made auto-next restart the embed.
  function differentQueued(state, np, exceptId) {
    var rows = queuedExcept(state, np);
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (exceptId && t.id === exceptId) continue;
      if (!np || t.songUuid !== np.songUuid) return t;
    }
    return null;
  }

  function rowById(state, id) {
    if (!id) return null;
    var tracks = state.tracks || [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i] && tracks[i].id === id) return tracks[i];
    }
    return null;
  }

  function isValidCue(state) {
    var cue = state.preCue;
    var np = state.nowPlaying;
    if (!cue || !cue.id) return false;
    if (np && cue.id === np.id) return false;
    var row = rowById(state, cue.id);
    if (!row || row.status !== 'queued') return false;
    if (np && cue.songUuid === np.songUuid && differentQueued(state, np, cue.id)) return false;
    return true;
  }

  // The audible row is "playing". A Pre-cue that points at it is dropped.
  function normalize(state) {
    if (!state.tracks) state.tracks = [];
    var np = state.nowPlaying;
    if (np && np.id) {
      for (var i = 0; i < state.tracks.length; i++) {
        var t = state.tracks[i];
        if (!t) continue;
        if (t.id === np.id) {
          if (t.status !== 'failed' && t.status !== 'played' && t.status !== 'incoming') t.status = 'playing';
        } else if (t.status === 'playing') {
          t.status = 'played';
        }
      }
    }
    if (isValidCue(state)) state.preCue = snapshot(rowById(state, state.preCue.id));
    else state.preCue = null;
    return state;
  }

  function fillPreCue(state) {
    normalize(state);
    if (state.preCue) return state.preCue;
    var np = state.nowPlaying;
    var row = differentQueued(state, np, null);
    if (!row) {
      var same = queuedExcept(state, np);
      row = same.length ? same[0] : null;
    }
    state.preCue = row ? snapshot(row) : null;
    return state.preCue;
  }

  function seal(state) {
    normalize(state);
    fillPreCue(state);
    return state;
  }

  function archivePrevious(state, incoming, now) {
    var prev = state.nowPlaying;
    if (!prev || (incoming && incoming.id === prev.id)) return;
    var row = rowById(state, prev.id);
    if (row) {
      if (row.status !== 'failed' && row.status !== 'played') {
        row.status = 'played';
        if (!row.startedAt) row.startedAt = prev.startedAt || now;
      }
    } else {
      var copy = snapshot(prev);
      copy.status = 'played';
      copy.titled = true;
      copy.startedAt = prev.startedAt || now;
      state.tracks.push(copy);
    }
  }

  // incoming has resolved and is allowed to become Now Playing.
  // The old Now Playing goes to Played. Pre-cue refills from Playlist.
  function commitPlayed(state, track, now) {
    if (!track) return null;
    archivePrevious(state, track, now);
    var sameRow = state.nowPlaying && state.nowPlaying.id === track.id;
    track.status = 'playing';
    if (!sameRow || !track.startedAt) track.startedAt = now || Date.now();
    state.nowPlaying = snapshot(track);
    if (state.preCue && (state.preCue.id === track.id || state.preCue.songUuid === track.songUuid)) {
      state.preCue = null;
    }
    seal(state);
    return state.nowPlaying;
  }

  // While this deck is the one making sound, a saved queue must not arm the
  // audible song as Pre-cue (that is the repeat). A Pre-cue this deck already
  // armed wins over a stale remote cue.
  function reconcileRemote(local, remote, opts) {
    var playingLocally = !!(opts && opts.playingLocally && local && local.nowPlaying);
    var state = {
      nowPlaying: remote && remote.nowPlaying ? Object.assign({}, remote.nowPlaying) : null,
      preCue: remote && remote.preCue ? Object.assign({}, remote.preCue) : null,
      tracks: remote && remote.tracks ? remote.tracks : []
    };
    if (playingLocally) {
      state.nowPlaying = Object.assign({}, local.nowPlaying);
      state.preCue = null;
      normalize(state);
      if (local.preCue) {
        state.preCue = Object.assign({}, local.preCue);
        if (!isValidCue(state)) state.preCue = null;
      }
      if (!state.preCue && remote && remote.preCue) {
        state.preCue = Object.assign({}, remote.preCue);
        if (!isValidCue(state)) state.preCue = null;
      }
    }
    return seal(state);
  }

  return {
    snapshot: snapshot,
    normalize: normalize,
    fillPreCue: fillPreCue,
    seal: seal,
    commitPlayed: commitPlayed,
    reconcileRemote: reconcileRemote
  };
});
