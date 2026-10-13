import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioMeters } from '../public/audio-meter.js';

function harness() {
  let amplitude = 0, nextFrame = 0;
  const frames = new Map();
  const nodes = [];
  class Context {
    constructor() { this.state = 'running'; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { const node = { connected: false, disconnected: false, connect() { this.connected = true; }, disconnect() { this.disconnected = true; } }; nodes.push(node); return node; }
    createAnalyser() { const node = { getFloatTimeDomainData(samples) { samples.fill(amplitude); }, disconnect() { this.disconnected = true; } }; nodes.push(node); return node; }
  }
  let levels;
  const env = { AudioContext: Context, requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); } };
  const meters = new AudioMeters((value) => { levels = value; }, env);
  const track = { readyState: 'live', enabled: true, muted: false };
  meters.add('speaker', { getAudioTracks: () => [track] });
  return { meters, track, frames, nodes, setAmplitude(value) { amplitude = value; }, sample(time) { meters.sample(time); return levels.get('speaker'); } };
}

test('speaking requires measured audio, settles after silence, and muted tracks cannot retain speaking', () => {
  const h = harness();
  try {
    assert.equal(h.sample(100).speaking, false);
    h.setAmplitude(.12);
    assert.equal(h.sample(200).speaking, true);
    assert.ok(Math.abs(h.sample(201).level - .6) < .001);
    h.setAmplitude(0);
    assert.equal(h.sample(250).speaking, true, 'short pauses should not flicker');
    assert.equal(h.sample(600).speaking, false);
    h.setAmplitude(.12); h.sample(700);
    h.track.enabled = false;
    assert.deepEqual(h.sample(720), { level: 0, speaking: false });
  } finally { h.meters.clear(); }
});

test('clearing meters disconnects analysis and animation without stopping owned media tracks', () => {
  const h = harness();
  assert.equal(h.frames.size, 1);
  const context = h.meters.context;
  h.meters.clear();
  assert.equal(h.frames.size, 0);
  assert.ok(h.nodes.every((node) => node.disconnected));
  assert.equal(context.state, 'closed');
  assert.equal(h.track.readyState, 'live');
  assert.equal(h.meters.sources.size, 0);
});

test('unsupported or suspended audio analysis does not invent a signal', () => {
  const unsupported = new AudioMeters(() => {}, {});
  unsupported.add('speaker', { getAudioTracks: () => [{ readyState: 'live', enabled: true }] });
  assert.equal(unsupported.sources.size, 0);
  const h = harness();
  try {
    h.setAmplitude(1); h.meters.context.state = 'suspended';
    assert.deepEqual(h.sample(100), { level: 0, speaking: false });
  } finally { h.meters.clear(); }
});
