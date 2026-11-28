import { CLIENT_HEADERS } from "./client.js";
import { optimizeReferenceBlob } from "./referenceCompression.js";
import { MAX_REFERENCE_FILE_BYTES, prepareReferenceImage, REFERENCE_UPLOAD_TYPES } from "./referenceImage.js";
import { imageTransportDiagnostic, referenceNetworkInterrupted, referenceNetworkRetryHint } from "./imageGenerationError.js";
import { referenceDigest } from "./referenceDigest.js";

const API_BASE = "/api";
const SUPPORTED_TYPES = new Set(REFERENCE_UPLOAD_TYPES);
// Leave headroom for multipart headers within the site's function body limit.
const RELAY_PART_BYTES = 4 * 1024 * 1024;
const RELAY_URL = `${API_BASE}/reference-upload-fallback`;

function responseError(payload, fallback, response) {
  const error = new Error(fallback);
  error.code = "REFERENCE_UPLOAD_FAILED";
  error.detail = fallback;
  if (typeof payload?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(payload.code)) {
    error.code = payload.code;
    if (typeof payload.detail === "string" && payload.detail) error.detail = payload.detail;
    else if (typeof payload.error === "string" && payload.error) error.detail = payload.error;
    if (["REFERENCE_UPLOAD_FAILED", "REFERENCE_UPLOAD_UNAVAILABLE", "REFERENCE_LINK_UNAVAILABLE", "STORAGE_UNAVAILABLE", "AUTH_VERIFY_UNAVAILABLE"].includes(error.code)) {
      error.diagnostic = imageTransportDiagnostic(null, response.status);
    }
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

function retryableStatus(status) {
  return status === 408 || status >= 500;
}

async function postRelayPart(url, headers, body, timeoutMs, detail, onRetry) {
  const send = () => uploadRequest(url, { method: "POST", credentials: "same-origin", headers, body }, timeoutMs, detail);
  // Both writing a numbered part and completing its signed upload are idempotent.
  // Retry that operation once if no definitive acknowledgement arrived.
  let result;
  try {
    result = await send();
  } catch (error) {
    if (error.phase !== "reference_upload") throw error;
  }
  if (result && !retryableStatus(result.response.status)) return result;
  onRetry?.();
  return send();
}

async function uploadReferenceParts(signed, token, blob, headers, sha256, report) {
  const detail = "网站备用线路未完成参考图上传，请稍后重试。";
  const ticket = { path: signed.path, token, relay_ticket: signed.relay_ticket };
  const partCount = Math.ceil(blob.size / RELAY_PART_BYTES);
  for (let index = 0; index < partCount; index++) {
    const start = index * RELAY_PART_BYTES;
    const bytes = blob.slice(start, start + RELAY_PART_BYTES, "application/octet-stream");
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket)) form.append(name, value);
    form.append("part_index", String(index));
    form.append("file", bytes, "part.bin");
    // Only an acknowledged part counts, including when the same part is retried.
    const progress = { part: index + 1, parts: partCount, loadedBytes: start, fraction: start / blob.size };
    report("chunk", `正在上传分块 ${index + 1}/${partCount}`, progress);
    const { response, payload } = await postRelayPart(RELAY_URL, headers, form, 90000, detail,
      () => report("chunk", `正在重试分块 ${index + 1}/${partCount}`, progress));
    if (!response.ok || payload?.success !== true || payload.path !== signed.path || payload.part_index !== index) {
      throw responseError(payload, detail, response);
    }
  }
  const confirm = () => report("confirming", "正在合并并校验分块", { loadedBytes: blob.size });
  confirm();
  const { response, payload } = await postRelayPart(`${RELAY_URL}/complete`,
    { ...headers, "Content-Type": "application/json" }, JSON.stringify({ ...ticket, sha256 }), 150000, detail, confirm);
  if (!response.ok || payload?.success !== true || payload.path !== signed.path) {
    throw responseError(payload, detail, response);
  }
}

