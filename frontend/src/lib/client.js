const CLIENT_STORAGE_KEY = "posterflow.client.v1";

function createClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function getClientId() {
  try {
    const stored = window.localStorage.getItem(CLIENT_STORAGE_KEY);
    if (stored) return stored;
    const created = createClientId();
    window.localStorage.setItem(CLIENT_STORAGE_KEY, created);
    return created;
  } catch {
    return createClientId();
  }
}

export const CLIENT_ID = getClientId();
export const CLIENT_HEADERS = Object.freeze({ "X-Client-Id": CLIENT_ID });

export function apiAssetUrl(kind, filename, { authenticated = false } = {}) {
  const safeFilename = encodeURIComponent(filename);
  return authenticated ? `/api/${kind}/${safeFilename}` : `/api/${kind}/${safeFilename}?client_id=${encodeURIComponent(CLIENT_ID)}`;
}

const imageUrls = new Map();
const pendingImageUrls = new Map();
const MAX_IMAGE_URLS = 256;
const imageBlobs = new Map();
const pendingImageBlobs = new Map();
export const MAX_IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
export const IMAGE_URL_TIMEOUT_MS = 15 * 1000;
export const IMAGE_READ_TIMEOUT_MS = 45 * 1000;
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
let imageCacheBytes = 0;
let cacheEpoch = 0;

function withImageTimeout(read, timeoutMs, message) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = "IMAGE_READ_TIMEOUT";
      // Reject even if a browser/transport does not settle after aborting.
      reject(error);
      controller.abort();
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline])
    .finally(() => clearTimeout(timer));
}

function imageCacheIdentity(filename, { authenticated = false, headers = {}, variant = "original" } = {}) {
  const authorization = new Headers(headers).get("Authorization") || "";
  return {
    cacheable: !authenticated || Boolean(authorization),
    key: JSON.stringify([CLIENT_ID, authenticated, authorization, filename, variant]),
  };
}

export function clearImageUrlCache() {
  cacheEpoch += 1;
  imageUrls.clear();
  pendingImageUrls.clear();
  imageBlobs.clear();
  pendingImageBlobs.clear();
  imageCacheBytes = 0;
}

export async function fetchImageUrl(filename, { authenticated = false, headers = {}, forceRefresh = false, variant = "original" } = {}) {
  // Memory only; never persist URLs or credentials, and never share across users.
  const { key: cacheKey, cacheable } = imageCacheIdentity(filename, { authenticated, headers, variant });
  const epoch = cacheEpoch;
  const cached = imageUrls.get(cacheKey);
  if (cacheable && !forceRefresh && cached?.expiresAt > Date.now()) return cached.url;
  if (cacheable && !forceRefresh && pendingImageUrls.has(cacheKey)) return pendingImageUrls.get(cacheKey);
  if (forceRefresh) imageUrls.delete(cacheKey);
  const safeFilename = encodeURIComponent(filename);
  const params = new URLSearchParams();
  if (!authenticated) params.set("client_id", CLIENT_ID);
  if (variant !== "original") params.set("variant", variant);
  const query = params.size ? `?${params}` : "";
  const fallback = apiAssetUrl("images", filename, { authenticated });
  const pending = (async () => {
    try {
      const payload = await withImageTimeout(async (signal) => {
        const response = await fetch(`/api/images/${safeFilename}/url${query}`, {
          headers: { ...CLIENT_HEADERS, ...headers },
          credentials: "include",
          signal,
        });
        const data = await response.json();
        if (!response.ok || !data?.url) throw new Error("图片临时地址生成失败");
        return data;
      }, IMAGE_URL_TIMEOUT_MS, "图片地址获取超时，请重试。");
      const ttl = Math.max(0, (Number(payload.expires_in) || 0) - 60) * 1000;
      if (cacheable && epoch === cacheEpoch && ttl > 0 && payload.direct !== false) {
        if (imageUrls.size >= MAX_IMAGE_URLS) imageUrls.delete(imageUrls.keys().next().value);
        imageUrls.set(cacheKey, { url: payload.url, expiresAt: Date.now() + ttl });
      }
      return payload.url;
    } catch {
      // The fallback also redirects to Storage; it never proxies remote bytes.
      return fallback;
    }
  })();
  if (cacheable) pendingImageUrls.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (pendingImageUrls.get(cacheKey) === pending) pendingImageUrls.delete(cacheKey);
  }
}

