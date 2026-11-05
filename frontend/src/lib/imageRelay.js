export const IMAGE_RELAY_CHUNK_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function readImageRelay(filename, headers, readWithTimeout) {
  const parts = [];
  let offset = 0, total = null, version = "";
  do {
    const part = await readWithTimeout(async signal => {
      const response = await fetch(`/api/images/${encodeURIComponent(filename)}/content?offset=${offset}`, {
        headers: { ...headers, ...(version ? { "X-Image-Version": version } : {}) },
        credentials: "include", signal,
      });
      if (!response.ok) throw new Error(response.status === 404 ? "原图不存在或已过期，请联系站长核查。" : "网站备用通道暂时不可用，请稍后重试或使用备用下载。");
      const size = Number(response.headers.get("X-Image-Size"));
      const start = Number(response.headers.get("X-Image-Offset"));
      const tag = response.headers.get("ETag");
      if (!Number.isInteger(size) || size < 1 || size > MAX_IMAGE_BYTES || start !== offset || !tag || (total !== null && (size !== total || tag !== version))) {
        throw new Error("原图读取不完整，请重新加载。");
      }
      const blob = await response.blob();
      if (blob.size !== Math.min(IMAGE_RELAY_CHUNK_BYTES, size - offset)) throw new Error("原图读取不完整，请重新加载。");
      total = size; version = tag;
      return blob;
    }, 40000, "网站备用通道读取超时，请稍后重试。");
    parts.push(part); offset += part.size;
  } while (offset < total);
  const gif = filename.toLowerCase().endsWith(".gif");
  const blob = new Blob(parts, { type: gif ? "image/gif" : "image/png" });
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (gif ? !/^GIF8[79]a$/.test(String.fromCharCode(...signature.slice(0, 6))) : ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => signature[index] === value)) throw new Error("原图格式异常，请重试。");
  return blob;
}
