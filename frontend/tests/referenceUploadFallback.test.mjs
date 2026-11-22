import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, mock, test } from "node:test";
import { uploadReferenceBlobs } from "../src/lib/referenceUpload.js";

const signUrl = "/api/reference-upload-url";
const relayUrl = "/api/reference-upload-fallback";
const completeUrl = relayUrl + "/complete";
const partBytes = 4 * 1024 * 1024;
const cleanupUrl = "/api/reference-cleanup";
const path = "accounts/test/references/mask.png";
const directUrl = "https://storage.example/upload/sign/test?token=fixture";
const mask = { name: "mask.png", blob: new Blob(["mask pixels"], { type: "image/png" }), preservePixels: true };
const signed = () => Response.json({ signed_url: directUrl, path, token: "fixture", relay_ticket: "relay-fixture" });
afterEach(() => mock.restoreAll());

test("reference connection failures include recovery advice without relabeling a rejected file", async () => {
  const hint = "请更换网络环境或开启代理后刷新页面重试，或等待一段时间后再试。";
  for (const [status, code, showHint] of [[503, "REFERENCE_UPLOAD_UNAVAILABLE", true], [413, "REFERENCE_IMAGE_TOO_LARGE", false], [429, "REFERENCE_UPLOAD_RATE_LIMITED", false]]) {
    const fetch = mock.method(globalThis, "fetch", async () => Response.json({ code, error: "无法准备参考图" }, { status }));
    await assert.rejects(uploadReferenceBlobs([mask]), error => {
      assert.equal(error.detail.includes(hint), showHint);
      return error.code === code;
    });
    fetch.mock.restore();
  }
});

test("an unreadable local file after a failed direct connection retains both recovery steps", async () => {
  const blob = new Blob([new Uint8Array(partBytes + 1)], { type: "image/png" });
  mock.method(blob, "arrayBuffer", async () => { throw new Error("unreadable file"); });
  mock.method(blob, "slice", () => { throw new Error("unreadable file"); });
  const calls = [];
  mock.method(globalThis, "fetch", async url => {
    calls.push(url);
    if (url === signUrl) return signed();
    if (url === directUrl) throw new TypeError("Failed to fetch");
    assert.equal(url, cleanupUrl);
    return Response.json({ success: true });
  });
  await assert.rejects(uploadReferenceBlobs([{ name:"example.png", blob, preservePixels:true }]), error => {
    assert.match(error.detail, /重新选择该文件/);
    assert.match(error.detail, /更换网络环境或开启代理后刷新页面重试/);
    return error.code === "REFERENCE_UPLOAD_FAILED";
  });
  assert.deepEqual(calls, [signUrl, directUrl, cleanupUrl]);
});

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

for (const size of [partBytes + 1, partBytes * 4]) {
  test(`direct failure relays all ${size} bytes in order and verifies the original mask digest`, async () => {
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    const file = { ...mask, blob: new Blob([bytes], { type: mask.blob.type }) };
    const parts = new Map();
    const calls = [];
    mock.method(globalThis, "fetch", async (url, init) => {
      if (url === signUrl) {
        calls.push("sign");
        assert.deepEqual(JSON.parse(init.body), { content_type: "image/png", size });
        return signed();
      }
      if (url === directUrl) {
        calls.push("direct");
        throw new TypeError("Failed to fetch");
      }
      const ticket = { path, token: "fixture", relay_ticket: "relay-fixture" };
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.method, "POST");
      if (url === relayUrl) {
        const index = Number(init.body.get("part_index"));
        calls.push(index);
        for (const [key, value] of Object.entries(ticket)) assert.equal(init.body.get(key), value);
        const part = init.body.get("file");
        assert.equal(part.type, "application/octet-stream");
        assert.equal(part.size, Math.min(partBytes, size - index * partBytes));
        const data = Buffer.from(await part.arrayBuffer());
        assert.deepEqual(data, bytes.subarray(index * partBytes, index * partBytes + part.size));
        if (index === 1 && !parts.has(index)) {
          parts.set(index, data);
          throw new TypeError("Lost receipt for an accepted part");
        }
        parts.set(index, data);
        return Response.json({ success: true, path, part_index: index });
      }
      assert.equal(url, completeUrl);
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.deepEqual(Buffer.concat([...parts.values()]), bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.deepEqual(JSON.parse(init.body), { ...ticket, sha256 });
      if (!calls.includes("complete")) {
        calls.push("complete");
        return new Response(null, { status: 504 });
      }
      calls.push("complete");
      return Response.json({ success: true, path });
    });
    assert.deepEqual(await uploadReferenceBlobs([file]), [path]);
    const indexes = Array.from({ length: Math.ceil(size / partBytes) }, (_, index) => index);
    indexes.splice(2, 0, 1);
    assert.deepEqual(calls, ["sign", "direct", ...indexes, "complete", "complete"]);
  });
}

