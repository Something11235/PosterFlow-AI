export const REFERENCE_OPTIMIZE_THRESHOLD = 2 * 1024 * 1024;
export const REFERENCE_MAX_EDGE = 2560;

export async function optimizeReferenceBlob(blob, { preservePixels = false } = {}) {
  // Never re-encode masks, animated GIFs, or already small references.
  if (preservePixels || blob.type === "image/gif" || blob.size <= REFERENCE_OPTIMIZE_THRESHOLD
      || typeof globalThis.createImageBitmap !== "function") return blob;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) return blob;
    const scale = Math.min(1, REFERENCE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // WebP retains transparency. Keep the original if unsupported or not smaller.
    const optimized = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
    return optimized?.type === "image/webp" && optimized.size < blob.size * 0.9 ? optimized : blob;
  } catch {
    return blob;
  } finally {
    bitmap?.close();
  }
}
