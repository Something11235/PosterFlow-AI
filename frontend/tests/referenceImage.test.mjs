import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import createHeifDecoder from "libheif-js/libheif-wasm/libheif-bundle.js";
import { MAX_REFERENCE_FILE_BYTES, prepareReferenceImage, referenceImageType } from "../src/lib/referenceImage.js";
import { prepareReferenceBatch } from "../src/lib/referenceSelection.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWp8AAAAASUVORK5CYII=", "base64");

test("picker MIME and suffix can both be absent or wrong without changing PNG bytes", async () => {
  for (const [name, type] of [["相册", ""], ["相册.PNG", "application/octet-stream"], ["相册.heic", "image/heic"]]) {
    const file = new File([png], name, { type, lastModified: 123 });
    const normalized = await prepareReferenceImage(file);
    assert.equal(normalized.name.toLowerCase(), "相册.png");
    assert.equal(normalized.type, "image/png");
    assert.equal(normalized.lastModified, file.lastModified);
    assert.deepEqual(Buffer.from(await normalized.arrayBuffer()), png);
  }
  const original = new File([png], "相册.png", { type: "image/png" });
  assert.equal(await prepareReferenceImage(original), original);
});

test("mixed selection preserves order, rejects disguised files, and deduplicates after normalization", async () => {
  const a = new File([png], "A", { lastModified: 10 });
  const b = new File([png], "B", { lastModified: 11 });
  const invalid = new File(["<svg></svg>"], "fake.png", { type: "image/png" });
  const batch = await prepareReferenceBatch([], [a, invalid, a, b], 2);
  assert.deepEqual(batch.files.map(f => f.name), ["A.png", "B.png"]);
  assert.equal(batch.duplicates, 1);
  assert.equal(batch.unsupported, 1);
  assert.equal((await prepareReferenceBatch(batch.files, [a], 2)).duplicates, 1);
  assert.equal((await prepareReferenceBatch(batch.files, [invalid], 2)).overflow, 1);
});

test("size is checked before decoding and AVIF is not mistaken for an iPhone photo", async () => {
  const tooBig = new File([new Uint8Array(MAX_REFERENCE_FILE_BYTES + 1)], "camera.heic");
  await assert.rejects(prepareReferenceImage(tooBig), { code: "REFERENCE_IMAGE_TOO_LARGE" });
  // Both AVIF and HEIC can use mif1 as their major brand.
  for (const [brand, type] of [["avif", ""], ["heic", "image/heif"]]) {
    const ftyp = Buffer.concat([Buffer.from([0,0,0,20]), Buffer.from("ftypmif1"), Buffer.alloc(4), Buffer.from(brand)]);
    assert.equal(await referenceImageType(new Blob([ftyp])), type);
  }
});

test("the fallback worker decodes a real still HEIC into the original two colors", async t => {
  // Synthetic 512×384 red/green halves, encoded locally with Pillow/pillow-heif.
  const sample = await readFile(new URL("./fixtures/reference-colors.heic", import.meta.url));
  assert.equal(await referenceImageType(new Blob([sample])), "image/heif");
  const previous = globalThis.self;
  const responses = [];
  globalThis.self = { importScripts() {}, libheif: createHeifDecoder, postMessage(value) { responses.push(value); } };
  t.after(() => { if (previous) globalThis.self = previous; else delete globalThis.self; });
  await import("../src/lib/heifDecode.worker.js");
  const bytes = sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength);
  await globalThis.self.onmessage({ data: { bytes, decoderUrl: "local" } });
  assert.equal(responses.length, 2);
  const [ready, response] = responses;
  assert.deepEqual(ready, { phase: "decoding" });
  assert.equal(response.error, undefined);
  assert.deepEqual([response.width, response.height], [512,384]);
  assert.ok(response.data[(100 * 512 + 50) * 4] > 190);
  assert.ok(response.data[(100 * 512 + 400) * 4 + 1] > 170);
});
