import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { uploadReferenceBlobs } from "../src/lib/referenceUpload.js";

const signUrl = "/api/reference-upload-url";
const relayUrl = "/api/reference-upload-fallback";
const cleanupUrl = "/api/reference-cleanup";
const path = "accounts/test/references/mask.png";
const directUrl = "https://storage.example/upload/sign/test?token=fixture";
const mask = { name: "mask.png", blob: new Blob(["mask pixels"], { type: "image/png" }), preservePixels: true };
const signed = () => Response.json({ signed_url: directUrl, path, token: "fixture" });
afterEach(() => mock.restoreAll());

test("a lost Storage connection uploads the same mask and ticket through the site exactly once", async () => {
  const calls = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    if (url === directUrl) {
      assert.equal(init.method, "PUT");
      assert.deepEqual(init.headers, { "x-upsert": "false" });
      assert.equal(init.credentials, "omit");
      throw new TypeError("Failed to fetch");
    }
    assert.equal(init.headers["X-Provider-Key"], undefined);
    assert.equal(init.headers.Authorization, "Bearer test-account");
    assert.equal(init.headers["X-Billing-Mode"], "platform");
    assert.equal(init.headers["X-Client-Id"], "browser-fixture");
    assert.equal(init.credentials, "same-origin");
    if (url === signUrl) return signed();
    assert.equal(url, relayUrl);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], undefined);
    assert.deepEqual([...init.body.keys()], ["path", "token", "file"]);
    assert.equal(init.body.get("token"), "fixture");
    assert.equal(init.body.get("path"), path);
    const file = init.body.get("file");
    assert.equal(file.name, mask.name);
    assert.equal(file.type, mask.blob.type);
    assert.equal(await file.text(), "mask pixels");
    return Response.json({ success: true, path });
  });
  const headers = { Authorization: "Bearer test-account", "X-Billing-Mode": "platform", "X-Client-Id": "browser-fixture", "X-Provider-Key": "test-provider" };
  assert.deepEqual(await uploadReferenceBlobs([mask], { headers }), [path]);
  assert.deepEqual(calls, [signUrl, directUrl, relayUrl]);
});

test("a stalled direct upload aborts before switching routes, including at the 4 MiB boundary", async () => {
  const file = { name: "mask.png", blob: new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "image/png" }), preservePixels: true };
  const nativeSetTimeout = globalThis.setTimeout;
  mock.method(globalThis, "setTimeout", (callback, ms) => nativeSetTimeout(callback, Math.min(ms, 20)));
  const calls = [];
  let directAborted = false;
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    if (url === signUrl) return Response.json({ path, signed_url: directUrl });
    if (url === directUrl) return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => {
      directAborted = true;
      reject(init.signal.reason);
    }, { once: true }));
    assert.equal(url, relayUrl);
    assert.equal(directAborted, true);
    assert.equal(init.headers.Authorization, undefined);
    assert.ok(init.headers["X-Client-Id"]);
    assert.equal(init.body.get("token"), "fixture");
    return Response.json({ success: true, path });
  });
  assert.deepEqual(await uploadReferenceBlobs([file], { headers: { "X-Billing-Mode": "own_key" } }), [path]);
  assert.deepEqual(calls, [signUrl, directUrl, relayUrl]);
});

for (const status of [403, 429]) {
  test(`explicit Storage rejection ${status} is reported without relaying`, async () => {
    const calls = [];
    mock.method(globalThis, "fetch", async (url, init) => {
      calls.push(url);
      if (url === signUrl) return signed();
      if (url === directUrl) return new Response("opaque", { status });
      assert.equal(url, cleanupUrl);
      assert.deepEqual(JSON.parse(init.body), { paths: [path] });
      return Response.json({ success: true });
    });
    await assert.rejects(uploadReferenceBlobs([mask]), { phase: "reference_upload", diagnostic: `HTTP_${status}` });
    assert.deepEqual(calls, [signUrl, directUrl, cleanupUrl]);
  });
}

test("a file above 4 MiB remains direct-only and includes compression advice after a connection failure", async () => {
  const file = { ...mask, blob: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: mask.blob.type }) };
  const calls = [];
  mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url === signUrl) return signed();
    if (url === directUrl) throw new TypeError("Failed to fetch");
    assert.equal(url, cleanupUrl);
    return Response.json({ success: true });
  });
  await assert.rejects(uploadReferenceBlobs([file]), { phase: "reference_upload", detail: /压缩至 4 MiB/, diagnostic: "CONNECTION_INTERRUPTED" });
  assert.deepEqual(calls, [signUrl, directUrl, cleanupUrl]);
});

test("a relay acknowledging a different path cannot advance the request", async () => {
  const calls = [];
  mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url === signUrl) return signed();
    if (url === directUrl) return new Response("gateway", { status: 503 });
    if (url === relayUrl) return Response.json({ success: true, path: "other/object" });
    assert.equal(url, cleanupUrl);
    return Response.json({ success: true });
  });
  await assert.rejects(uploadReferenceBlobs([mask]), { phase: "reference_upload", diagnostic: "RESPONSE_INVALID" });
  assert.deepEqual(calls, [signUrl, directUrl, relayUrl, cleanupUrl]);
});
