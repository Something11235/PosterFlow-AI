import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { unzipSync } from "fflate";

globalThis.window = {
  location: { origin: "https://posterflow.example" },
  localStorage: { getItem: () => "test-client", setItem() {} },
};
const { clearImageUrlCache, fetchImageUrl, fetchImageBlob, fetchImageDownloadUrl, imageDownloadUrl, IMAGE_URL_TIMEOUT_MS, IMAGE_READ_TIMEOUT_MS } = await import("../src/lib/client.js");
const { createImageArchive, MAX_EXPORT_BYTES } = await import("../src/lib/batchDownload.js");
const options = { authenticated: true, headers: { Authorization: "Bearer user-a" } };
const directUrl = "https://project.supabase.co/storage/v1/object/sign/test.png?token=test";
const signed = (url = directUrl) => Response.json({ url, expires_in: 3600 });

beforeEach(() => clearImageUrlCache());
afterEach(() => mock.restoreAll());

test("preview, modal and canvas reuse a URL and coalesce concurrent signing", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => signed());
  const urls = await Promise.all([fetchImageUrl("test.png", options), fetchImageUrl("test.png", options)]);
  assert.deepEqual(urls, [directUrl, directUrl]);
  assert.equal(await fetchImageUrl("test.png", options), directUrl);
  assert.equal(fetcher.mock.callCount(), 1);
});

test("URL cache is isolated by login identity", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => signed());
  await fetchImageUrl("test.png", options);
  await fetchImageUrl("test.png", { authenticated: true, headers: { Authorization: "Bearer user-b" } });
  await fetchImageUrl("test.png");
  assert.equal(fetcher.mock.callCount(), 3);
});

test("cookie-only authenticated requests do not share cached identities", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => signed());
  await fetchImageUrl("test.png", { authenticated: true });
  await fetchImageUrl("test.png", { authenticated: true });
  assert.equal(fetcher.mock.callCount(), 2);
});

test("expired signed URLs are refreshed before reuse", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const fetcher = mock.method(globalThis, "fetch", async () => signed());
  await fetchImageUrl("test.png", options);
  now = 3600 * 1000;
  await fetchImageUrl("test.png", options);
  assert.equal(fetcher.mock.callCount(), 2);
});

test("signing errors are not cached and fallback receives user authentication", async () => {
  let signingCalls = 0;
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("/url")) {
      signingCalls += 1;
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    assert.equal(url, "/api/images/test.png");
    assert.equal(init.headers.Authorization, options.headers.Authorization);
    return new Response("image", { headers: { "Content-Type": "image/png" } });
  });
  assert.equal((await fetchImageBlob("test.png", options)).size, 5);
  await fetchImageUrl("test.png", options);
  assert.equal(signingCalls, 2);
});

test("direct Storage reads never receive platform credentials", async () => {
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("/url")) return signed();
    assert.equal(url, directUrl);
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.headers, undefined);
    return new Response("png");
  });
  assert.equal((await fetchImageBlob("test.png", options)).size, 3);
});

test("an expired Storage signature is re-signed only once", async () => {
  let signs = 0;
  let reads = 0;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) { signs += 1; return signed(); }
    reads += 1;
    return new Response(reads === 1 ? "expired" : "png", { status: reads === 1 ? 403 : 200 });
  });
  assert.equal((await fetchImageBlob("test.png", options)).size, 3);
  assert.equal(signs, 2);
  assert.equal(reads, 2);
});

test("downloads request attachment headers without altering the signature", () => {
  const url = new URL(imageDownloadUrl(directUrl, "测试.png"));
  assert.equal(url.searchParams.get("token"), "test");
  assert.equal(url.searchParams.get("download"), "测试.png");
  assert.equal(imageDownloadUrl("/api/images/test.png", "test.png"), "https://posterflow.example/api/images/test.png");
});

test("ZIP export reads Storage directly and packages exact bytes in browser", async () => {
  const paths = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    paths.push(url);
    if (url.includes("/url")) return signed(url.includes("one.png") ? directUrl + "1" : directUrl + "2");
    assert.equal(init.headers, undefined);
    return new Response(url.endsWith("1") ? "one-image" : "two-image");
  });
  const progress = [];
  const blob = await createImageArchive(["one.png", "two.png", "one.png"], {
    ...options, onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(blob.type, "application/zip");
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(archive), ["one.png", "two.png"]);
  assert.equal(new TextDecoder().decode(archive["one.png"]), "one-image");
  assert.equal(new TextDecoder().decode(archive["two.png"]), "two-image");
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.ok(paths.every((path) => !path.includes("download-batch")));
});

test("ZIP errors never produce an archive containing an error response", async () => {
  mock.method(globalThis, "fetch", async (url) => url.includes("/url") ? signed() : new Response("not found", { status: 404 }));
  await assert.rejects(createImageArchive(["test.png"], options), /404/);
});

