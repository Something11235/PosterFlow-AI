export const IMAGE_RECOVERY_INTERVAL_MS = 15000;
export const IMAGE_RECOVERY_WINDOW_MS = 20 * 60 * 1000;
const AUTO_QUERY_CODES = new Set(['IMAGE_TASK_PENDING','IMAGE_SAVE_PENDING','IMAGE_SUBMISSION_UNKNOWN',
  'IMAGE_TASK_QUERY_FAILED','IMAGE_DATABASE_UNAVAILABLE','IMAGE_TASK_UNAVAILABLE','IMAGE_REFUND_PENDING','BACKEND_OFFLINE']);

export function isPendingImageTaskError(error) {
  if (error?.refunded === true) return false;
  return ['IMAGE_TASK_PENDING','IMAGE_SAVE_PENDING','REQUEST_ALREADY_PROCESSED'].includes(error?.code)
    || Boolean(error?.submission_unknown);
}

export function canAutoQueryImageTask(task, now = Date.now()) {
  return Boolean(task && ["apimart", "buytoken"].includes(task.route) && task.billingMode === "platform"
    && task.status === "pending" && !task.active && !task.error?.refunded && AUTO_QUERY_CODES.has(task.error?.code)
    && Number.isSafeInteger(task.createdAt) && task.createdAt <= now
    && now - task.createdAt < IMAGE_RECOVERY_WINDOW_MS);
}

// This only schedules the caller's existing GET query. Each instance has one
// pending request; the caller also shares its lock with manual task queries.
export function startImageTaskRecovery({ readTask, query, visibility = document,
  connectivity = globalThis.window, isOnline = () => globalThis.navigator?.onLine !== false,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, busy = false, stopped = false;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const eligible = () => !stopped && isOnline() && visibility.visibilityState === "visible" && canAutoQueryImageTask(readTask(), now());
  const arm = () => {
    clear();
    if (!busy && eligible()) timer = schedule(tick, IMAGE_RECOVERY_INTERVAL_MS);
  };
  async function tick() {
    timer = null;
    if (busy || !eligible()) return;
    busy = true;
    try { await query(readTask()); } catch { /* Manual recovery remains available. */ }
    finally { busy = false; arm(); }
  }
  visibility.addEventListener("visibilitychange", arm);
  connectivity?.addEventListener('online', arm);
  connectivity?.addEventListener('offline', arm);
  arm();
  return () => { stopped = true; clear(); visibility.removeEventListener("visibilitychange", arm);
    connectivity?.removeEventListener('online', arm); connectivity?.removeEventListener('offline', arm); };
}
