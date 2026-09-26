/*
 * Audio manager.
 * Event sounds are overlapping one-shots keyed by frame.
 * Sound 1 is two cues: the looping gameplay bed (sprite 2, no overlap)
 * and the post-curtain sting (sprite 320, 2 loops, ~7.4s envelope).
 * The bed stays silent until play; the sting is a separate element.
 * Sound 315 is shipped as WAV because browsers cannot decode the
 * original packet directly.
 */
(() => {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const EFFECT_IDS = [3, 4, 6, 87, 94, 95, 96, 164, 299, 300, 308, 315, 373, 374, 375, 377, 381, 401, 417];
  // MP3 encoder delay, in seconds (samples / native rate). Skipping it keeps
  // accents from landing ~75ms late.
  const SEEK_SEC = {
    3: 1669 / 22050, 4: 1669 / 22050, 6: 1669 / 22050,
    94: 1633 / 22050, 95: 1669 / 22050, 96: 1669 / 22050,
    299: 1669 / 22050, 300: 1669 / 22050, 308: 1633 / 22050
  };

  function urlFor(id) {
    if (window.TURBO_AUDIO && window.TURBO_AUDIO[id]) return window.TURBO_AUDIO[id];
    if (id === 315) return 'assets/audio/315.wav';
    return `assets/audio/${id}.mp3`;
  }

  class GameAudio {
    constructor() {
      this.muted = false;
      this.unlocked = false;
      this.fade = 0;
      this.musicVolume = 0.55;
      this.effects = new Set();
      this.audioContext = null;
      this.buffers = new Map();
      this.musicStarted = false;
      this.sting = null;
      this.stingGain = null;
      this.stingBuffer = null;
      this.stingLoading = false;
      this.stingPending = false;
      this.stingStarted = 0;

      this.music = new Audio(urlFor(1));
      this.music.loop = true;
      this.music.preload = 'auto';
      this.music.volume = 0;
      this.bed = null;
      this.bedGain = null;
      this.bedBuffer = null;
      this.bedPending = false;

      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.audioContext = new AC();
      } catch (_) {}

      this.loadStingBuffer();

      if (this.audioContext) {
        for (const id of EFFECT_IDS) {
          fetch(urlFor(id))
            .then(r => r.arrayBuffer())
            .then(buf => this.audioContext.decodeAudioData(buf))
            .then(decoded => this.buffers.set(id, this.skipSeek(id, decoded)))
            .catch(() => {});
        }
      }
    }

    unlock() {
      if (this.unlocked) {
        this.ensureMusic();
        if (this.stingPending) this.playIntroSting();
        return;
      }
      this.unlocked = true;
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }
      this.ensureMusic();
      if (this.stingPending) this.playIntroSting();
    }

    ensureMusic() {
      if (!this.unlocked || this.musicStarted) return;
      this.musicStarted = true;
      if (!this.audioContext) {
        this.startFallbackMusic();
        return;
      }
      if (this.bedBuffer) this.startBed();
      else {
        this.bedPending = true;
        this.loadStingBuffer();
      }
    }

    startFallbackMusic() {
      this.bedPending = false;
      this.musicStarted = true;
      try {
        Promise.resolve(this.music.play()).catch(() => { this.musicStarted = false; });
      } catch (_) {
        this.musicStarted = false;
      }
    }

    startBed() {
      if (this.bed || !this.bedBuffer || !this.audioContext) return;
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
      const src = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      src.buffer = this.bedBuffer;
      src.loop = true;
      src.connect(gain).connect(this.audioContext.destination);
      gain.gain.value = 0;
      this.bed = src;
      this.bedGain = gain;
      try { src.start(); this.bedPending = false; }
      catch (_) {
        this.bed = null;
        this.bedGain = null;
        this.startFallbackMusic();
      }
    }

    // Sprite 320 frame 30: sound 1, loop count 2, one envelope across both
    // plays (fade-out at 44.1 kHz sample 0x4f882, ~7.39s). Restarting the
    // element on `ended` inserts a gap, and the file itself has silence at
    // both ends. Trim that and play both copies as one buffer.
    loadStingBuffer() {
      if (this.stingBuffer || this.stingLoading || !this.audioContext) return;
      this.stingLoading = true;
      fetch(urlFor(1))
        .then(r => r.arrayBuffer())
        .then(buf => this.audioContext.decodeAudioData(buf.slice(0)))
        .then(decoded => {
          const sting = this.seamlessLoops(decoded, 2);
          // One trimmed copy, looped by the audio clock. Not the doubled sting.
          const bed = this.seamlessLoop(decoded);
          this.stingBuffer = sting;
          this.bedBuffer = bed;
          this.stingLoading = false;
          if (this.stingPending) this.playIntroSting();
          if (this.bedPending) this.startBed();
        })
        .catch(() => {
          this.stingLoading = false;
          // A failed fetch/decode must not leave ensureMusic() stuck in its
          // musicStarted + bedPending state. Use the media element, which can
          // still play even if fetching for Web Audio was blocked.
          if (this.bedPending) this.startFallbackMusic();
        });
    }

    seamlessLoops(buffer, loops) {
      const ctx = this.audioContext;
      const channels = buffer.numberOfChannels;
      const rate = buffer.sampleRate;
      const src = [];
      for (let c = 0; c < channels; c++) src.push(buffer.getChannelData(c));
      const n = buffer.length;
      const thresh = 0.008;
      const loud = i => {
        for (let c = 0; c < channels; c++) if (Math.abs(src[c][i]) > thresh) return true;
        return false;
      };
      let start = 0;
      while (start < n && !loud(start)) start++;
      let end = n - 1;
      while (end > start && !loud(end)) end--;
      if (end - start < rate * 0.2) { start = 0; end = n - 1; }
      const pad = Math.floor(rate * 0.004);
      start = Math.max(0, start - pad);
      end = Math.min(n - 1, end + pad);
      const len = end - start + 1;
      const fade = Math.min(Math.floor(rate * 0.01), Math.floor(len / 8));
      const total = len * loops - fade * (loops - 1);
      const out = ctx.createBuffer(channels, total, rate);
      for (let c = 0; c < channels; c++) {
        const from = src[c];
        const to = out.getChannelData(c);
        for (let loop = 0; loop < loops; loop++) {
          const base = loop * (len - fade);
          for (let i = 0; i < len; i++) {
            const s = from[start + i];
            const at = base + i;
            if (loop > 0 && i < fade) {
              const t = i / fade;
              to[at] = to[at] * (1 - t) + s * t;
            } else {
              to[at] = s;
            }
          }
        }
      }
      return out;
    }

    // Single copy of sound 1 with the head/tail silence removed and a 10ms
    // overlap at the wrap, so BufferSource.loop has no gap between repeats.
    seamlessLoop(buffer) {
      const ctx = this.audioContext;
      const channels = buffer.numberOfChannels;
      const rate = buffer.sampleRate;
      const src = [];
      for (let c = 0; c < channels; c++) src.push(buffer.getChannelData(c));
      const n = buffer.length;
      const thresh = 0.008;
      const loud = i => {
        for (let c = 0; c < channels; c++) if (Math.abs(src[c][i]) > thresh) return true;
        return false;
      };
      let start = 0;
      while (start < n && !loud(start)) start++;
      let end = n - 1;
      while (end > start && !loud(end)) end--;
      if (end - start < rate * 0.2) { start = 0; end = n - 1; }
      const len = end - start + 1;
      const fade = Math.min(Math.floor(rate * 0.01), Math.floor(len / 8));
      const period = len - fade;
      const out = ctx.createBuffer(channels, period, rate);
      for (let c = 0; c < channels; c++) {
        const from = src[c];
        const to = out.getChannelData(c);
        for (let i = 0; i < fade; i++) {
          const t = i / fade;
          to[i] = from[end - fade + 1 + i] * (1 - t) + from[start + i] * t;
        }
        for (let i = fade; i < period; i++) to[i] = from[start + i];
      }
      return out;
    }

    skipSeek(id, decoded) {
      const sec = SEEK_SEC[id];
      if (!sec || !this.audioContext) return decoded;
      const skip = Math.round(sec * decoded.sampleRate);
      if (skip <= 0 || skip >= decoded.length - 1) return decoded;
      const channels = decoded.numberOfChannels;
      const out = this.audioContext.createBuffer(channels, decoded.length - skip, decoded.sampleRate);
      for (let c = 0; c < channels; c++) {
        const from = decoded.getChannelData(c);
        const to = out.getChannelData(c);
        for (let i = 0; i < to.length; i++) to[i] = from[skip + i];
      }
      return out;
    }

    playIntroSting() {
      if (this.sting) return;
      if (!this.unlocked) {
        this.stingPending = true;
        return;
      }
      if (!this.audioContext) {
        this.stingPending = true;
        return;
      }
      if (!this.stingBuffer) {
        this.stingPending = true;
        this.loadStingBuffer();
        return;
      }
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
      const src = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      src.buffer = this.stingBuffer;
      src.connect(gain).connect(this.audioContext.destination);
      this.sting = src;
      this.stingGain = gain;
      this.stingStarted = performance.now();
      this.applyStingEnvelope();
      src.onended = () => { if (this.sting === src) this.stopIntroSting(); };
      try { src.start(); }
      catch (_) { this.stopIntroSting(); }
      this.stingPending = false;
    }

    applyStingEnvelope() {
      if (!this.sting || !this.stingGain) return;
      const t = (performance.now() - this.stingStarted) / 1000;
      const start = 0x5d6e / 0x8000;
      let v = start;
      if (t >= 7.39) v = 0;
      else if (t >= 6.82) v = 1 - (t - 6.82) / (7.39 - 6.82);
      else v = start + (1 - start) * (t / 6.82);
      v = this.muted ? 0 : Math.max(0, Math.min(1, v));
      this.stingGain.gain.setValueAtTime(v, this.audioContext.currentTime);
      if (t >= 7.45) this.stopIntroSting();
    }

    stopIntroSting() {
      const sting = this.sting;
      this.sting = null;
      this.stingGain = null;
      this.stingPending = false;
      if (!sting) return;
      try { sting.stop(); } catch (_) {}
    }

    effect(id, volume = 0.75) {
      if (id === 1) {
        this.ensureMusic();
        return;
      }
      if (this.muted || !id) return;
      if (this.audioContext && this.buffers.has(id)) {
        try {
          const src = this.audioContext.createBufferSource();
          src.buffer = this.buffers.get(id);
          const gain = this.audioContext.createGain();
          gain.gain.value = clamp(volume, 0, 1);
          src.connect(gain).connect(this.audioContext.destination);
          src.start();
          return;
        } catch (_) {}
      }
      try {
        const audio = new Audio(urlFor(id));
        audio.volume = clamp(volume, 0, 1);
        audio.muted = this.muted;
        this.effects.add(audio);
        audio.play().catch(() => this.effects.delete(audio));
        const cleanup = () => this.effects.delete(audio);
        audio.addEventListener('ended', cleanup, {once: true});
        audio.addEventListener('error', cleanup, {once: true});
      } catch (_) {}
    }

    update(dt, playing) {
      if (playing) this.stopIntroSting();
      else this.applyStingEnvelope();
      this.fade = clamp(this.fade + (playing ? 1 : -1) * dt / 1200, 0, 1);
      const vol = this.muted ? 0 : this.fade * this.musicVolume;
      if (this.bedGain && this.audioContext) {
        this.bedGain.gain.setValueAtTime(vol, this.audioContext.currentTime);
      } else {
        this.music.volume = vol;
      }
    }

    toggle() {
      this.muted = !this.muted;
      const vol = this.muted ? 0 : this.fade * this.musicVolume;
      if (this.bedGain && this.audioContext) this.bedGain.gain.setValueAtTime(vol, this.audioContext.currentTime);
      else this.music.volume = vol;
      this.applyStingEnvelope();
      for (const a of this.effects) a.muted = this.muted;
      if (!this.muted) this.unlock();
      return this.muted;
    }
  }

  window.GameAudio = GameAudio;
})();
