import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync } from "fflate";
import { canvasBatchDownloads, canvasBackupUrl, canvasNodeDownloads, createCanvasArchive, readCanvasDownload } from "../src/lib/creationCanvasDownloads.js";

test("only current outputs can be exported, and an extracted tail appears once", () => {
  const video = { id: "v", type: "video", title: "镜头", run: { requestId: "new", status: "completed", url: "https://cdn.example/clip.mp4", lastFrameAssetId: "tail" } };
  const frame = { id: "f", type: "frame", assetId: "tail", sourceNodeId: "v", sourceRequestId: "new" };
  const project = { nodes: [video, frame, { id: "pending", type: "image", assetId: "old", run: { status: "pending" } }], edges: [{ from: "v", to: "f" }] };
  assert.deepEqual(canvasBatchDownloads(project).map(item => item.id), ["v", "f"]);
  assert.deepEqual(canvasNodeDownloads(project, video).map(item => item.kind), ["video", "frame"]);
  frame.sourceRequestId = "old";
  assert.deepEqual(canvasBatchDownloads(project).map(item => item.id), ["v", "v-frame"]);
  video.run.lastFrameAssetId = "";
  assert.deepEqual(canvasBatchDownloads(project).map(item => item.id), ["v"]);
});

test("ZIP preserves duplicate source names, file bytes and original media types", async t => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    urls.push(url);
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers, undefined);
    return new Response(new Uint8Array([urls.length, 2, 4]), { headers: { "Content-Type": "image/webp" } });
  });
  const source = { title: "节点", kind: "image", name: "../图.webp", url: "https://cdn.example/source" };
  const scope = { owner: "guest", projectId: "fixture", imageOptions: {} };
  const files = unzipSync(new Uint8Array(await (await createCanvasArchive([source, source], scope)).arrayBuffer()));
  assert.deepEqual(Object.keys(files), ["01-图.webp", "02-图.webp"]);
  assert.deepEqual([...files["02-图.webp"]], [2, 2, 4]);
  assert.equal(await canvasBackupUrl(source, scope), source.url);
  assert.equal(urls.length, 2);
  const invalid = { ...source, url: "javascript:alert(1)", id: "v", type: "video" };
  assert.deepEqual(canvasNodeDownloads({ nodes: [invalid], edges: [] }, invalid), []);
});

test("cross-origin read failures keep the direct backup and report which file failed", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  const item = { kind: "video", title: "镜头三", url: "https://cdn.example/v.mp4" };
  await assert.rejects(readCanvasDownload(item, {}), /备用下载/);
  await assert.rejects(createCanvasArchive([item], {}), /镜头三.*备用下载/);
  assert.equal(await canvasBackupUrl(item, {}), item.url);
});
