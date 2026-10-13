// DOM/control-flow checks. These use media doubles, not an actual browser or microphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function harness(options = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const rtc = await readFile(new URL('../public/rtc.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const audioMeter = await readFile(new URL('../public/audio-meter.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: options.url || 'https://share.example.test/', runScripts: 'outside-only' });
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
    getTransceivers() { return this.transceivers; }
    async addIceCandidate() {}
    async getStats() { return new Map(); }
    setConfiguration(value) { this.config = value; }
    restartIce() {}
    close() { this.closed = true; }
  };
  const credentials = { roomId: 'abcdefghjk23', key: 'k'.repeat(43), name: '我' };
  const fetchCalls = [];
  w.fetch = async (url) => { fetchCalls.push(url); return { ok: true, json: async () => url === '/api/config' ? { maxParticipants: 6, accessKeyRequired: false } : credentials }; };
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
  w.eval(audioMeter.replace(/export /g, '') + ';window.__AudioMeters = AudioMeters;');
  w.eval('const { PeerSession, PRESETS } = window.__rtc; const AudioMeters = window.__AudioMeters;\n' + app.replace(/^import[^\n]+\n/gm, '') + '\nwindow.__test = {state, enterRoom, handleMessage, enableMic, disableMic, startShare, stopShare, leaveRoom, render, renderLevels, renderStats};');
  const api = w.__test;
  w.document.getElementById('joinMic').checked = false;
  if (options.enter !== false) await api.enterRoom(credentials);
  const peer = (id, extra = {}) => ({ id, name: id, mic: true, sharing: false, systemAudio: false, ...extra });
  return { w, api, Track, Stream, captures, sent, peer, fetchCalls, cleanup() { api.leaveRoom(false); dom.window.close(); } };
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

test('opening an invitation selects join and pressing Enter joins without creating a new room', async () => {
  const link = `https://share.example.test/r/abcdefghjk23#key=${'x'.repeat(43)}`;
  const h = await harness({ enter: false, url: link });
  try {
    const d = h.w.document;
    assert.equal(d.getElementById('joinFields').hidden, false);
    assert.equal(d.getElementById('createFields').hidden, true);
    assert.equal(d.getElementById('joinTab').getAttribute('aria-pressed'), 'true');
    d.getElementById('displayName').value = '小林';
    d.getElementById('roomForm').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && d.getElementById('room').hidden; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(d.getElementById('room').hidden, false);
    assert.ok(!h.fetchCalls.includes('/api/rooms'));
    assert.ok(h.sent.some((message) => message.type === 'join' && message.key === 'x'.repeat(43) && message.name === '小林'));
    h.api.leaveRoom();
    assert.equal(d.getElementById('inviteInput').value, '');
    assert.equal(d.getElementById('createFields').hidden, false);
  } finally { h.cleanup(); }
});

test('listening and two volume sliders affect only local playback and preserve microphone sending', async () => {
  const h = await harness();
  try {
    await h.api.handleMessage({ type: 'peer-joined', peer: h.peer('friend', { sharing: true }), epoch: 2 });
    const session = h.api.state.sessions.get('friend');
    for (const slot of [0, 1]) session.pc.ontrack({ transceiver: session.slots[slot], track: new h.Track('audio') });
    await h.api.enableMic();
    const mic = h.api.state.micStream;
    const d = h.w.document;
    const voice = d.querySelector('audio[data-kind="voice"]');
    const desktop = d.querySelector('audio[data-kind="desktop-audio"]');
    d.getElementById('voiceVolume').value = '37';
    d.getElementById('voiceVolume').dispatchEvent(new h.w.Event('input'));
    d.getElementById('volume').value = '64';
    d.getElementById('volume').dispatchEvent(new h.w.Event('input'));
    assert.equal(voice.volume, .37); assert.equal(desktop.volume, .64);
    d.getElementById('listenButton').click();
    assert.ok(voice.muted && desktop.muted);
    assert.equal(session.slots[0].sender.track, mic.getAudioTracks()[0]);
    assert.equal(mic.getAudioTracks()[0].readyState, 'live');
    h.api.render();
    assert.ok(voice.muted && desktop.muted, 'peer redraw must not unmute playback');
    d.getElementById('listenButton').click();
    assert.ok(!voice.muted && !desktop.muted);
    assert.equal(voice.volume, .37); assert.equal(desktop.volume, .64);
  } finally { h.cleanup(); }
});

