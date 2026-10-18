import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { optimizeReferenceBlob, REFERENCE_MAX_EDGE } from "../src/lib/referenceCompression.js";

afterEach(() => mock.restoreAll());
const large = (type = "image/png") => new Blob([new Uint8Array(3 * 1024 * 1024)], { type });

function browserMocks(output = new Blob(["optimized"], { type: "image/webp" })) {
  const bitmap = { width: 4000, height: 2000, close: mock.fn() };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (done) => done(output) };
  mock.method(globalThis, "createImageBitmap", async () => bitmap);
  mock.method(globalThis.document, "createElement", () => canvas);
  return { bitmap, canvas, output };
}

// Node has no canvas. These tests exercise policy/cleanup with browser primitives mocked.
globalThis.createImageBitmap = async () => { throw new Error("not implemented"); };
globalThis.document = { createElement() {} };

test("large references are reduced while maintaining aspect ratio", async () => {
  const { bitmap, canvas, output } = browserMocks();
  assert.equal(await optimizeReferenceBlob(large()), output);
  assert.equal(canvas.width, REFERENCE_MAX_EDGE);
  assert.equal(canvas.height, REFERENCE_MAX_EDGE / 2);
  assert.equal(bitmap.close.mock.callCount(), 1);
});

test("small references, GIFs and pixel-exact masks are never re-encoded", async () => {
  const decoder = mock.method(globalThis, "createImageBitmap", () => { throw new Error("must not decode"); });
  const small = new Blob(["png"], { type: "image/png" });
  const gif = large("image/gif");
  const mask = large();
  assert.equal(await optimizeReferenceBlob(small), small);
  assert.equal(await optimizeReferenceBlob(gif), gif);
  assert.equal(await optimizeReferenceBlob(mask, { preservePixels: true }), mask);
  assert.equal(decoder.mock.callCount(), 0);
});

test("failed or unsupported compression keeps the original and releases decoded pixels", async () => {
  const original = large();
  const { bitmap } = browserMocks(new Blob(["not-webp"], { type: "image/png" }));
  assert.equal(await optimizeReferenceBlob(original), original);
  assert.equal(bitmap.close.mock.callCount(), 1);
});

test("compression that does not save bytes is discarded", async () => {
  const original = large();
  browserMocks(large("image/webp"));
  assert.equal(await optimizeReferenceBlob(original), original);
});

test("a decoding failure is safe and does not block reference uploads", async () => {
  const original = large();
  mock.method(globalThis, "createImageBitmap", async () => { throw new Error("decode failed"); });
  assert.equal(await optimizeReferenceBlob(original), original);
});

test("signed uploads use compressed metadata but keep mask bytes and input order", async () => {
  browserMocks();
  const { uploadReferenceBlobs } = await import("../src/lib/referenceUpload.js");
  const metadata = [];
  const uploads = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/reference-upload-url")) {
      metadata.push(JSON.parse(init.body));
      return Response.json({ path: `reference-${metadata.length}`, signed_url: `https://storage.example/upload/${metadata.length}` });
    }
    uploads.push(init.body.get(""));
    assert.equal(init.method, "PUT");
    assert.equal(init.headers.Authorization, undefined);
    return new Response("ok");
  });
  const mask = large();
  const paths = await uploadReferenceBlobs([
    { blob: large(), name: "photo.png" },
    { blob: mask, name: "mask.png", preservePixels: true },
  ]);
  assert.deepEqual(paths, ["reference-1", "reference-2"]);
  assert.equal(metadata[0].content_type, "image/webp");
  assert.equal(metadata[0].size, 9);
  assert.equal(uploads[0].name, "photo.webp");
  assert.equal(metadata[1].content_type, "image/png");
  assert.equal(metadata[1].size, mask.size);
  assert.equal(uploads[1].name, "mask.png");
  assert.equal(uploads[1].size, mask.size);
});