async function uploadSignedReference(signed, entry, headers, report) {
  const directForm = new FormData();
  directForm.append("cacheControl", "3600");
  directForm.append("", entry.blob, entry.filename);
  const partCount = Math.max(1, Math.ceil(entry.blob.size / RELAY_PART_BYTES));
  let directResponse;
  let directFailure;
  report("direct", "正在直传参考图");
  try {
    const direct = await uploadRequest(signed.signed_url, {
      method: "PUT", headers: { "x-upsert": "false" }, credentials: "omit", body: directForm,
    }, partCount * 30000, "浏览器未收到参考图直传结果。");
    directResponse = direct.response;
  } catch (error) {
    directFailure = error;
  }
  if (directResponse?.ok) return;
  if (directResponse) {
    directFailure = responseError(null, "参考图直传未成功。", directResponse);
    if (!retryableStatus(directResponse.status)) throw directFailure;
  }
  // Reuse the original signed path. Only the website gets session credentials.
  let token = signed.token;
  if (!token) {
    try { token = new URL(signed.signed_url).searchParams.get("token"); } catch { /* Malformed or expired ticket. */ }
  }
  if (!token || (partCount > 1 && !signed.relay_ticket)) {
    directFailure.detail = "参考图直传未完成，上传凭证缺失。请刷新页面后重试。";
    throw directFailure;
  }
  if (partCount > 1) {
    report("hashing", "正在校验参考图，准备分块上传");
    let sha256;
    try {
      sha256 = await referenceDigest(entry.blob, loadedBytes => {
        report("hashing", "正在校验参考图，准备分块上传", { loadedBytes, fraction: loadedBytes / entry.blob.size });
      });
    } catch (error) {
      error.directConnectionInterrupted = referenceNetworkInterrupted(directFailure?.diagnostic);
      throw error;
    }
    try {
      return await uploadReferenceParts(signed, token, entry.blob, headers, sha256, report);
    } catch (error) {
      error.relayPath = signed.path;
      throw error;
    }
  }
  const form = new FormData();
  form.append("path", signed.path);
  form.append("token", token);
  form.append("file", entry.blob, entry.filename);
  report("relay", "正在通过备用线路上传");
  const { response, payload } = await uploadRequest(RELAY_URL, {
    method: "POST", credentials: "same-origin", headers, body: form,
  }, 90000, "网站备用上传未能确认结果，请稍后重新上传参考图。");
  if (!response.ok || payload?.success !== true || payload?.path !== signed.path) {
    throw responseError(payload, "网站备用上传未完成，请稍后重新上传参考图。", response);
  }
}

async function normalizeEntry(entry, index) {
  let blob = entry?.blob || entry;
  if (!(blob instanceof Blob)) throw Object.assign(new Error("参考图内容无法读取"), {code:"REFERENCE_IMAGE_INVALID"});
  let name = entry?.name || blob.name;
  if (!SUPPORTED_TYPES.has(blob.type)) {
    blob = await prepareReferenceImage(blob, { name });
    name = blob.name;
  }
  const contentType = String(blob.type || "").toLowerCase();
  if (blob.size > MAX_REFERENCE_FILE_BYTES) throw Object.assign(new Error("参考图不能超过 16 MB"), {code:"REFERENCE_IMAGE_TOO_LARGE"});
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
  const filename = name || `reference-${index + 1}.${extension}`;
  return { blob, contentType, filename, preservePixels: Boolean(entry?.preservePixels) };
}

export async function cleanupReferencePaths(paths, headers = {}, relayPaths = []) {
  const normalized = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!normalized.length) return;
  try {
    await uploadRequest(`${API_BASE}/reference-cleanup`, {
      method: "POST",
      headers: { ...referenceHeaders(headers), "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ paths: normalized, ...(relayPaths.length ? { relay_paths: relayPaths } : {}) }),
    }, 5000, "参考图清理请求未完成。");
  } catch {
    // The server also removes paths after generation; cleanup is best effort here.
  }
}

export async function uploadReferenceBlobs(entries, { headers = {}, onProgress, onUploadProgress } = {}) {
  const files = Array.isArray(entries) ? entries : [entries];
  const total = files.length;
  function notify(current, filename, totalBytes, stage, label, data) {
    if (!onUploadProgress) return;
    try {
      onUploadProgress({ current, total, stage, label, filename, loadedBytes: 0, totalBytes, fraction: null, ...data });
    } catch { /* A UI observer cannot change an upload or trigger a retry. */ }
  }
  const normalizedEntries = [];
  for (const [index, file] of files.entries()) {
    notify(index + 1, file?.name || file?.blob?.name || "", (file?.blob || file)?.size || 0, "validating", "正在检查参考图");
    normalizedEntries.push(await normalizeEntry(file, index));
  }
  const siteHeaders = referenceHeaders(headers);
  const signedPaths = [];
  try {
    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const original = normalizedEntries[index];
      notify(index + 1, original.filename, original.blob.size, "preparing", "正在准备参考图");
      const optimized = await optimizeReferenceBlob(original.blob, { preservePixels: original.preservePixels });
      const entry = optimized === original.blob ? original : {
        ...original, blob: optimized, contentType: optimized.type,
        filename: original.filename.replace(/\.[^.]*$/, "") + ".webp",
      };
      onProgress?.(index, normalizedEntries.length);
      const report = (stage, label, data) => notify(index + 1, original.filename, entry.blob.size, stage, label, data);
      report("signing", "正在获取上传地址");
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
      await uploadSignedReference(urlPayload, entry, siteHeaders, report);
      const receipt = { loadedBytes: entry.blob.size, fraction: 1 };
      report("file-complete", "参考图上传完成", receipt);
      if (index === total - 1) report("complete", "参考图已全部上传", receipt);
    }
    onProgress?.(normalizedEntries.length, normalizedEntries.length);
    return signedPaths;
  } catch (error) {
    // Even a lost response may have stored the in-flight object.
    await cleanupReferencePaths(signedPaths, headers, error.relayPath ? [error.relayPath] : []);
    if (referenceNetworkInterrupted(error.diagnostic) || error.directConnectionInterrupted) {
      const direct = error.directConnectionInterrupted ? "参考图直传也未成功。" : "";
      error.detail = [error.detail || error.message, direct + referenceNetworkRetryHint].filter(Boolean).join(" ");
      error.message = error.detail;
    }
    throw error;
  }
}

export function uploadReferenceFiles(files, options) {
  return uploadReferenceBlobs(files, options);
}
