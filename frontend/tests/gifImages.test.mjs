import test from 'node:test';
import assert from 'node:assert/strict';
import {readImageRelay, IMAGE_RELAY_CHUNK_BYTES} from '../src/lib/imageRelay.js';
import {GPT26_IMAGE_MODELS, imageCreditCost} from '../src/lib/provider.js';

test('GIF is offered only through the two GPT26 version configurations at the existing unit price', () => {
  for (const model of GPT26_IMAGE_MODELS) {
    assert.deepEqual(model.outputFormats, ['png', 'gif']);
    assert.equal(model.maxCount, 1);
    assert.equal(imageCreditCost(model.value), 1);
  }
});
test('authenticated fallback reconstructs GIF bytes across chunks with image/gif MIME', async () => {
  const before = global.fetch, bytes = new Uint8Array(IMAGE_RELAY_CHUNK_BYTES + 19);
  bytes.set(new TextEncoder().encode('GIF89a'));bytes[bytes.length - 1] = 59;
  global.fetch = async url => {
    const offset = Number(new URL(url, 'https://local.invalid').searchParams.get('offset'));
    return new Response(bytes.slice(offset, offset + IMAGE_RELAY_CHUNK_BYTES), {headers: {'X-Image-Size': String(bytes.length), 'X-Image-Offset': String(offset), ETag: '"fixture"'}});
  };
  try {
    const blob = await readImageRelay('fixture.gif', {}, async callback => callback(undefined));
    assert.equal(blob.type, 'image/gif');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  } finally { global.fetch = before; }
});
test('a mislabeled GIF is rejected rather than offered as an apparently valid download', async () => {
  const before = global.fetch;
  global.fetch = async () => new Response(new Uint8Array([137,80,78,71,13,10,26,10]), {headers: {'X-Image-Size':'8','X-Image-Offset':'0',ETag:'"fixture"'}});
  try { await assert.rejects(readImageRelay('fixture.gif', {}, async callback => callback(undefined)), /格式异常/); }
  finally { global.fetch = before; }
});