export function imageDownloadUrl(url, filename) {
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin) target.searchParams.set("download", filename);
  return target.href;
}

export async function fetchImageBlob(filename, options = {}) {
  const { key, cacheable } = imageCacheIdentity(filename, options);
  const epoch = cacheEpoch;
  const cached = imageBlobs.get(key);
  if (cacheable && !options.forceRefresh && cached?.expiresAt > Date.now()) {
    imageBlobs.delete(key);
    imageBlobs.set(key, cached);
    return cached.blob;
  }
  if (cacheable && !options.forceRefresh && pendingImageBlobs.has(key)) return pendingImageBlobs.get(key);
  if (cached && options.forceRefresh) {
    imageBlobs.delete(key);
    imageCacheBytes -= cached.blob.size;
  }
  const pending = (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const url = await fetchImageUrl(filename, { ...options, forceRefresh: Boolean(options.forceRefresh) || attempt > 0 });
      const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
      const blob = await withImageTimeout(async (signal) => {
        let response;
        try {
          response = await fetch(url, { ...(sameOrigin
            ? { headers: { ...CLIENT_HEADERS, ...options.headers }, credentials: "include" }
            : { credentials: "omit", referrerPolicy: "no-referrer" }), signal });
        } catch {
          throw new Error("图片读取失败，请检查网络连接后重试。");
        }
        if (attempt === 0 && [401, 403].includes(response.status)) return null;
        if (response.status === 404) throw new Error("图片不存在或已过期（404），请选择其他图片。");
        if (!response.ok) throw new Error("图片请求失败：" + response.status);
        const contentType = response.headers?.get("Content-Type") || "";
        if (/^(application\/json|text\/html)/i.test(contentType)) throw new Error("图片服务没有返回有效图片");
        let content;
        try {
          content = await response.blob();
        } catch {
          throw new Error("图片读取失败，请检查网络连接后重试。");
        }
        if (!content.size) throw new Error("图片内容为空，请重新加载。");
        return content;
      }, IMAGE_READ_TIMEOUT_MS, "原图读取超时，请检查网络连接后重试。");
      if (!blob) continue;
      if (cacheable && epoch === cacheEpoch && blob.size <= MAX_IMAGE_CACHE_BYTES) {
        for (const [entryKey, entry] of imageBlobs) {
          if (entryKey === key || entry.expiresAt <= Date.now()) {
            imageBlobs.delete(entryKey);
            imageCacheBytes -= entry.blob.size;
          }
        }
        while (imageBlobs.size && (imageCacheBytes + blob.size > MAX_IMAGE_CACHE_BYTES || imageBlobs.size >= 32)) {
          const firstKey = imageBlobs.keys().next().value;
          imageCacheBytes -= imageBlobs.get(firstKey).blob.size;
          imageBlobs.delete(firstKey);
        }
        imageBlobs.set(key, { blob, expiresAt: Date.now() + IMAGE_CACHE_TTL_MS });
        imageCacheBytes += blob.size;
      }
      return blob;
    }
  })();
  if (cacheable) pendingImageBlobs.set(key, pending);
  try {
    return await pending;
  } finally {
    if (pendingImageBlobs.get(key) === pending) pendingImageBlobs.delete(key);
  }
}

export async function downloadImage(filename, options = {}) {
  const blob = await fetchImageBlob(filename, options);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function recoverGeneration(requestId, { attempts = 10, intervalMs = 2000, headers = {} } = {}) {
  if (!requestId) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`/api/generations/${encodeURIComponent(requestId)}`, {
        headers: { ...CLIENT_HEADERS, ...headers },
        credentials: "include",
      });
      if (response.status === 404) return null;
      const payload = await response.json();
      if (!response.ok) return null;
      if (payload?.status === "succeeded" && payload.images?.length) return payload;
      if (["failed", "refunded"].includes(payload?.status)) return null;
    } catch {
      // A transient status request failure should not hide the original error.
    }
    if (attempt < attempts - 1) await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
  return null;
}
