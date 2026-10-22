import { CLIENT_HEADERS } from "./client.js";
import { optimizeReferenceBlob } from "./referenceCompression.js";
import { MAX_REFERENCE_FILE_BYTES, REFERENCE_FILE_ACCEPT } from "./referenceSelection.js";

const API_BASE = "/api";
const SUPPORTED_TYPES = new Set(REFERENCE_FILE_ACCEPT.split(","));

function responseError(payload, fallback) {
  const error = new Error(String(payload?.error || payload?.detail || fallback));
  error.code = payload?.code || "REFERENCE_UPLOAD_FAILED";
  error.detail = payload?.detail || fallback;
  return error;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "参考图上传服务返回了无法识别的响应" };
  }
}

function normalizeEntry(entry, index) {
  const blob = entry?.blob || entry;
  if (!(blob instanceof Blob)) throw new Error("参考图内容无法读取");
  const contentType = String(blob.type || "").toLowerCase();
  if (!SUPPORTED_TYPES.has(contentType)) throw new Error("参考图仅支持 PNG、JPG、WebP 或 GIF");
  if (blob.size > MAX_REFERENCE_FILE_BYTES) throw new Error("参考图不能超过 16 MB");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
  const filename = entry?.name || (blob instanceof File && blob.name) || `reference-${index + 1}.${extension}`;
  return { blob, contentType, filename, preservePixels: Boolean(entry?.preservePixels) };
}

export async function cleanupReferencePaths(paths, headers = {}) {
  const normalized = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!normalized.length) return;
  try {
    await fetch(`${API_BASE}/reference-cleanup`, {
      method: "POST",
      headers: { ...CLIENT_HEADERS, ...headers, "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ paths: normalized }),
    });
  } catch {
    // The server also removes paths after generation; cleanup is best effort here.
  }
}

export async function uploadReferenceBlobs(entries, { headers = {}, onProgress } = {}) {
  const normalizedEntries = (Array.isArray(entries) ? entries : [entries]).map(normalizeEntry);
  const uploadedPaths = [];
  try {
    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const original = normalizedEntries[index];
      const optimized = await optimizeReferenceBlob(original.blob, { preservePixels: original.preservePixels });
      const entry = optimized === original.blob ? original : {
        ...original, blob: optimized, contentType: optimized.type,
        filename: original.filename.replace(/\.[^.]*$/, "") + ".webp",
      };
      onProgress?.(index, normalizedEntries.length);
      const urlResponse = await fetch(`${API_BASE}/reference-upload-url`, {
        method: "POST",
        headers: { ...CLIENT_HEADERS, ...headers, "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content_type: entry.contentType, size: entry.blob.size }),
      });
      const urlPayload = await readJson(urlResponse);
      if (!urlResponse.ok || urlPayload.error || !urlPayload.signed_url || !urlPayload.path) {
        throw responseError(urlPayload, "参考图上传地址获取失败");
      }

      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", entry.blob, entry.filename);
      const uploadResponse = await fetch(urlPayload.signed_url, {
        method: "PUT",
        headers: { "x-upsert": "false" },
        body: form,
      });
      if (!uploadResponse.ok) {
        const uploadPayload = await readJson(uploadResponse);
        throw responseError(uploadPayload, "参考图上传失败");
      }
      uploadedPaths.push(urlPayload.path);
    }
    onProgress?.(normalizedEntries.length, normalizedEntries.length);
    return uploadedPaths;
  } catch (error) {
    await cleanupReferencePaths(uploadedPaths, headers);
    throw error;
  }
}

export function uploadReferenceFiles(files, options) {
  return uploadReferenceBlobs(files, options);
}
