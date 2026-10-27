import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FeatureExtractor, CaptureController } = require('../audio-reactivity.js');

function signal(hz, amplitude = 0.25) {
  const freq = new Uint8Array(1024);
  const wave = new Uint8Array(2048);
  const bin = Math.round(hz / 48000 * 2048);
  for (let i = Math.max(0, bin - 1); i <= Math.min(freq.length - 1, bin + 1); i++) freq[i] = 220;
  for (let i = 0; i < wave.length; i++) wave[i] = Math.round(128 + 128 * amplitude * Math.sin(2 * Math.PI * hz * i / 48000));
  return { freq, wave };
}

class Track extends EventTarget {
  constructor(kind, displaySurface = 'browser') {
    super();
    this.kind = kind;
    this.readyState = 'live';
    this.enabled = true;
    this.muted = false;
    this.displaySurface = displaySurface;
    this.stops = 0;
  }
  getSettings() { return { displaySurface: this.displaySurface }; }
  stop() { this.readyState = 'ended'; this.stops++; }
}
class Stream {
  constructor(tracks = [new Track('audio'), new Track('video')]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}

function fixture(getDisplayMedia) {
  const connections = [];
  const contexts = [];
  const analyser = {
    fftSize: 2048, frequencyBinCount: 1024, disconnect() {},
    connect(node) { connections.push(node); },
    getByteFrequencyData(out) { out.fill(180); },
    getByteTimeDomainData(out) { for (let i = 0; i < out.length; i++) out[i] = i % 2 ? 145 : 111; }
  };
  class Context extends EventTarget {
    constructor() {
      super();
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.destination = { speaker: true };
      this.closed = false;
      contexts.push(this);
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return { connect: node => connections.push(node), disconnect() {} }; }
    createAnalyser() { return analyser; }
  }
  const states = [];
  const environment = { AudioContext: Context, MediaStream: Stream, navigator: { mediaDevices: { getDisplayMedia } } };
  const controller = new CaptureController({ environment, onState: state => states.push(state) });
  return { controller, states, connections, contexts, analyser };
}

test('silence stays silent indefinitely, including nonzero stale FFT data', () => {
  const extractor = new FeatureExtractor();
  const freq = new Uint8Array(1024).fill(255);
  const wave = new Uint8Array(2048).fill(128);
  for (let now = 0; now < 10000; now += 16) {
    const out = extractor.process(freq, wave, now);
    assert.equal(out.hasSignal, false);
    assert.equal(out.level, 0);
    assert.equal(out.beat, 0);
    assert.ok(out.bands.every(value => value === 0));
    assert.ok(out.freq.every(value => value === 0));
  }
});

test('frequency content distinguishes bass from treble and loudness uses waveform RMS', () => {
  const bass = signal(70, 0.4);
  const treble = signal(9000, 0.08);
  const low = new FeatureExtractor();
  const high = new FeatureExtractor();
  for (let now = 0; now < 1000; now += 16) {
    low.process(bass.freq, bass.wave, now);
    high.process(treble.freq, treble.wave, now);
  }
  assert.ok(low.result.bass > low.result.high);
  assert.ok(high.result.high > high.result.bass);
  assert.ok(low.result.level > high.result.level * 3);
  assert.equal(low.result.hasSignal, true);
});

test('an onset follows a spectral change but a held sound does not invent repeated beats', () => {
  const extractor = new FeatureExtractor();
  const tone = signal(70);
  extractor.process(new Uint8Array(1024), new Uint8Array(2048).fill(128), 0);
  const first = extractor.process(tone.freq, tone.wave, 150).beat;
  assert.ok(first > 0);
  let previous = first;
  for (let now = 166; now < 2000; now += 16) {
    const out = extractor.process(tone.freq, tone.wave, now);
    assert.ok(out.beat <= previous);
    previous = out.beat;
  }
  assert.equal(previous, 0);
});

test('pause clears raw samples immediately and audio envelopes settle without generated pulses', () => {
  const extractor = new FeatureExtractor();
  const tone = signal(70);
  for (let now = 0; now < 1000; now += 16) extractor.process(tone.freq, tone.wave, now);
  const paused = extractor.process(tone.freq, tone.wave, 1000, { silent: true });
  assert.equal(paused.hasSignal, false);
  assert.equal(paused.rms, 0);
  assert.ok(paused.freq.every(value => value === 0));
  assert.ok(paused.wave.every(value => value === 128));
  for (let now = 1016; now < 4000; now += 16) extractor.process(tone.freq, tone.wave, now, { silent: true });
  assert.equal(extractor.result.level, 0);
  assert.equal(extractor.result.beat, 0);
  assert.ok(extractor.result.bands.every(value => value === 0));
});

test('smoothing behaves consistently at different render rates', () => {
  const tone = signal(70);
  const a = new FeatureExtractor();
  const b = new FeatureExtractor();
  a.process(tone.freq, tone.wave, 0);
  b.process(tone.freq, tone.wave, 0);
  for (let t = 10; t <= 200; t += 10) a.process(tone.freq, tone.wave, t);
  for (let t = 50; t <= 200; t += 50) b.process(tone.freq, tone.wave, t);
  assert.ok(Math.abs(a.result.level - b.result.level) < 0.00001);
});

test('capture opens immediately, requests tab audio, and never connects to speakers', async () => {
  const stream = new Stream();
  let requested = false;
  let options;
  const { controller, connections, contexts, analyser } = fixture(value => {
    requested = true;
    options = value;
    return Promise.resolve(stream);
  });
  const starting = controller.start();
  assert.equal(requested, true, 'getDisplayMedia must run before returning/awaiting');
  assert.equal(controller.state, 'requesting');
  assert.equal(await starting, true);
  assert.equal(options.selfBrowserSurface, 'include');
  assert.equal(options.preferCurrentTab, true);
  assert.equal(options.systemAudio, 'exclude');
  assert.equal(options.audio.suppressLocalAudioPlayback, false);
  assert.ok(options.video);
  assert.equal(controller.active, true);
  assert.equal(controller.state, 'connected');
  assert.deepEqual(connections, [analyser]);
  assert.ok(!connections.includes(contexts[0].destination));
  assert.equal(controller.sample(0).hasSignal, true);
  controller.stop();
  assert.equal(controller.active, false);
  assert.equal(controller.sample(16), null);
  assert.ok(stream.getTracks().every(track => track.stops === 1));
  assert.equal(contexts[0].closed, true);
});

test('a capture with no audio or a non-tab surface is rejected and released', async () => {
  for (const stream of [new Stream([new Track('video')]), new Stream([new Track('audio'), new Track('video', 'monitor')])]) {
    const { controller, contexts } = fixture(() => Promise.resolve(stream));
    assert.equal(await controller.start(), false);
    assert.equal(controller.active, false);
    assert.equal(controller.state, 'error');
    assert.ok(stream.getTracks().every(track => track.stops === 1));
    assert.equal(contexts[0].closed, true);
  }
});

test('cancelled or blocked picker closes context and leaves playback untouched', async () => {
  const error = new Error('denied');
  error.name = 'NotAllowedError';
  const { controller, contexts, connections } = fixture(() => Promise.reject(error));
  assert.equal(await controller.start(), false);
  assert.equal(controller.state, 'idle');
  assert.equal(contexts[0].closed, true);
  assert.equal(connections.length, 0);
});

test('stopping while picker is pending prevents late capture from becoming active', async () => {
  let resolve;
  const stream = new Stream();
  const { controller, contexts } = fixture(() => new Promise(done => { resolve = done; }));
  const starting = controller.start();
  controller.stop();
  resolve(stream);
  assert.equal(await starting, false);
  assert.equal(controller.active, false);
  assert.equal(controller.state, 'idle');
  assert.ok(stream.getTracks().every(track => track.stops === 1));
  assert.equal(contexts[0].closed, true);
});

test('old pending capture cannot replace a newer capture', async () => {
  const resolvers = [];
  const first = new Stream();
  const second = new Stream();
  const { controller } = fixture(() => new Promise(done => resolvers.push(done)));
  const old = controller.start();
  controller.stop();
  const current = controller.start();
  resolvers[1](second);
  assert.equal(await current, true);
  resolvers[0](first);
  assert.equal(await old, false);
  assert.equal(controller.stream, second);
  assert.equal(controller.active, true);
  assert.ok(first.getTracks().every(track => track.stops === 1));
  assert.ok(second.getTracks().every(track => track.stops === 0));
  controller.stop();
});

test('muted/suspended audio produces silence; resume and ended events are handled', async () => {
  const stream = new Stream();
  const { controller, contexts } = fixture(() => Promise.resolve(stream));
  await controller.start();
  const audio = stream.getAudioTracks()[0];
  audio.muted = true;
  audio.dispatchEvent(new Event('mute'));
  assert.equal(controller.state, 'muted');
  assert.equal(controller.sample(0).hasSignal, false);
  audio.muted = false;
  audio.dispatchEvent(new Event('unmute'));
  assert.equal(controller.state, 'connected');
  contexts[0].state = 'suspended';
  contexts[0].dispatchEvent(new Event('statechange'));
  assert.equal(controller.state, 'suspended');
  assert.equal(controller.sample(16).hasSignal, false);
  assert.equal(await controller.resume(), true);
  assert.equal(controller.state, 'connected');
  assert.equal(controller.sample(32).hasSignal, true);
  stream.getVideoTracks()[0].dispatchEvent(new Event('ended'));
  assert.equal(controller.active, false);
  assert.equal(controller.state, 'idle');
  assert.ok(stream.getTracks().every(track => track.stops === 1));
});

test('unsupported platforms report limitation without opening a microphone or fake fallback', async () => {
  const controller = new CaptureController({ environment: {} });
  assert.equal(controller.supported(), false);
  assert.equal(await controller.start(), false);
  assert.equal(controller.state, 'unsupported');
  assert.equal(controller.sample(0), null);
});
