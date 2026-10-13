import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSession, PRESETS } from '../public/rtc.js';

class FakePC {
  constructor() { this.signalingState = 'stable'; this.transceivers = []; this.candidates = []; }
  addTransceiver(kind, options) {
    const sender = { track: null, parameters: { encodings: options.sendEncodings || [{}] },
      async replaceTrack(track) { this.track = track; },
      getParameters() { return structuredClone(this.parameters); },
      async setParameters(parameters) { this.parameters = parameters; } };
    const transceiver = { kind, sender, receiver: {} }; this.transceivers.push(transceiver); return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  async setLocalDescription() {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: 'fake', toJSON() { return { type: this.type, sdp: this.sdp }; } };
    this.signalingState = type === 'answer' ? 'stable' : 'have-local-offer';
  }
  async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate(candidate) { this.candidates.push(candidate); }
  async getStats() { return new Map(); }
  restartIce() { this.restarted = true; }
  close() { this.closed = true; }
}

function session(polite = false) {
  const sent = [], errors = [], pc = new FakePC();
  const peer = new PeerSession({ ice: {}, polite, send: (value) => sent.push(value), onTrack: () => {}, onState: () => {}, onStats: () => {}, onError: (error) => errors.push(error), factory: () => pc });
  return { peer, pc, sent, errors };
}

test('microphone, desktop audio, screen have independent fixed sender slots', async () => {
  const { peer, pc } = session();
  try {
    const mic = {}, sound = {}, video = {};
    await peer.setTrack(0, mic); await peer.setTrack(1, sound); await peer.setTrack(2, video);
    await peer.setTrack(0, null);
    assert.equal(pc.transceivers[0].sender.track, null);
    assert.equal(pc.transceivers[1].sender.track, sound);
    assert.equal(pc.transceivers[2].sender.track, video);
  } finally { peer.close(); }
});
test('ICE received before remote description is queued and drained', async () => {
  const { peer, pc, sent } = session(true);
  try {
    const candidate = { candidate: 'ice' };
    await peer.receive({ candidate }); assert.equal(pc.candidates.length, 0);
    await peer.receive({ description: { type: 'offer', sdp: 'offer' } });
    assert.deepEqual(pc.candidates, [candidate]); assert.equal(sent[0].description.type, 'answer');
  } finally { peer.close(); }
});
test('impolite offer collision is ignored while polite peer yields', async () => {
  const a = session(false), b = session(true);
  try {
    await a.peer.offer(); await b.peer.offer();
    const offer = { description: { type: 'offer', sdp: 'collision' } };
    await a.peer.receive(offer); await b.peer.receive(offer);
    assert.equal(a.pc.remoteDescription, undefined);
    assert.equal(b.sent.at(-1).description.type, 'answer');
  } finally { a.peer.close(); b.peer.close(); }
});
test('quality caps are real sender parameters, not just a UI label', async () => {
  const { peer, pc } = session();
  try {
    await peer.offer();
    await peer.applyQuality(PRESETS.smooth);
    const parameters = pc.transceivers[2].sender.parameters;
    assert.equal(parameters.encodings[0].maxBitrate, 6000000);
    assert.equal(parameters.encodings[0].maxFramerate, 60);
  } finally { peer.close(); }
});
test('separate peer sessions keep independent signaling and lifetimes', async () => {
  const a = session(false), b = session(false);
  try {
    await a.peer.offer(); a.peer.close();
    await b.peer.offer();
    assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 1);
    assert.equal(b.pc.closed, undefined);
    await a.peer.receive({ candidate: { candidate: 'stale' } });
    assert.equal(a.pc.candidates.length, 0);
  } finally { a.peer.close(); b.peer.close(); }
});
test('restart is requested from offerer and throttled', () => {
  const { peer, sent } = session(true);
  try { peer.restart(); peer.restart(); assert.deepEqual(sent, [{ restart: true }]); }
  finally { peer.close(); }
});
