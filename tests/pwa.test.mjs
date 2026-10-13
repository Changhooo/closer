import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const code = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const events = new Map(), puts = [], deletions = [];
  const response = new Response('public asset');
  const cache = { async put(request) { puts.push(request.url); }, async addAll() {} };
  const self = { location: { origin: 'https://share.example.test' }, addEventListener(type, fn) { events.set(type, fn); }, clients: { async claim() {} }, async skipWaiting() {} };
  const caches = { async open() { return cache; }, async match() { return response; }, async keys() { return ['tongping-shell-1.0.0', 'tongping-shell-1.1.1', 'another-app-cache']; }, async delete(key) { deletions.push(key); } };
  runInNewContext(code, { self, caches, URL, Response, fetch: async () => response });
  return { events, puts, deletions };
}

test('service worker leaves room invitations, API, signaling, and foreign requests uncached', async () => {
  const h = worker();
  for (const path of ['/r/abcdefghjk23', '/api/config', '/api/rooms', '/ws', '/styles.css?key=secret', '/#key=secret', 'https://other.example/styles.css']) {
    let intercepted = false;
    h.events.get('fetch')({ request: new Request(new URL(path, 'https://share.example.test')), respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
  let pending;
  h.events.get('fetch')({ request: new Request('https://share.example.test/styles.css'), respondWith(value) { pending = value; } });
  assert.equal((await pending).status, 200);
  assert.deepEqual(h.puts, ['https://share.example.test/styles.css']);
});

test('worker updates remove only obsolete application shell caches', async () => {
  const h = worker();
  let pending;
  h.events.get('activate')({ waitUntil(value) { pending = value; } });
  await pending;
  assert.deepEqual(h.deletions, ['tongping-shell-1.0.0']);
});

test('desktop installation starts at the lobby and ships real maskable icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/app.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const data = await readFile(new URL(`../public${icon.src}`, import.meta.url));
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(data.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
    assert.ok(icon.purpose.includes('maskable'));
  }
});
