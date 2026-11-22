import { sha256 } from "js-sha256";

const READ_BYTES = 1024 * 1024;

function readWithFileReader(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reader.onabort = () => reject(reader.error || new Error("文件读取中断"));
    reader.readAsArrayBuffer(blob);
  });
}

async function readPart(blob) {
  if (typeof blob.arrayBuffer === "function") {
    try {
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength === blob.size) return bytes;
    } catch { /* Some browsers expose this method but cannot read the file through it. */ }
  }
  const bytes = await readWithFileReader(blob);
  if (bytes?.byteLength !== blob.size) throw new Error("文件读取不完整");
  return bytes;
}

export async function referenceDigest(blob, onHashedBytes) {
  try {
    if (typeof globalThis.crypto?.subtle?.digest === "function" && typeof blob.arrayBuffer === "function") {
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength === blob.size) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        if (digest.byteLength === 32) {
          return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        }
      }
    }
  } catch { /* Native hashing can fail on large files or restricted browser engines. */ }

  try {
    const hash = sha256.create();
    for (let start = 0; start < blob.size; start += READ_BYTES) {
      const part = blob.slice(start, Math.min(blob.size, start + READ_BYTES));
      hash.update(new Uint8Array(await readPart(part)));
      try { onHashedBytes?.(start + part.size); }
      catch { /* An observer must not change the digest or prevent the upload. */ }
    }
    return hash.hex();
  } catch {
    const detail = "浏览器未能读取完整的参考图。请将原图保存到本机，重新选择该文件后上传。";
    throw Object.assign(new Error(detail), { code: "REFERENCE_UPLOAD_FAILED", phase: "reference_upload", detail });
  }
}
