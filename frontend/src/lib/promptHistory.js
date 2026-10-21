export const GUEST_HISTORY_KEY = "posterflow.prompt-history.guest.v1";
export const HISTORY_WINDOW_MS = 7 * 86400000;
const MAX_STORAGE_CHARS = 1000000;
let memory = [];
let memoryOnly = false;

function storage() { try { return globalThis.localStorage; } catch { return undefined; } }

export function cleanPromptHistory(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries.filter(item => {
    if (!item || typeof item.id !== "string" || item.id.length > 100 || typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 6000) return false;
    const time = Date.parse(item.created_at);
    if (!Number.isFinite(time) || time <= now - HISTORY_WINDOW_MS || time > now || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  }).map(({ id, prompt, created_at }) => ({ id, prompt, created_at })).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id));
}

function persist(rows) {
  let text = JSON.stringify(rows);
  while (text.length > MAX_STORAGE_CHARS && rows.length) { rows.pop(); text = JSON.stringify(rows); }
  memory = rows;
  try { storage()?.setItem(GUEST_HISTORY_KEY, text); } catch { memoryOnly = true; }
  return rows;
}

export function readGuestPrompts(now = Date.now()) {
  let rows = memory;
  try {
    const text = memoryOnly ? null : storage()?.getItem(GUEST_HISTORY_KEY);
    if (text) rows = text.length <= MAX_STORAGE_CHARS ? JSON.parse(text) : [];
  } catch { /* Corrupt/unavailable storage is treated as empty or in-memory. */ }
  return persist(cleanPromptHistory(rows, now));
}

export function rememberGuestPrompt(prompt, id, now = Date.now()) {
  return persist(cleanPromptHistory([{ id, prompt, created_at: new Date(now).toISOString() }, ...readGuestPrompts(now)], now));
}
