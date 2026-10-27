(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIUAudioReactivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const clamp = function (n, low, high) { return Math.max(low, Math.min(high, n)); };
  const smooth = function (previous, next, dt, attack, release) {
    return previous + (next - previous) * (1 - Math.exp(-dt / (next > previous ? attack : release)));
  };

  // All motion inputs are measured audio features. There is no tempo clock or
  // generated song envelope. The same extractor can analyse an authorised CORS
  // media-element source, or the tab stream used below.
  class FeatureExtractor {
    constructor(options) {
      options = options || {};
      this.sampleRate = options.sampleRate || 48000;
      this.fftSize = options.fftSize || 2048;
      this.noiseFloor = options.noiseFloor == null ? 0.003 : options.noiseFloor;
      this.previous = new Float32Array(8);
      this.raw = new Float32Array(8);
      this.lastTime = null;
      this.lastOnset = -Infinity;
      this.fluxAverage = 0;
      this.result = {
        sampleRate: this.sampleRate,
        bands: new Float32Array(8), bass: 0, mid: 0, high: 0,
        level: 0, beat: 0, rms: 0, hasSignal: false,
        freq: new Uint8Array(this.fftSize / 2),
        wave: new Uint8Array(this.fftSize).fill(128)
      };
    }

    process(freq, wave, now, options) {
      options = options || {};
      now = Number.isFinite(now) ? now : 0;
      const dt = this.lastTime == null ? 1 / 60 : clamp((now - this.lastTime) / 1000, 0, 0.25);
      this.lastTime = now;
      const out = this.result;
      if (out.freq.length !== freq.length) out.freq = new Uint8Array(freq.length);
      if (out.wave.length !== wave.length) out.wave = new Uint8Array(wave.length);

      let sum = 0;
      if (!options.silent) {
        for (let i = 0; i < wave.length; i++) {
          const value = (wave[i] - 128) / 128;
          sum += value * value;
        }
      }
      out.rms = wave.length ? Math.sqrt(sum / wave.length) : 0;
      out.hasSignal = !options.silent && out.rms >= this.noiseFloor;
      if (out.hasSignal) {
        out.freq.set(freq);
        out.wave.set(wave);
      } else {
        out.freq.fill(0);
        out.wave.fill(128);
      }

      const low = Math.log(30);
      const high = Math.log(Math.min(16000, this.sampleRate / 2));
      let flux = 0;
      for (let i = 0; i < 8; i++) {
        const startHz = Math.exp(low + (high - low) * i / 8);
        const endHz = Math.exp(low + (high - low) * (i + 1) / 8);
        const start = Math.min(freq.length - 1, Math.floor(startHz / (this.sampleRate / 2) * freq.length));
        const end = Math.min(freq.length, Math.max(start + 1, Math.ceil(endHz / (this.sampleRate / 2) * freq.length)));
        let value = 0;
        if (out.hasSignal && start >= 0) {
          for (let bin = start; bin < end; bin++) value += freq[bin] / 255;
          value /= end - start;
        }
        this.raw[i] = value;
        flux += Math.max(0, value - this.previous[i]);
        this.previous[i] = value;
        out.bands[i] = smooth(out.bands[i], value, dt, 0.025, 0.14);
        if (out.bands[i] < 0.00001) out.bands[i] = 0;
      }
      flux /= 8;
      // Positive spectral changes trigger an onset, with a refractory interval
      // to prevent one transient retriggering every animation frame.
      const onset = out.hasSignal && flux > Math.max(0.025, this.fluxAverage * 1.7) && now - this.lastOnset > 120;
      this.fluxAverage = smooth(this.fluxAverage, flux, dt, 0.75, 0.75);
      out.beat *= Math.exp(-dt / 0.12);
      if (onset) {
        out.beat = clamp(flux * 8, 0, 1);
        this.lastOnset = now;
      }
      if (out.beat < 0.00001) out.beat = 0;
      out.bass = (out.bands[0] + out.bands[1]) / 2;
      out.mid = (out.bands[2] + out.bands[3] + out.bands[4] + out.bands[5]) / 4;
      out.high = (out.bands[6] + out.bands[7]) / 2;
      out.level = smooth(out.level, out.hasSignal ? clamp(out.rms * 3, 0, 1) : 0, dt, 0.025, 0.14);
      if (out.level < 0.00001) out.level = 0;
      return out;
    }
  }

  class CaptureController {
    constructor(options) {
      options = options || {};
      this.environment = options.environment || root;
      this.onState = typeof options.onState === 'function' ? options.onState : function () {};
      this.stream = null;
      this.context = null;
      this.analyser = null;
      this.source = null;
      this.extractor = null;
      this.state = 'idle';
      this.message = 'Connect the DJ tab audio to sync visuals.';
      this.generation = 0;
      this.pending = null;
      this.cleanups = [];
    }

    supported() {
      const env = this.environment;
      return !!(env.navigator && env.navigator.mediaDevices &&
        typeof env.navigator.mediaDevices.getDisplayMedia === 'function' &&
        (env.AudioContext || env.webkitAudioContext));
    }

    get active() {
      return !!(this.stream && this.analyser && this.stream.getAudioTracks().some(function (track) { return track.readyState === 'live'; }));
    }

    setState(state, message) {
      if (this.state === state && this.message === message) return;
      this.state = state;
      this.message = message;
      this.onState({ state: state, message: message });
    }

    start() {
      if (this.active) return this.resume();
      if (this.pending) return this.pending;
      if (!this.supported()) {
        this.setState('unsupported', 'Tab audio capture is unavailable here. Use desktop Chrome for live audio sync.');
        return Promise.resolve(false);
      }

      const generation = ++this.generation;
      const env = this.environment;
      let context;
      let request;
      try {
        const AudioContextClass = env.AudioContext || env.webkitAudioContext;
        context = new AudioContextClass({ latencyHint: 'interactive' });
        this.context = context;
        // Both operations start in the button's user gesture. In particular,
        // never await resume() before opening the browser's sharing picker.
        const resuming = context.resume();
        Promise.resolve(resuming).catch(function () {});
        request = env.navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser', frameRate: { ideal: 1, max: 5 } },
          audio: { suppressLocalAudioPlayback: false, restrictOwnAudio: false },
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          systemAudio: 'exclude',
          surfaceSwitching: 'exclude'
        });
      } catch (error) {
        this.release();
        this.setState('error', this.errorMessage(error));
        return Promise.resolve(false);
      }
      this.setState('requesting', 'Choose this DJ tab and enable Share tab audio.');
      const operation = Promise.resolve(request).then((stream) => {
        if (generation !== this.generation) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          return false;
        }
        this.stream = stream;
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        if (!audioTracks.some(function (track) { return track.readyState === 'live'; })) {
          throw new Error('NO_TAB_AUDIO');
        }
        const settings = videoTracks[0] && videoTracks[0].getSettings ? videoTracks[0].getSettings() : {};
        if (settings.displaySurface && settings.displaySurface !== 'browser') throw new Error('NOT_A_TAB');

        // Audio-only MediaStream avoids involving captured video in Web Audio.
        // Video stays alive because some browsers stop the whole capture when
        // its video track is stopped. It is never displayed, recorded or sent.
        const audioStream = env.MediaStream ? new env.MediaStream(audioTracks) : stream;
        this.source = context.createMediaStreamSource(audioStream);
        this.analyser = context.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0;
        this.analyser.minDecibels = -85;
        this.analyser.maxDecibels = -15;
        this.source.connect(this.analyser);
        // Intentionally NO connection to context.destination: the original
        // Suno player remains audible. Monitoring this captured copy echoes.
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
        this.wave = new Uint8Array(this.analyser.fftSize);
        this.extractor = new FeatureExtractor({ sampleRate: context.sampleRate, fftSize: this.analyser.fftSize });
        const listen = (target, event, handler) => {
          target.addEventListener(event, handler);
          this.cleanups.push(function () { target.removeEventListener(event, handler); });
        };
        stream.getTracks().forEach((track) => {
          listen(track, 'ended', () => {
            if (generation === this.generation) this.stop('Audio sharing stopped. Reconnect to sync visuals.');
          });
          listen(track, 'mute', () => this.updateState());
          listen(track, 'unmute', () => this.updateState());
        });
        listen(context, 'statechange', () => this.updateState());
        this.updateState();
        return true;
      }).catch((error) => {
        if (generation === this.generation) {
          this.release();
          this.setState(error && error.name === 'NotAllowedError' ? 'idle' : 'error', this.errorMessage(error));
        }
        return false;
      }).finally(() => {
        if (generation === this.generation) this.pending = null;
      });
      this.pending = operation;
      return operation;
    }

    errorMessage(error) {
      if (error && error.message === 'NO_TAB_AUDIO') return 'No audio was shared. Choose this DJ tab and enable Share tab audio.';
      if (error && error.message === 'NOT_A_TAB') return 'Choose the DJ browser tab, not a window or entire screen, and enable Share tab audio.';
      if (error && error.name === 'NotAllowedError') return 'Audio sharing was cancelled or blocked. Connect again when ready.';
      if (error && error.name === 'InvalidStateError') return 'Click Sync to music in the active DJ tab to open sharing.';
      if (error && error.name === 'NotReadableError') return 'The browser could not capture tab audio. Try connecting the DJ tab again.';
      return 'Could not connect tab audio. Use desktop Chrome and choose this DJ tab with Share tab audio.';
    }

    updateState() {
      if (!this.active) return;
      if (this.context.state !== 'running') {
        this.setState('suspended', 'Audio analysis paused. Click Resume audio sync.');
      } else if (this.stream.getAudioTracks().every(function (track) { return track.muted || !track.enabled; })) {
        this.setState('muted', 'Shared tab audio is muted. Waiting for audio.');
      } else {
        this.setState('connected', 'Tab audio connected. Visuals follow the captured sound.');
      }
    }

    resume() {
      if (!this.context || !this.active) return this.start();
      const generation = this.generation;
      let request;
      try { request = this.context.resume(); } catch (error) { request = Promise.reject(error); }
      return Promise.resolve(request).then(() => {
        if (generation !== this.generation) return false;
        this.updateState();
        return this.context.state === 'running';
      }).catch(() => {
        if (generation === this.generation) this.setState('suspended', 'Audio analysis paused. Click Resume audio sync.');
        return false;
      });
    }

    sample(now) {
      if (!this.active) return null;
      this.updateState();
      const silent = this.context.state !== 'running' ||
        this.stream.getAudioTracks().every(function (track) { return track.muted || !track.enabled; });
      if (silent) {
        this.freq.fill(0);
        this.wave.fill(128);
      } else {
        this.analyser.getByteFrequencyData(this.freq);
        this.analyser.getByteTimeDomainData(this.wave);
      }
      return this.extractor.process(this.freq, this.wave, now, { silent: silent });
    }

    release() {
      this.cleanups.splice(0).forEach(function (cleanup) { cleanup(); });
      if (this.source) { try { this.source.disconnect(); } catch (error) {} }
      if (this.analyser) { try { this.analyser.disconnect(); } catch (error) {} }
      if (this.stream) this.stream.getTracks().forEach(function (track) { track.stop(); });
      if (this.context && this.context.state !== 'closed') {
        try { Promise.resolve(this.context.close()).catch(function () {}); } catch (error) {}
      }
      this.stream = null;
      this.context = null;
      this.source = null;
      this.analyser = null;
      this.extractor = null;
      this.freq = null;
      this.wave = null;
    }

    stop(message) {
      this.generation++;
      this.pending = null;
      this.release();
      this.setState('idle', message || 'Audio sync disconnected. Suno playback continues.');
    }
  }

  return { CaptureController: CaptureController, FeatureExtractor: FeatureExtractor };
});
