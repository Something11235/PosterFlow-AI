import { browserStorage } from "./announcementVisibility.js";

export const POPUP_RECEIPT_PREFIX = "posterflow-popup-receipt:";
const memory = new Map();

function receiptKey(userId, announcementId) {
  return `${POPUP_RECEIPT_PREFIX}${userId || "guest"}:${announcementId}`;
}

function read(key) {
  try { return browserStorage("localStorage")?.getItem(key) ?? memory.get(key); }
  catch { return memory.get(key); }
}

function write(key, value) {
  memory.set(key, value);
  try { browserStorage("localStorage")?.setItem(key, value); }
  catch { /* The current page can still remember the choice. */ }
}

export function rememberPopupReceipt(userId, id) {
  if (userId) write(receiptKey(userId, id), "seen");
  write(receiptKey(null, id), userId ? "seen" : "guest-confirmed");
}

export function hasPopupReceipt(userId, id) {
  return Boolean(read(receiptKey(userId, id)));
}

// Carry a visitor's explicit click into their first account on this browser.
// Later accounts on a shared device use their own receipts.
export function claimGuestPopupReceipt(userId, id) {
  if (!userId || read(receiptKey(null, id)) !== "guest-confirmed") return false;
  rememberPopupReceipt(userId, id);
  return true;
}
