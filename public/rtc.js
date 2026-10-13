export const PRESETS = Object.freeze({
  economy: { label: '省流 · 720p / 15 帧', width: 1280, height: 720, fps: 15, bitrate: 1200000 },
  balanced: { label: '均衡 · 720p / 30 帧', width: 1280, height: 720, fps: 30, bitrate: 2000000 },
  clear: { label: '清晰 · 1080p / 30 帧', width: 1920, height: 1080, fps: 30, bitrate: 3500000 },
  smooth: { label: '流畅 · 1080p / 60 帧', width: 1920, height: 1080, fps: 60, bitrate: 6000000 },
});

// Fixed slots keep microphone and desktop audio separate. Muting the microphone
// must never mute the movie. Screen switching uses replaceTrack, without renegotiation.
export class PeerSession {
  constructor({ ice, polite, send, onTrack, onState, onStats, onError,
                factory = (config) => new RTCPeerConnection(config) }) {
    this.pc = factory(ice);
    this.polite = polite;
    this.send = send;
    this.onError = onError;
    this.closed = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingAnswer = false;
    this.candidates = [];
    this.signalQueue = Promise.resolve();
    this.lastSamples = new Map();
    this.lastRestart = 0;
    this.pendingQuality = PRESETS.economy;
    this.slots = [
      this.pc.addTransceiver('audio', { direction: 'sendrecv' }),
      this.pc.addTransceiver('audio', { direction: 'sendrecv' }),
      this.pc.addTransceiver('video', { direction: 'sendrecv', sendEncodings: [{ maxBitrate: 1200000, maxFramerate: 15 }] }),
    ];
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate && !this.closed) this.send({ candidate: candidate.toJSON() });
    };
    this.pc.ontrack = (event) => {
      const index = this.slots.indexOf(event.transceiver);
      const kind = ['voice', 'desktop-audio', 'screen'][index];
      if (!this.closed && kind) onTrack(kind, event.track);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      onState(this.pc.connectionState);
      if (this.pc.connectionState === 'connected') this.applyQuality(this.pendingQuality).catch(this.onError);
      if (this.pc.connectionState === 'failed') this.restart();
    };
    this.statsTimer = setInterval(() => this.collectStats(onStats).catch(() => {}), 2000);
  }

  async setTrack(slot, track) {
    if (!this.closed) await this.slots[slot].sender.replaceTrack(track || null);
  }

  async applyQuality(preset) {
    if (this.closed) return;
    this.pendingQuality = preset;
    if (!this.pc.localDescription) return;
    const sender = this.slots[2].sender;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = preset.bitrate;
    parameters.encodings[0].maxFramerate = preset.fps;
    // Some browsers do not support this optional preference. The finite bitrate
    // and FPS caps still apply; don't hide a bitrate failure behind this hint.
    parameters.degradationPreference = 'balanced';
    try {
      await sender.setParameters(parameters);
    } catch (error) {
      if (error.name !== 'TypeError' && error.name !== 'NotSupportedError') throw error;
      delete parameters.degradationPreference;
      await sender.setParameters(parameters);
    }
  }

  async offer() {
    if (this.closed || this.makingOffer) return;
    this.makingOffer = true;
    // One queue owns SDP, including locally initiated offers. A queued remote
    // description may win before this operation reaches the stable-state check.
    const operation = this.signalQueue.then(async () => {
      if (this.closed || this.pc.signalingState !== 'stable') return;
      await this.pc.setLocalDescription();
      if (!this.closed) this.send({ description: this.pc.localDescription.toJSON() });
    }).catch((error) => {
      if (!this.closed) this.onError(error);
    }).finally(() => { this.makingOffer = false; });
    this.signalQueue = operation;
    await operation;
  }

  receive(data) {
    // Candidate frames can arrive before an offer due to signaling scheduling.
    this.signalQueue = this.signalQueue.then(() => this.receiveOne(data)).catch((error) => {
      if (!this.closed) this.onError(error);
    });
    return this.signalQueue;
  }

  async receiveOne({ description, candidate, restart }) {
    if (this.closed) return;
    if (restart) {
      if (!this.polite) this.restart();
      return;
    }
    if (description) {
      const ready = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingAnswer);
      const collision = description.type === 'offer' && !ready;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      this.settingAnswer = description.type === 'answer';
      try {
        await this.pc.setRemoteDescription(description);
      } finally {
        this.settingAnswer = false;
      }
      for (const queued of this.candidates.splice(0)) await this.pc.addIceCandidate(queued);
      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        if (!this.closed) this.send({ description: this.pc.localDescription.toJSON() });
      }
    } else if (candidate && !this.ignoreOffer) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
      else if (this.candidates.length < 128) this.candidates.push(candidate);
    }
  }

  restart() {
    if (this.closed || Date.now() - this.lastRestart < 8000) return;
    this.lastRestart = Date.now();
    if (this.polite) this.send({ restart: true });
    else {
      this.pc.restartIce();
      void this.offer();
    }
  }

  async collectStats(callback) {
    if (this.closed) return;
    const reports = await this.pc.getStats();
    let sent = 0, received = 0, fps = null, width = null, height = null, rtt = null, path = 'unknown';
    let selectedPair = null;
    for (const report of reports.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId) selectedPair = reports.get(report.selectedCandidatePairId);
    }
    for (const report of reports.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated && !selectedPair) selectedPair = report;
      if ((report.type === 'outbound-rtp' || report.type === 'inbound-rtp') && !report.isRemote) {
        const bytes = report.bytesSent ?? report.bytesReceived;
        const previous = this.lastSamples.get(report.id);
        if (previous && report.timestamp > previous.time && bytes >= previous.bytes) {
          const mbps = (bytes - previous.bytes) * 8 / (report.timestamp - previous.time) / 1000;
          if (report.type === 'outbound-rtp') sent += mbps;
          else received += mbps;
        }
        this.lastSamples.set(report.id, { bytes, time: report.timestamp });
        if (report.kind === 'video' || report.mediaType === 'video') {
          if (report.frameWidth) {
            width = report.frameWidth; height = report.frameHeight;
            fps = report.framesPerSecond ?? null;
          }
        }
      }
    }
    if (selectedPair) {
      rtt = selectedPair.currentRoundTripTime == null ? null : Math.round(selectedPair.currentRoundTripTime * 1000);
      const local = reports.get(selectedPair.localCandidateId);
      const remote = reports.get(selectedPair.remoteCandidateId);
      path = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
    }
    if (!this.closed) callback({ sent, received, fps, width, height, rtt, path });
  }

  close() {
    this.closed = true;
    clearInterval(this.statsTimer);
    this.pc.close();
    this.candidates.length = 0;
    this.lastSamples.clear();
  }
}
