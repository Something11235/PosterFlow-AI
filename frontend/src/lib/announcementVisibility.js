export const HIDDEN_KEY = "posterflow-announcement-hidden-versions-v1";
export const CLOSED_KEY = "posterflow-announcement-closed-versions-v1";

export function browserStorage(kind) {
  try { return globalThis[kind]; } catch { return undefined; }
}

export function announcementVersion(item) {
  // Match the actual published version, never a global dismiss-all boolean.
  return JSON.stringify([item.id, item.updated_at || item.published_at || item.created_at || "",
    item.title, item.content, item.starts_at || "", item.ends_at || "", Boolean(item.is_pinned)]);
}

export function readVersions(storage, key) {
  try {
    const data = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(data) ? data.filter(v => typeof v === "string" && v.length <= 18000).slice(-100) : [];
  } catch { return []; }
}

export function rememberVersions(storage, key, current, versions) {
  const next = [...new Set([...current, ...versions])].slice(-100);
  try { storage.setItem(key, JSON.stringify(next)); } catch { /* Still works in memory when browser storage is unavailable. */ }
  return next;
}
