// DOM/control-flow checks. These use media doubles, not an actual browser or microphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function harness() {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const rtc = await readFile(new URL('../public/rtc.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://share.example.test/', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w, 'isSecureContext', { value: true });
  w.HTMLMediaElement.prototype.play = async function () {};
  w.HTMLDialogElement.prototype.close = function () {};
  w.HTMLDialogElement.prototype.showModal = function () {};
  class Track {
    constructor(kind) { this.kind = kind; this.readyState = 'live'; this.enabled = true; this.stops = 0; }
    stop() { this.readyState = 'ended'; this.stops++; }
    getSettings() { return { width: 1280, height: 720 }; }
    async applyConstraints(value) { this.constraints = value; }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  }
  w.MediaStream = Stream;
  w.structuredClone = structuredClone;
  w.RTCPeerConnection = class {
    constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.transceivers = []; }
    addTransceiver(kind, options) {
      const sender = { track: null, params: { encodings: options.sendEncodings || [{}] },
        async replaceTrack(track) { this.track = track; }, getParameters() { return structuredClone(this.params); },
        async setParameters(params) { this.params = params; } };
      const transceiver = { kind, sender }; this.transceivers.push(transceiver); return transceiver;
    }
    async setLocalDescription() {
      const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
      this.localDescription = { type, sdp: 'fake-sdp', toJSON() { return { type, sdp: this.sdp }; } };
      this.signalingState = type === 'answer' ? 'stable' : 'have-local-offer';
    }
    async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    async addIceCandidate() {}
    async getStats() { return new Map(); }
    setConfiguration(value) { this.config = value; }
    restartIce() {}
    close() { this.closed = true; }
  };
  const credentials = { roomId: 'abcdefghjk23', key: 'k'.repeat(43), name: '我' };
  w.fetch = async (url) => ({ ok: true, json: async () => url === '/api/config' ? { maxParticipants: 6, accessKeyRequired: false } : credentials });
  const sent = [];
  w.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
    send(value) {
      const payload = JSON.parse(value); sent.push(payload);
      if (payload.type === 'join') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'joined', selfId: 'self', peers: [], epoch: 1, ice: {} }) }), 0);
      if (payload.type === 'share-request') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'share-result', requestId: payload.requestId, granted: true }) }), 0);
    }
    close() { this.readyState = 3; }
  };
  const captures = [];
  Object.defineProperty(w.navigator, 'mediaDevices', { value: {
    async getUserMedia() { const stream = new Stream([new Track('audio')]); captures.push(stream); return stream; },
    async getDisplayMedia() { const stream = new Stream([new Track('video'), new Track('audio')]); captures.push(stream); return stream; },
  } });
  w.eval(rtc.replace(/export /g, '') + ';window.__rtc = {PeerSession,PRESETS};');
  w.eval(app.replace(/^import[^\n]+\n/, 'const { PeerSession, PRESETS } = window.__rtc;\n') + '\nwindow.__test = {state, enterRoom, handleMessage, enableMic, disableMic, startShare, stopShare, leaveRoom, render};');
  const api = w.__test;
  w.document.getElementById('joinMic').checked = false;
  await api.enterRoom(credentials);
  const peer = (id, extra = {}) => ({ id, name: id, mic: true, sharing: false, systemAudio: false, ...extra });
  return { w, api, Track, Stream, captures, sent, peer, cleanup() { api.leaveRoom(false); dom.window.close(); } };
}

test('controller supports three other members and renders names as text', async () => {
  const h = await harness();
  try {
    for (const id of ['one', 'two', 'three']) await h.api.handleMessage({ type: 'peer-joined', peer: h.peer(id, { name: id === 'two' ? '<img src=x onerror=alert(1)>' : id }), epoch: 2 });
    assert.equal(h.api.state.sessions.size, 3);
    assert.equal(h.w.document.getElementById('memberCount').textContent, '4 / 6');
    assert.equal(h.w.document.querySelectorAll('#membersList img').length, 0);
    assert.ok(h.w.document.getElementById('membersList').textContent.includes('<img'));
  } finally { h.cleanup(); }
});

test('all peer senders get the screen while microphone and shared sound mute independently', async () => {
  const h = await harness();
  try {
    for (const id of ['one', 'two']) await h.api.handleMessage({ type: 'peer-joined', peer: h.peer(id), epoch: 2 });
    await h.api.enableMic(); await h.api.startShare();
    const screen = h.api.state.screenStream;
    await h.api.disableMic();
    for (const session of h.api.state.sessions.values()) {
      assert.equal(session.slots[0].sender.track, null);
      assert.equal(session.slots[1].sender.track, screen.getAudioTracks()[0]);
      assert.equal(session.slots[2].sender.track, screen.getVideoTracks()[0]);
    }
    h.w.document.getElementById('systemAudioButton').click();
    assert.equal(screen.getAudioTracks()[0].enabled, false);
    await h.api.stopShare();
    assert.ok(screen.getTracks().every((track) => track.readyState === 'ended'));
    assert.ok(h.sent.some((message) => message.type === 'share-stop'));
  } finally { h.cleanup(); }
});

test('only the current sharing owner has audible desktop sound', async () => {
  const h = await harness();
  try {
    for (const id of ['one', 'two']) await h.api.handleMessage({ type: 'peer-joined', peer: h.peer(id), epoch: 2 });
    for (const [id, session] of h.api.state.sessions) session.pc.ontrack({ transceiver: session.slots[1], track: new h.Track('audio') });
    await h.api.handleMessage({ type: 'peer-state', peer: h.peer('two', { sharing: true }), epoch: 2 });
    assert.equal(h.w.document.querySelector('audio[data-peer="one"]').muted, true);
    assert.equal(h.w.document.querySelector('audio[data-peer="two"]').muted, false);
  } finally { h.cleanup(); }
});

test('a departing participant does not close the other voice sessions', async () => {
  const h = await harness();
  try {
    for (const id of ['one', 'two']) await h.api.handleMessage({ type: 'peer-joined', peer: h.peer(id), epoch: 2 });
    const retained = h.api.state.sessions.get('two');
    await h.api.handleMessage({ type: 'peer-left', id: 'one', epoch: 3 });
    assert.equal(h.api.state.sessions.size, 1);
    assert.equal(retained.pc.closed, undefined);
  } finally { h.cleanup(); }
});

test('microphone denial leaves the participant joined', async () => {
  const h = await harness();
  try {
    h.w.navigator.mediaDevices.getUserMedia = async () => { throw new h.w.DOMException('Denied', 'NotAllowedError'); };
    await h.api.enableMic();
    assert.equal(h.api.state.joined, true);
    assert.equal(h.api.state.micStream, null);
    assert.equal(h.w.document.getElementById('room').hidden, false);
  } finally { h.cleanup(); }
});

test('leaving during a capture prompt stops late media and sends no new publication', async () => {
  const h = await harness();
  try {
    let resolve;
    h.w.navigator.mediaDevices.getDisplayMedia = () => new Promise((done) => { resolve = done; });
    const pending = h.api.startShare();
    h.api.leaveRoom(false);
    const capture = new h.Stream([new h.Track('video'), new h.Track('audio')]);
    resolve(capture); await pending;
    assert.ok(capture.getTracks().every((track) => track.readyState === 'ended'));
    assert.equal(h.sent.filter((message) => message.type === 'share-request').length, 0);
  } finally { h.cleanup(); }
});
