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

export function clearImageUrlCache() {
  imageUrls.clear();
  pendingImageUrls.clear();
}

export async function fetchImageUrl(filename, { authenticated = false, headers = {}, forceRefresh = false } = {}) {
  // Memory only; never persist URLs or credentials, and never share across users.
  const authorization = new Headers(headers).get("Authorization") || "";
  const cacheable = !authenticated || Boolean(authorization);
  const cacheKey = JSON.stringify([CLIENT_ID, authenticated, authorization, filename]);
  const cached = imageUrls.get(cacheKey);
  if (cacheable && !forceRefresh && cached?.expiresAt > Date.now()) return cached.url;
  if (cacheable && !forceRefresh && pendingImageUrls.has(cacheKey)) return pendingImageUrls.get(cacheKey);
  const safeFilename = encodeURIComponent(filename);
  const query = authenticated ? "" : `?client_id=${encodeURIComponent(CLIENT_ID)}`;
  const fallback = apiAssetUrl("images", filename, { authenticated });
  const pending = (async () => {
    try {
      const response = await fetch(`/api/images/${safeFilename}/url${query}`, {
        headers: { ...CLIENT_HEADERS, ...headers },
        credentials: "include",
      });
      const payload = await response.json();
      if (!response.ok || !payload?.url) throw new Error(payload?.error || "图片临时地址生成失败");
      const ttl = Math.max(0, (Number(payload.expires_in) || 0) - 60) * 1000;
      if (cacheable && ttl > 0 && payload.direct !== false) {
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = await fetchImageUrl(filename, { ...options, forceRefresh: attempt > 0 });
    const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
    const response = await fetch(url, sameOrigin
      ? { headers: { ...CLIENT_HEADERS, ...options.headers }, credentials: "include" }
      : { credentials: "omit", referrerPolicy: "no-referrer" });
    if (attempt === 0 && [401, 403].includes(response.status)) continue;
    if (!response.ok) throw new Error("图片请求失败：" + response.status);
    return response.blob();
  }
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
