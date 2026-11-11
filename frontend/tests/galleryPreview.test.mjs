import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGalleryPreview } from '../src/lib/galleryPreview.js';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(overrides = {}) {
  const events = [], blobReads = [], revoked = [], created = [], timers = new Map();
  let timerId = 0;
  const reader = createGalleryPreview({ filename: 'saved.png', authenticated: true,
    headers: { Authorization: 'Bearer synthetic-user-a' },
    loadUrl: async () => 'https://storage.example/thumbnail.png',
    loadBlob: async (name, options) => { blobReads.push({ name, options }); return new Blob(['saved image']); },
    onChange: value => events.push(value),
    createObjectURL: blob => { created.push(blob); return 'blob:existing-image'; },
    revokeObjectURL: url => revoked.push(url),
    schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    cancel: id => timers.delete(id), ...overrides,
  });
  return { reader, events, blobReads, revoked, created, timers,
    expire(delay) {
      const timer = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(timer, `expected ${delay} ms timer`);
      timers.delete(timer[0]); timer[1].fn();
    },
  };
}

test('working thumbnail never downloads the full image; loaded preview cancels its deadline', async () => {
  const f = fixture(); await flush();
  assert.equal(f.events.at(-1).url, 'https://storage.example/thumbnail.png');
  f.reader.loaded(f.events.at(-1).url);
  assert.equal(f.events.at(-1).state, 'ready');
  assert.equal(f.blobReads.length, 0); assert.equal(f.timers.size, 0);
  f.reader.dispose(); assert.deepEqual(f.revoked, []);
});

test('an error event before a source is assigned cannot start recovery or a retry loop', async () => {
  let resolve;
  const f = fixture({ loadUrl: () => new Promise(done => { resolve = done; }) });
  f.reader.failed(''); f.reader.failed(undefined); assert.equal(f.blobReads.length, 0);
  resolve('https://storage.example/thumbnail.png'); await flush();
  f.reader.loaded(f.events.at(-1).url); assert.equal(f.events.at(-1).state, 'ready');
  f.reader.dispose();
});

test('a failed thumbnail loads existing original via the authenticated reader once and revokes its blob', async () => {
  const f = fixture(); await flush(); const url = f.events.at(-1).url;
  f.reader.failed(url); f.reader.failed(url); await flush();
  assert.equal(f.blobReads.length, 1);
  assert.deepEqual(f.blobReads[0], { name: 'saved.png', options: {
    authenticated: true, headers: { Authorization: 'Bearer synthetic-user-a' }, variant: 'original',
    forceBackup: true, forceRefresh: false, directReadTimeoutMs: 8000,
  } });
  f.reader.loaded('blob:existing-image'); assert.equal(f.events.at(-1).state, 'ready');
  f.reader.dispose(); f.reader.dispose(); assert.deepEqual(f.revoked, ['blob:existing-image']);
});

test('a stuck browser image switches to the original reader; late thumbnail events cannot override it', async () => {
  const f = fixture(); await flush();
  f.expire(15000); await flush();
  f.reader.loaded('https://storage.example/thumbnail.png');
  assert.equal(f.events.at(-1).url, 'blob:existing-image');
  assert.equal(f.events.at(-1).state, 'loading');
  f.reader.loaded('blob:existing-image'); assert.equal(f.events.at(-1).state, 'ready');
  f.reader.dispose();
});

test('URL lookup timeout and late URL response cannot replace a recovered original', async () => {
  let resolve;
  const f = fixture({ loadUrl: () => new Promise(done => { resolve = done; }) });
  f.expire(15000); await flush(); resolve('https://storage.example/late.png'); await flush();
  assert.equal(f.events.at(-1).url, 'blob:existing-image');
  assert.equal(f.blobReads.length, 1); f.reader.dispose();
});

test('switching account or unmounting discards late image data without creating an object URL', async () => {
  let resolve;
  const f = fixture({ loadBlob: () => new Promise(done => { resolve = done; }) });
  await flush(); f.reader.failed(f.events.at(-1).url); f.reader.dispose();
  const count = f.events.length;
  resolve(new Blob(['old account'])); await flush();
  assert.equal(f.events.length, count); assert.deepEqual(f.created, []); assert.equal(f.timers.size, 0);
});

test('failed or stalled recovery has a terminal error instead of endless retries or a blank card', async () => {
  for (const rejects of [true, false]) {
    let resolve;
    const f = fixture({ loadBlob: () => rejects ? Promise.reject(new Error('network')) : new Promise(done => { resolve = done; }) });
    await flush(); f.reader.failed(f.events.at(-1).url); await flush();
    if (!rejects) { f.expire(90000); resolve(new Blob(['late'])); await flush(); }
    assert.equal(f.events.at(-1).state, 'error'); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.created, []); f.reader.dispose();
  }
});

test('undecodable recovery revokes its object URL and user retry requests a fresh read', async () => {
  const f = fixture({ forceRefresh: true }); await flush(); f.reader.failed(f.events.at(-1).url); await flush();
  assert.equal(f.blobReads[0].options.forceRefresh, true);
  f.reader.failed('blob:existing-image'); assert.equal(f.events.at(-1).state, 'error');
  assert.deepEqual(f.revoked, ['blob:existing-image']); f.reader.dispose();
  assert.equal(f.revoked.length, 1);
});