test('speaking indicators follow measured levels and cannot mark a muted peer as speaking', async () => {
  const h = await harness();
  try {
    await h.api.handleMessage({ type: 'peer-joined', peer: h.peer('one'), epoch: 2 });
    await h.api.handleMessage({ type: 'peer-joined', peer: h.peer('muted', { mic: false }), epoch: 2 });
    const levels = new Map([['one', { level: .5, speaking: true }], ['muted', { level: 1, speaking: true }]]);
    h.api.renderLevels(levels);
    const d = h.w.document;
    const one = d.querySelector('.member[data-peer="one"]');
    const muted = d.querySelector('.member[data-peer="muted"]');
    assert.ok(one.classList.contains('speaking'));
    assert.equal(one.querySelector('[data-voice-label]').textContent, '正在说话');
    assert.equal(one.querySelectorAll('.voice-meter .lit').length, 6);
    assert.ok(!muted.classList.contains('speaking'));
    assert.equal(muted.querySelectorAll('.voice-meter .lit').length, 0);
  } finally { h.cleanup(); }
});

test('network cards use actual peer totals and focused viewing can be exited with Escape', async () => {
  const h = await harness();
  try {
    for (const id of ['one', 'two']) {
      await h.api.handleMessage({ type: 'peer-joined', peer: h.peer(id), epoch: 2 });
      h.api.state.sessions.get(id).pc.connectionState = 'connected';
    }
    h.api.state.peerStats.set('one', { sent: 1.1, received: .2, rtt: 48, path: 'direct' });
    h.api.state.peerStats.set('two', { sent: 1.2, received: .3, rtt: 92, path: 'relay' });
    h.api.renderStats(true);
    const d = h.w.document;
    assert.equal(d.getElementById('uploadValue').textContent, '2.30');
    assert.equal(d.getElementById('downloadValue').textContent, '0.50');
    assert.equal(d.getElementById('latencyValue').textContent, '92');
    assert.equal(d.getElementById('detailPath').textContent, '直连 1 · 中继 1');
    assert.ok(d.getElementById('trafficLine').getAttribute('points'));
    assert.equal(d.querySelector('.member[data-peer="one"] [data-connection-label]').hidden, true);
    d.getElementById('focusButton').click();
    assert.ok(d.getElementById('room').classList.contains('focus-mode'));
    d.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.ok(!d.getElementById('room').classList.contains('focus-mode'));
    h.api.leaveRoom();
    assert.equal(d.getElementById('uploadValue').textContent, '—');
    assert.equal(d.getElementById('trafficLine').getAttribute('points'), '');
  } finally { h.cleanup(); }
});

test('screen sharing actions are visibly unavailable while another participant owns sharing', async () => {
  const h = await harness();
  try {
    await h.api.handleMessage({ type: 'peer-joined', peer: h.peer('friend', { name: '夏夏', sharing: true }), epoch: 2 });
    const d = h.w.document;
    assert.ok(d.getElementById('shareButton').disabled);
    assert.ok(d.getElementById('emptyShareButton').hidden);
    assert.equal(d.getElementById('stageStatus').textContent, '夏夏 正在共享');
    await h.api.handleMessage({ type: 'peer-state', peer: h.peer('friend', { sharing: false }), epoch: 2 });
    assert.ok(!d.getElementById('shareButton').disabled);
    assert.ok(!d.getElementById('emptyShareButton').hidden);
  } finally { h.cleanup(); }
});
