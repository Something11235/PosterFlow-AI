import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { unzipSync } from "fflate";

globalThis.window = {
  location: { origin: "https://posterflow.example" },
  localStorage: { getItem: () => "test-client", setItem() {} },
};
const { clearImageUrlCache, fetchImageUrl, fetchImageBlob, imageDownloadUrl } = await import("../src/lib/client.js");
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
