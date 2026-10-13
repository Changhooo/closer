// Analysis only: these nodes never connect to the speakers, so they cannot echo
// or duplicate the separate <audio> playback used by the voice sessions.
export class AudioMeters {
  constructor(onLevels, environment = globalThis) {
    this.onLevels = onLevels;
    this.environment = environment;
    this.context = null;
    this.sources = new Map();
    this.frame = null;
    this.lastSample = -Infinity;
  }

  ensureContext() {
    if (this.context && this.context.state !== 'closed') return this.context;
    const Constructor = this.environment.AudioContext || this.environment.webkitAudioContext;
    if (!Constructor) return null;
    try { this.context = new Constructor(); } catch { return null; }
    return this.context;
  }

  resume() {
    const context = this.ensureContext();
    return context?.resume?.().catch(() => {}) || Promise.resolve();
  }

  add(id, stream) {
    this.remove(id);
    const context = this.ensureContext();
    if (!context || !stream?.getAudioTracks().length) return;
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.sources.set(id, { source, analyser, stream, samples: new Float32Array(analyser.fftSize), holdUntil: 0 });
      this.schedule();
    } catch { /* Keep the voice controls usable if analysis is unavailable. */ }
  }

  schedule() {
    if (this.frame != null || !this.sources.size || !this.environment.requestAnimationFrame) return;
    this.frame = this.environment.requestAnimationFrame((time) => {
      this.frame = null;
      if (time - this.lastSample >= 80) { this.lastSample = time; this.sample(time); }
      this.schedule();
    });
  }

  sample(time) {
    const levels = new Map();
    for (const [id, entry] of this.sources) {
      const live = entry.stream.getAudioTracks().some((track) => track.readyState === 'live' && track.enabled && !track.muted);
      let rms = 0;
      if (live && this.context?.state === 'running') {
        entry.analyser.getFloatTimeDomainData(entry.samples);
        rms = Math.sqrt(entry.samples.reduce((sum, value) => sum + value * value, 0) / entry.samples.length);
      }
      if (rms > .025) entry.holdUntil = time + 280;
      const speaking = live && this.context?.state === 'running' && time < entry.holdUntil;
      levels.set(id, { level: live ? Math.min(1, rms * 5) : 0, speaking });
    }
    this.onLevels(levels);
  }

  remove(id) {
    const entry = this.sources.get(id);
    entry?.source.disconnect();
    entry?.analyser.disconnect();
    this.sources.delete(id);
    if (!this.sources.size && this.frame != null) {
      this.environment.cancelAnimationFrame?.(this.frame);
      this.frame = null;
    }
  }

  clear() {
    for (const id of [...this.sources.keys()]) this.remove(id);
    const context = this.context;
    this.context = null;
    this.lastSample = -Infinity;
    void context?.close?.().catch(() => {});
    this.onLevels(new Map());
  }
}
