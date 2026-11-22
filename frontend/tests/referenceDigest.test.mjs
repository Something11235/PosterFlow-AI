import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { referenceDigest } from "../src/lib/referenceDigest.js";
import { uploadReferenceBlobs } from "../src/lib/referenceUpload.js";

const expected = bytes => createHash("sha256").update(bytes).digest("hex");

test("native Web Crypto hashes the exact reference bytes, including zero bytes", async () => {
  const bytes = new Uint8Array([0, 255, 0, 1]);
  const progress = [];
  assert.equal(await referenceDigest(new Blob([bytes]), n => progress.push(n)), expected(bytes));
  assert.deepEqual(progress, []);
});

for (const unavailable of [true, false]) {
  test(`chunked SHA-256 matches complete-file hashes when native crypto is ${unavailable ? "missing" : "rejected"}`, async t => {
    const calls = [];
    t.mock.getter(globalThis, "crypto", () => unavailable ? undefined : { subtle: {
      async digest() { calls.push("digest"); throw new Error("native digest unavailable"); },
    } });
    for (const size of [0, 55, 56, 64, 1024 * 1024 + 55, 4 * 1024 * 1024 + 3]) {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = i % 251;
      assert.equal(await referenceDigest(new Blob([bytes])), expected(bytes));
    }
    assert.equal(calls.length, unavailable ? 0 : 6);
  });
}

test("legacy browsers read bounded slices with FileReader when Blob.arrayBuffer is unavailable", async t => {
  const nativeRead = Blob.prototype.arrayBuffer;
  const sizes = [];
  t.mock.method(Blob.prototype, "arrayBuffer", () => { throw new Error("unsupported"); });
  const reader = globalThis.FileReader;
  t.after(() => { if (reader) globalThis.FileReader = reader; else delete globalThis.FileReader; });
  globalThis.FileReader = class {
    async readAsArrayBuffer(blob) {
      sizes.push(blob.size);
      this.result = await nativeRead.call(blob);
      this.onload();
    }
  };
  const bytes = Buffer.alloc(1024 * 1024 + 43, 152);
  assert.equal(await referenceDigest(new Blob([bytes])), expected(bytes));
  assert.deepEqual(sizes, [1024 * 1024, 43]);
});

test("an unreadable file raises an actionable error instead of supplying an unchecked hash", async t => {
  t.mock.method(Blob.prototype, "arrayBuffer", async () => new ArrayBuffer(0));
  await assert.rejects(referenceDigest(new Blob(["image bytes"])), {
    code: "REFERENCE_UPLOAD_FAILED", phase: "reference_upload", detail: /重新选择该文件/,
  });
});

test("hash progress counts only bytes already processed and an observer cannot interrupt the digest", async t => {
  t.mock.getter(globalThis, "crypto", () => undefined);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 123);
  const progress = [];
  const actual = await referenceDigest(new Blob([bytes]), n => {
    progress.push(n);
    throw new Error("view closed");
  });
  assert.equal(actual, expected(bytes));
  assert.deepEqual(progress, [1024 * 1024, 2 * 1024 * 1024, bytes.length]);
});

test("software hash progress is separate from the bytes received by the upload relay", async t => {
  t.mock.getter(globalThis, "crypto", () => undefined);
  const unit = 1024 * 1024;
  const bytes = Buffer.alloc(4 * unit + 3);
  const entry = { name: "test.png", blob: new Blob([bytes], { type: "image/png" }), preservePixels: true };
  const direct = "https://storage.example.test/signed";
  const path = "fixture/test.png";
  const events = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "/api/reference-upload-url") return Response.json({ signed_url: direct, path, token: "t", relay_ticket: "r" });
    if (url === direct) throw new TypeError("Failed to fetch");
    if (url === "/api/reference-upload-fallback") return Response.json({ success: true, path, part_index: Number(init.body.get("part_index")) });
    assert.equal(url, "/api/reference-upload-fallback/complete");
    assert.equal(JSON.parse(init.body).sha256, expected(bytes));
    return Response.json({ success: true, path });
  });
  assert.deepEqual(await uploadReferenceBlobs([entry], { onUploadProgress: event => events.push(event) }), [path]);
  const hashing = events.filter(event => event.stage === "hashing");
  assert.deepEqual(hashing.map(event => event.loadedBytes), [0, unit, 2 * unit, 3 * unit, 4 * unit, bytes.length]);
  assert.deepEqual(hashing.map(event => event.fraction), [null, ...hashing.slice(1).map(event => event.loadedBytes / bytes.length)]);
  assert.deepEqual(events.filter(event => event.stage === "chunk").map(event => event.loadedBytes), [0, 4 * unit]);
});