test("oversized exports stop instead of consuming unbounded browser memory", async () => {
  mock.method(globalThis, "fetch", async (url) => url.includes("/url") ? signed() : {
    ok: true, status: 200, blob: async () => ({ size: MAX_EXPORT_BYTES + 1 }),
  });
  await assert.rejects(createImageArchive(["test.png"], options), /64 MB/);
  await assert.rejects(createImageArchive([], options), /1 至 100/);
});

test("thumbnail signing is isolated from full-size signing and downloads", async () => {
  const requests = [];
  mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return signed(url.includes("variant=thumbnail") ? directUrl + "-thumb" : directUrl);
  });
  assert.equal(await fetchImageUrl("test.png", { ...options, variant: "thumbnail" }), directUrl + "-thumb");
  assert.equal(await fetchImageUrl("test.png", options), directUrl);
  assert.equal(requests.length, 2);
});

test("full-size bytes are reused across preview, canvas and ZIP with concurrent deduplication", async () => {
  let reads = 0;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) return signed();
    reads += 1;
    return new Response("original-pixels");
  });
  const [first, second] = await Promise.all([fetchImageBlob("test.png", options), fetchImageBlob("test.png", options)]);
  assert.equal(first, second);
  assert.equal(await fetchImageBlob("test.png", options), first);
  const zip = await createImageArchive(["test.png"], options);
  const contents = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(new TextDecoder().decode(contents["test.png"]), "original-pixels");
  assert.equal(reads, 1);
});

test("binary cache is identity-isolated, short-lived and cleared on sign-out", async () => {
  let now = 0;
  let reads = 0;
  mock.method(Date, "now", () => now);
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) return signed();
    reads += 1;
    return new Response("image");
  });
  await fetchImageBlob("test.png", options);
  await fetchImageBlob("test.png", { ...options, headers: { Authorization: "Bearer user-b" } });
  now = 11 * 60 * 1000;
  await fetchImageBlob("test.png", options);
  clearImageUrlCache();
  await fetchImageBlob("test.png", options);
  assert.equal(reads, 4);
});

test("binary cache evicts old entries instead of growing beyond the memory budget", async () => {
  let reads = 0;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) return signed();
    reads += 1;
    return { ok: true, status: 200, blob: async () => ({ size: 30 * 1024 * 1024 }) };
  });
  await fetchImageBlob("one.png", options);
  await fetchImageBlob("two.png", options);
  await fetchImageBlob("one.png", options);
  assert.equal(reads, 3);
});

test("in-flight reads cannot repopulate a cleared login cache", async () => {
  let release;
  let reads = 0;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) return signed();
    reads += 1;
    if (reads === 1) await new Promise((resolve) => { release = resolve; });
    return new Response("image");
  });
  const first = fetchImageBlob("test.png", options);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  clearImageUrlCache();
  release();
  await first;
  await fetchImageBlob("test.png", options);
  assert.equal(reads, 2);
});

test("HTML/JSON error payloads cannot be cached or downloaded as images", async () => {
  mock.method(globalThis, "fetch", async (url) => url.includes("/url") ? signed() : Response.json({ error: "bad image" }));
  await assert.rejects(fetchImageBlob("test.png", options), /有效图片/);
});

async function waitFor(predicate) {
  for (let tries = 0; tries < 30; tries += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Expected image request did not start");
}

test("a stalled signing request is aborted and releases callers to the authenticated fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signingSignal;
  let attempts = 0;
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("/url")) {
      attempts += 1;
      signingSignal = init.signal;
      return new Promise(() => {}); // Reproduce a transport that ignores abort.
    }
    assert.equal(init.headers.Authorization, options.headers.Authorization);
    return new Response("fallback-image");
  });
  const pending = fetchImageBlob("timeout.png", options);
  await waitFor(() => signingSignal);
  t.mock.timers.tick(IMAGE_URL_TIMEOUT_MS);
  assert.equal((await pending).size, 14);
  assert.equal(signingSignal.aborted, true);
  const retry = fetchImageUrl("timeout.png", options);
  await waitFor(() => attempts === 2);
  t.mock.timers.tick(IMAGE_URL_TIMEOUT_MS);
  assert.equal(await retry, "/api/images/timeout.png");
});

test("the signing deadline also covers a stalled JSON body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodyStarted = false;
  mock.method(globalThis, "fetch", async () => ({
    ok: true, json: () => { bodyStarted = true; return new Promise(() => {}); },
  }));
  const pending = fetchImageUrl("json-timeout.png", options);
  await waitFor(() => bodyStarted);
  t.mock.timers.tick(IMAGE_URL_TIMEOUT_MS);
  assert.equal(await pending, "/api/images/json-timeout.png");
});