test("a rejected or mismatched part receipt stops the upload and cleans up the signed path", async () => {
  const file = { ...mask, blob: new Blob([Buffer.alloc(partBytes + 1)], { type: mask.blob.type }) };
  for (const status of [200, 403, 503]) {
    const calls = [];
    const fetch = mock.method(globalThis, "fetch", async (url, init) => {
      calls.push(url);
      if (url === signUrl) return signed();
      if (url === directUrl) throw new TypeError("Failed to fetch");
      if (url === relayUrl) {
        assert.equal(init.body.get("part_index"), "0");
        return Response.json({ success: true, path, part_index: 1 }, { status });
      }
      assert.equal(url, cleanupUrl);
      assert.deepEqual(JSON.parse(init.body), { paths: [path], relay_paths: [path] });
      return Response.json({ success: true });
    });
    await assert.rejects(uploadReferenceBlobs([file]), { phase: "reference_upload" });
    const attempts = status === 503 ? 2 : 1;
    assert.deepEqual(calls, [signUrl, directUrl, ...Array(attempts).fill(relayUrl), cleanupUrl]);
    fetch.mock.restore();
  }
});

test("files larger than 16 MiB are rejected before either upload route", async () => {
  const file = { ...mask, blob: new Blob([Buffer.alloc(partBytes * 4 + 1)], { type: mask.blob.type }) };
  const fetch = mock.method(globalThis, "fetch");
  await assert.rejects(uploadReferenceBlobs([file]), { code: "REFERENCE_IMAGE_TOO_LARGE" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("a large direct upload succeeds without a chunk ticket or Web Crypto", async () => {
  const file = { ...mask, blob: new Blob([Buffer.alloc(partBytes + 1)], { type: mask.blob.type }) };
  mock.getter(globalThis, "crypto", () => undefined);
  const calls = [];
  mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url === signUrl) return Response.json({ signed_url: directUrl, path });
    assert.equal(url, directUrl);
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(await uploadReferenceBlobs([file]), [path]);
  assert.deepEqual(calls, [signUrl, directUrl]);
});

test("an older signing response cannot authorize staging a large file", async () => {
  const file = { ...mask, blob: new Blob([Buffer.alloc(partBytes + 1)], { type: mask.blob.type }) };
  const calls = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    if (url === signUrl) return Response.json({ signed_url: directUrl, path, token: "fixture" });
    if (url === directUrl) throw new TypeError("Failed to fetch");
    assert.equal(url, cleanupUrl);
    assert.deepEqual(JSON.parse(init.body), { paths: [path] });
    return Response.json({ success: true });
  });
  await assert.rejects(uploadReferenceBlobs([file]), { phase: "reference_upload", detail: /上传凭证缺失/ });
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

test("whole-file progress stays indeterminate until the receipt and retains the file-count callback", async () => {
  const events = [], counts = [];
  const files = [mask, { ...mask, name: "reference.png" }];
  let directAttempts = 0;
  mock.method(globalThis, "fetch", async url => {
    if (url === signUrl) return signed();
    if (url === directUrl) {
      const current = events.at(-1);
      assert.equal(current.stage, "direct");
      assert.equal(current.fraction, null);
      assert.equal(current.loadedBytes, 0);
      if (++directAttempts === 1) return new Response(null, { status: 200 });
      throw TypeError("Network disconnected");
    }
    assert.equal(url, relayUrl);
    assert.equal(events.at(-1).stage, "relay");
    assert.equal(events.at(-1).fraction, null);
    return Response.json({ success: true, path });
  });
  await uploadReferenceBlobs(files, {
    onProgress: (...args) => counts.push(args),
    onUploadProgress: event => {
      events.push(event);
      if (event.stage === "file-complete") throw Error("Renderer unavailable");
    },
  });
  assert.deepEqual(counts, [[0, 2], [1, 2], [2, 2]]);
  assert.deepEqual(events.filter(e => e.current === 1).map(e => e.stage), ["validating","preparing","signing","direct","file-complete"]);
  assert.deepEqual(events.filter(e => e.current === 2).map(e => e.stage), ["validating","preparing","signing","direct","relay","file-complete","complete"]);
  assert.ok(events.every(e => e.total === 2 && e.filename === files[e.current - 1].name && e.totalBytes === mask.blob.size));
  assert.equal(events.at(-1).loadedBytes, mask.blob.size);
  assert.equal(events.at(-1).fraction, 1);
});

test("chunk progress reflects acknowledged bytes once across retries and stays incomplete on final failure", async () => {
  const file = { ...mask, blob: new Blob([Buffer.alloc(partBytes + 173)], { type: "image/png" }) };
  const events = [];
  let attempts = 0;
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url === signUrl) return signed();
    if (url === directUrl) throw TypeError("Direct unavailable");
    if (url === relayUrl) {
      const index = Number(init.body.get("part_index"));
      const event = events.at(-1);
      assert.equal(event.stage, "chunk");
      assert.equal(event.part, index + 1);
      assert.equal(event.parts, 2);
      assert.equal(event.loadedBytes, index * partBytes);
      assert.equal(event.fraction, event.loadedBytes / file.blob.size);
      if (index === 0 && ++attempts === 1) throw TypeError("Part receipt lost");
      return Response.json({ success: true, path, part_index: index });
    }
    if (url === completeUrl) {
      assert.equal(events.at(-1).stage, "confirming");
      assert.equal(events.at(-1).fraction, null);
      assert.equal(events.at(-1).loadedBytes, file.blob.size);
      return Response.json({ success: false }, { status: 422 });
    }
    assert.equal(url, cleanupUrl);
    return Response.json({});
  });
  await assert.rejects(uploadReferenceBlobs([file], { onUploadProgress: e => events.push(e) }), { phase: "reference_upload" });
  assert.deepEqual(events.map(e => e.stage), ["validating","preparing","signing","direct","hashing","chunk","chunk","chunk","confirming"]);
  assert.ok(events.every(e => e.fraction !== 1));
});
