import { fetchImageBlob } from "./client.js";

export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export async function createImageArchive(filenames, { onProgress, ...options } = {}) {
  const names = [...new Set(filenames)];
  if (!names.length || names.length > 100) throw new Error("每次请选择 1 至 100 张图片");
  const { zipSync } = await import("fflate");
  const entries = Object.create(null);
  let totalBytes = 0;
  // Sequential downloads bound peak memory and avoid a burst of Storage reads.
  for (const [index, filename] of names.entries()) {
    const safeName = filename.split(/[\\/]/).pop();
    if (!safeName || safeName === "." || safeName === "..") throw new Error("图片文件名无效");
    const blob = await fetchImageBlob(filename, options);
    totalBytes += blob.size;
    if (totalBytes > MAX_EXPORT_BYTES) throw new Error("所选图片超过 64 MB，请分批导出");
    entries[safeName] = new Uint8Array(await blob.arrayBuffer());
    onProgress?.(index + 1, names.length);
  }
  // PNG/JPEG/WebP are already compressed; don't spend CPU recompressing them.
  return new Blob([zipSync(entries, { level: 0 })], { type: "application/zip" });
}
