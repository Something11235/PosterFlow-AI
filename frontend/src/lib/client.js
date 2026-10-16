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

export async function fetchImageUrl(filename, { authenticated = false, headers = {} } = {}) {
  const safeFilename = encodeURIComponent(filename);
  const query = authenticated ? "" : `?client_id=${encodeURIComponent(CLIENT_ID)}`;
  const fallback = apiAssetUrl("images", filename, { authenticated });
  try {
    const response = await fetch(`/api/images/${safeFilename}/url${query}`, {
      headers: { ...CLIENT_HEADERS, ...headers },
      credentials: "include",
    });
    const payload = await response.json();
    if (!response.ok || !payload?.url) throw new Error(payload?.error || "图片临时地址生成失败");
    return payload.url;
  } catch {
    // Keep local development and a temporarily unavailable signing endpoint usable.
    return fallback;
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
