import { getCanvasAsset, extractCanvasTailFrame } from "./creationCanvasProject.js";
import { needsFrameUpdate } from "../components/creationCanvasLayout.js";
import { fetchImageBlob, fetchImageDownloadUrl } from "./client.js";

const MIMES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
export const CANVAS_MEDIA_LABELS = { image: "原图", video: "视频", frame: "尾帧" };

function remoteAddress(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function canvasNodeDownloads(project, node) {
  const isReference = node.type === "reference";
  const kind = isReference ? node.assetKind || "image" : node.type;
  if (!CANVAS_MEDIA_LABELS[kind] || needsFrameUpdate(project, node)) return [];
  const source = isReference || kind === "frame" ? node : node.run || node;
  if (node.run && node.run.status !== "completed") return [];
  const key = !isReference && kind === "image" ? source.filename : "";
  const url = remoteAddress(source.url);
  if (!source.assetId && !url && !key) return [];
  const item = { id: node.id, kind, title: node.title, assetId: source.assetId, url, key, name: source.filename };
  if (kind !== "video" || isReference) return [item];
  const tail = { id: node.id + "-frame", kind: "frame", title: node.title, assetId: source.lastFrameAssetId,
    url: remoteAddress(source.lastFrameUrl), video: item };
  return [item, tail];
}

export function canvasBatchDownloads(project) {
  const items = project.nodes.flatMap(node => canvasNodeDownloads(project, node));
  const extracted = new Set(project.nodes.filter(node => node.type === "frame" && (node.assetId || node.url) && !needsFrameUpdate(project, node))
    .map(node => node.sourceNodeId || project.edges.find(edge => edge.to === node.id)?.from));
  // A frame taken from a connected video is already represented by its own node.
  return items.filter(item => !item.video || ((item.assetId || item.url) && !extracted.has(item.video.id)));
}

export function safeCanvasName(value) {
  return String(value || "").replace(/[<>:"/\\|?*\p{Cc}]/gu, "-").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 100) || "画布";
}

export function canvasDownloadName(item, blob) {
  const original = (item.name || "").split(/[\\/]/).pop();
  const extension = original?.match(/\.([a-z0-9]{1,6})$/i)?.[1] ||
    MIMES[blob?.type?.split(";")[0]] || item.url?.split("?")[0].match(/\.(mp4|mov|webm|png|jpe?g|webp|avif|gif)$/i)?.[1] || (item.kind === "video" ? "mp4" : "png");
  return safeCanvasName(original?.replace(/\.[a-z0-9]{1,6}$/i, "") || (item.title + (item.video ? "-尾帧" : ""))) + "." + extension.toLowerCase();
}

async function readRemote(item) {
  const response = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("素材链接暂时不可用");
  const blob = await response.blob();
  const type = item.kind === "video" ? "video/" : "image/";
  if (!blob.size || (blob.type && !blob.type.startsWith(type) && !blob.type.startsWith("application/octet-stream"))) throw new Error("链接没有返回媒体文件");
  return blob;
}

export async function readCanvasDownload(item, { owner, projectId, imageOptions }) {
  if (item.assetId) {
    const blob = await getCanvasAsset(owner, projectId, item.assetId);
    if (blob?.size) return blob;
  }
  if (item.key) return fetchImageBlob(item.key, imageOptions);
  if (item.url) {
    try { return await readRemote(item); }
    catch { if (!item.video) throw new Error("原文件未能读取。可在节点菜单中打开备用下载，检查链接是否已过期。"); }
  }
  if (item.video) return extractCanvasTailFrame(await readCanvasDownload(item.video, { owner, projectId, imageOptions }));
  throw new Error("本机没有保存此文件。");
}

export async function canvasBackupUrl(item, scope) {
  if (item.url) return item.url;
  if (item.key) {
    try { return await fetchImageDownloadUrl(item.key, scope.imageOptions); }
    catch (error) { if (!item.assetId) throw error; }
  }
  const blob = await getCanvasAsset(scope.owner, scope.projectId, item.assetId);
  if (!blob?.size) throw new Error("暂时无法取得备用文件。");
  return URL.createObjectURL(blob);
}

export async function createCanvasArchive(items, scope, onProgress) {
  if (!items.length) throw new Error("请先选择要导出的文件。");
  const { Zip, ZipPassThrough } = await import("fflate");
  const output = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; output.push(chunk); });
  for (const [index, item] of items.entries()) {
    onProgress?.(index, items.length, item.title);
    try {
      const blob = await readCanvasDownload(item, scope);
      const entry = new ZipPassThrough(String(index + 1).padStart(2, "0") + "-" + canvasDownloadName(item, blob));
      zip.add(entry);
      // Files are already compressed. Feed slices sequentially so large clips
      // don't require a second contiguous array for the whole archive.
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        entry.push(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()), offset + chunkSize >= blob.size);
      }
    } catch (error) {
      zip.terminate();
      throw new Error("「" + item.title + "」导出失败。" + error.message);
    }
  }
  zip.end();
  return new Blob(output, { type: "application/zip" });
}
