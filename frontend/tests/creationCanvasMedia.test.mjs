import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasInputInfo, prepareCanvasReference, readCanvasReference, readCanvasVideoDuration } from '../src/lib/creationCanvasMedia.js';

function browserMedia(t, duration) {
  const prior = globalThis.document;
  const urls = [];
  globalThis.document = { createElement: kind => ({
    duration, removeAttribute() {}, load() {},
    set src(url) {
      urls.push([kind, url]);
      if (duration) queueMicrotask(() => this.onloadedmetadata?.());
      else queueMicrotask(() => this.onerror?.());
    },
  }) };
  t.after(() => { if (prior) globalThis.document = prior; else delete globalThis.document; });
  return urls;
}

test('uploaded files retain their kind/name and audio/video use actual measured duration', async t => {
  const urls = browserMedia(t, 4.876);
  for (const [filename, kind] of [['日落.webp', 'image'], ['镜头.mp4', 'video'], ['配乐.wav', 'audio'], ['剧本.pdf', 'document']]) {
    const metadata = await prepareCanvasReference(new File(['synthetic'], filename));
    assert.deepEqual(metadata, { assetKind: kind, filename, ...(['audio','video'].includes(kind) ? { duration_ms: 4876 } : {}) });
  }
  assert.deepEqual(urls.map(([kind]) => kind), ['video', 'audio']);
  await assert.rejects(prepareCanvasReference(new File(['text'], 'script.html')));
});

test('legacy references, generated shots and extracted frames are distinguished without guessing durations', () => {
  assert.deepEqual(canvasInputInfo({ type: 'reference', filename: 'ref.jpg' }), { kind: 'image', name: 'ref.jpg' });
  assert.equal(canvasInputInfo({ type: 'frame' }).kind, 'image');
  assert.deepEqual(canvasInputInfo({ type: 'video', duration_ms: 9000, run: { duration: 5 } }), { kind: 'video', name: 'video.mp4' });
  assert.equal(canvasInputInfo({ type: 'video', run: { duration: 5, duration_ms: 4123 } }).duration_ms, 4123);
});

test('URL-only old video results can be measured; an unreadable file never falls back to a requested duration', async t => {
  const urls = browserMedia(t, 4.24);
  const result = await readCanvasReference('guest', 'p', { type: 'video', title: '镜头', run: {
    status: 'completed', duration: 5, url: 'https://media.example.test/shot.mp4',
  } }, 'video');
  assert.equal(result.duration_ms, 4240);
  assert.deepEqual(urls, [['video', 'https://media.example.test/shot.mp4']]);
  await assert.rejects(readCanvasVideoDuration({ url: 'https://secret@media.example.test/video.mp4' }));
  await assert.rejects(readCanvasReference('guest', 'p', { type: 'reference', assetKind: 'document' }, 'image'), /只接受图片/);
});

test('an unreadable video cannot be quoted with a guessed duration', async t => {
  browserMedia(t, NaN);
  await assert.rejects(readCanvasVideoDuration({ blob: new Blob(['invalid']), duration: 8 }), /无法读取/);
});

test('only bounded, typed image data is passed to an image generator', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.credentials, 'omit');
    return new Response('picture', { headers: { 'content-type': 'image/webp' } });
  });
  const result = await readCanvasReference('guest', 'p', { type: 'frame', url: 'https://media.example.test/frame.webp' }, 'image');
  assert.equal(result.blob.type, 'image/webp');
  assert.equal(result.kind, 'image');
  assert.equal(result.name, 'reference.webp');
  const videoReference = await readCanvasReference('guest', 'p', { type: 'image', run: {
    status: 'completed', url: 'https://media.example.test/generated.jpg?token=abc',
  } }, 'video');
  assert.equal(videoReference.name, 'reference.jpg');
});