test("a stalled original rejects both preview and download, then permits a fresh retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let reads = 0;
  let release;
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("/url")) return signed();
    reads += 1;
    if (reads === 1) {
      signal = init.signal;
      return new Promise(resolve => { release = resolve; });
    }
    return new Response("fresh-image");
  });
  const preview = fetchImageBlob("read-timeout.png", options);
  const download = fetchImageBlob("read-timeout.png", options);
  const rejected = Promise.all([
    assert.rejects(preview, { code: "IMAGE_READ_TIMEOUT" }),
    assert.rejects(download, /原图读取超时/),
  ]);
  await waitFor(() => signal);
  assert.equal(reads, 1);
  t.mock.timers.tick(IMAGE_READ_TIMEOUT_MS);
  await rejected;
  assert.equal(signal.aborted, true);
  const fresh = await fetchImageBlob("read-timeout.png", options);
  assert.equal(await fresh.text(), "fresh-image");
  release(new Response("late-stale-image"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await fetchImageBlob("read-timeout.png", options), fresh);
  assert.equal(reads, 2);
});

test("the original deadline covers the complete response body, not only response headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodyStarted = false;
  let signal;
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("/url")) return signed();
    signal = init.signal;
    return { ok: true, status: 200, blob: () => { bodyStarted = true; return new Promise(() => {}); } };
  });
  const rejected = assert.rejects(fetchImageBlob("body-timeout.png", options), /原图读取超时/);
  await waitFor(() => bodyStarted);
  t.mock.timers.tick(IMAGE_READ_TIMEOUT_MS);
  await rejected;
  assert.equal(signal.aborted, true);
});

test("explicit retry refreshes the signature and cached original, without affecting other images", async () => {
  let signs = 0;
  let reads = 0;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) { signs += 1; return signed(); }
    reads += 1;
    return new Response("image-" + reads);
  });
  const other = await fetchImageBlob("other.png", options);
  const first = await fetchImageBlob("retry.png", options);
  const refreshed = await fetchImageBlob("retry.png", { ...options, forceRefresh: true });
  assert.notEqual(first, refreshed);
  assert.equal(signs, 3);
  assert.equal(reads, 3);
  assert.equal(await fetchImageBlob("other.png", options), other);
  assert.equal(await fetchImageBlob("retry.png", options), refreshed);
});

test("network errors are actionable and do not reveal signed URLs or retain failed requests", async () => {
  let reads = 0;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) return signed();
    reads += 1;
    if (reads === 1) throw new TypeError("Network request failed for " + directUrl);
    return new Response("retry-success");
  });
  await assert.rejects(fetchImageBlob("network.png", options), error => {
    assert.match(error.message, /检查网络连接后重试/);
    assert.equal(error.message.includes("token="), false);
    return true;
  });
  assert.equal((await fetchImageBlob("network.png", options)).size, 13);
});

test("expired or empty originals produce explicit failures and never enter the image cache", async () => {
  let empty = false;
  mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("/url")) return signed();
    return empty ? new Response("") : new Response("missing", { status: 404 });
  });
  await assert.rejects(fetchImageBlob("missing.png", options), /图片不存在或已过期/);
  empty = true;
  await assert.rejects(fetchImageBlob("missing.png", options), /图片内容为空/);
});

test("backup download obtains a fresh authenticated URL without waiting for a stalled original", async () => {
  let signs = 0;
  let reads = 0;
  let release;
  mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("/url")) {
      assert.equal(init.headers.Authorization, options.headers.Authorization);
      signs += 1;
      return signed();
    }
    reads += 1;
    return new Promise(resolve => { release = resolve; });
  });
  const pending = fetchImageBlob("test.png", options);
  await waitFor(() => release);
  const backup = new URL(await fetchImageDownloadUrl("test.png", options));
  assert.equal(backup.origin, "https://project.supabase.co");
  assert.equal(backup.searchParams.get("token"), "test");
  assert.equal(backup.searchParams.get("download"), "test.png");
  assert.equal(backup.searchParams.has("access_token"), false);
  assert.equal(signs, 2);
  assert.equal(reads, 1);
  release(new Response("original"));
  await pending;
});

test("backup fallback uses the existing cookie-authenticated download route", async () => {
  mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Authorization, options.headers.Authorization);
    return Response.json({ error: "temporarily unavailable" }, { status: 503 });
  });
  assert.equal(await fetchImageDownloadUrl("测试.png", options), "/api/download/%E6%B5%8B%E8%AF%95.png");
});

test("guest backup fallback carries only the browser client ID, never a user token", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({}, { status: 503 }));
  assert.equal(await fetchImageDownloadUrl("test.png"), "/api/download/test.png?client_id=test-client");
});

test("backup download always uses the original and renews a previously cached signature", async () => {
  const requests = [];
  mock.method(globalThis, "fetch", async url => { requests.push(url); return signed(); });
  await fetchImageUrl("test.png", options);
  await fetchImageDownloadUrl("test.png", { ...options, variant: "thumbnail" });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => !url.includes("thumbnail")));
});

test("backup links reject unsafe protocols and embedded credentials", async () => {
  for (const url of ["javascript:alert(1)", "http://external.example/test.png", "https://user:password@external.example/test.png"]) {
    mock.method(globalThis, "fetch", async () => signed(url));
    await assert.rejects(fetchImageDownloadUrl("test.png", options), /下载地址暂时不可用/);
  }
});
