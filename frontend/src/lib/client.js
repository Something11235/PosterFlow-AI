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

export function apiAssetUrl(kind, filename) {
  const safeFilename = encodeURIComponent(filename);
  return `/api/${kind}/${safeFilename}?client_id=${encodeURIComponent(CLIENT_ID)}`;
}
