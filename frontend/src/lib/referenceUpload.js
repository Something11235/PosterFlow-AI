import { CLIENT_HEADERS } from "./client.js";
import { optimizeReferenceBlob } from "./referenceCompression.js";
import { MAX_REFERENCE_FILE_BYTES, REFERENCE_FILE_ACCEPT } from "./referenceSelection.js";
import { imageTransportDiagnostic } from "./imageGenerationError.js";

const API_BASE = "/api";
const SUPPORTED_TYPES = new Set(REFERENCE_FILE_ACCEPT.split(","));
// Leave headroom for multipart headers within the site's function body limit.
const MAX_FALLBACK_BYTES = 4 * 1024 * 1024;

function responseError(payload, fallback, response) {
  const error = new Error(fallback);
  error.code = "REFERENCE_UPLOAD_FAILED";
  error.detail = fallback;
  if (typeof payload?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(payload.code)) {
    error.code = payload.code;
    if (typeof payload.detail === "string" && payload.detail) error.detail = payload.detail;
    else if (typeof payload.error === "string" && payload.error) error.detail = payload.error;
  } else {
    error.diagnostic = imageTransportDiagnostic(null, response.status);
  }
  error.phase = "reference_upload";
  return error;
}

function referenceHeaders(headers) {
  const provided = new Headers(headers);
  const result = { ...CLIENT_HEADERS };
  for (const name of ["Authorization", "X-Billing-Mode", "X-Client-Id"]) {
    if (provided.has(name)) result[name] = provided.get(name);
  }
  return result;
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

async function uploadRequest(url, init, timeoutMs, detail) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    const payload = init.method === "POST" ? await readJson(response) : null;
    return { response, payload };
  } catch (cause) {
    throw Object.assign(new Error(detail), {
      code: "REFERENCE_UPLOAD_FAILED", phase: "reference_upload",
      detail, diagnostic: imageTransportDiagnostic(cause),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function uploadSignedReference(signed, entry, headers) {
  const directForm = new FormData();
  directForm.append("cacheControl", "3600");
  directForm.append("", entry.blob, entry.filename);
  const canRelay = entry.blob.size <= MAX_FALLBACK_BYTES;
  let directResponse;
  let directFailure;
  try {
    const direct = await uploadRequest(signed.signed_url, {
      method: "PUT", headers: { "x-upsert": "false" }, credentials: "omit", body: directForm,
    }, canRelay ? 30000 : null, "浏览器未收到参考图直传结果。");
    directResponse = direct.response;
  } catch (error) {
    directFailure = error;
  }
  if (directResponse?.ok) return;
  if (directResponse) {
    directFailure = responseError(null, "参考图直传未成功。", directResponse);
    if (directResponse.status < 500 && directResponse.status !== 408) throw directFailure;
  }
  if (!canRelay) {
    directFailure.detail = "参考图直传未完成。可压缩至 4 MiB 以内以使用备用上传，或切换网络后重试。";
    throw directFailure;
  }
  // Reuse the original signed path. Only the website gets session credentials.
  let token = signed.token;
  if (!token) {
    try { token = new URL(signed.signed_url).searchParams.get("token"); } catch { /* Malformed or expired ticket. */ }
  }
  if (!token) {
    directFailure.detail = "参考图直传未完成，上传凭证缺失。请刷新页面后重试。";
    throw directFailure;
  }
  const form = new FormData();
  form.append("path", signed.path);
  form.append("token", token);
  form.append("file", entry.blob, entry.filename);
  const { response, payload } = await uploadRequest(`${API_BASE}/reference-upload-fallback`, {
    method: "POST", credentials: "same-origin", headers, body: form,
  }, 90000, "网站备用上传未能确认结果，请稍后重新上传参考图。");
  if (!response.ok || payload?.success !== true || payload?.path !== signed.path) {
    throw responseError(payload, "网站备用上传未完成，请稍后重新上传参考图。", response);
  }
}

function normalizeEntry(entry, index) {
  const blob = entry?.blob || entry;
  if (!(blob instanceof Blob)) throw Object.assign(new Error("参考图内容无法读取"), {code:"REFERENCE_IMAGE_INVALID"});
  const contentType = String(blob.type || "").toLowerCase();
  if (!SUPPORTED_TYPES.has(contentType)) throw Object.assign(new Error("参考图仅支持 PNG、JPG、WebP 或 GIF"), {code:"REFERENCE_IMAGE_UNSUPPORTED"});
  if (blob.size > MAX_REFERENCE_FILE_BYTES) throw Object.assign(new Error("参考图不能超过 16 MB"), {code:"REFERENCE_IMAGE_TOO_LARGE"});
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
  const filename = entry?.name || (blob instanceof File && blob.name) || `reference-${index + 1}.${extension}`;
  return { blob, contentType, filename, preservePixels: Boolean(entry?.preservePixels) };
}

export async function cleanupReferencePaths(paths, headers = {}) {
  const normalized = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!normalized.length) return;
  try {
    await uploadRequest(`${API_BASE}/reference-cleanup`, {
      method: "POST",
      headers: { ...referenceHeaders(headers), "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ paths: normalized }),
    }, 5000, "参考图清理请求未完成。");
  } catch {
    // The server also removes paths after generation; cleanup is best effort here.
  }
}

export async function uploadReferenceBlobs(entries, { headers = {}, onProgress } = {}) {
  const normalizedEntries = (Array.isArray(entries) ? entries : [entries]).map(normalizeEntry);
  const siteHeaders = referenceHeaders(headers);
  const signedPaths = [];
  try {
    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const original = normalizedEntries[index];
      const optimized = await optimizeReferenceBlob(original.blob, { preservePixels: original.preservePixels });
      const entry = optimized === original.blob ? original : {
        ...original, blob: optimized, contentType: optimized.type,
        filename: original.filename.replace(/\.[^.]*$/, "") + ".webp",
      };
      onProgress?.(index, normalizedEntries.length);
      const { response: urlResponse, payload: urlPayload } = await uploadRequest(`${API_BASE}/reference-upload-url`, {
        method: "POST",
        headers: { ...siteHeaders, "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ content_type: entry.contentType, size: entry.blob.size }),
      }, 30000, "未能取得参考图上传地址，请刷新页面后重试。");
      if (!urlResponse.ok || urlPayload?.error || !urlPayload?.signed_url || !urlPayload?.path) {
        throw responseError(urlPayload, "参考图上传地址获取失败", urlResponse);
      }

      signedPaths.push(urlPayload.path);
      await uploadSignedReference(urlPayload, entry, siteHeaders);
    }
    onProgress?.(normalizedEntries.length, normalizedEntries.length);
    return signedPaths;
  } catch (error) {
    // Even a lost response may have stored the in-flight object.
    await cleanupReferencePaths(signedPaths, headers);
    throw error;
  }
}

export function uploadReferenceFiles(files, options) {
  return uploadReferenceBlobs(files, options);
}
