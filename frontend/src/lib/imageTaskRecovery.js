export const IMAGE_RECOVERY_INTERVAL_MS = 15000;
export const IMAGE_RECOVERY_WINDOW_MS = 20 * 60 * 1000;

export function isPendingImageTaskError(error) {
  if (error?.refunded === true) return false;
  return ['IMAGE_TASK_PENDING','IMAGE_SAVE_PENDING','REQUEST_ALREADY_PROCESSED'].includes(error?.code)
    || Boolean(error?.submission_unknown);
}

export function canAutoQueryImageTask(task, now = Date.now()) {
  return Boolean(task && ["apimart", "buytoken"].includes(task.route) && task.billingMode === "platform"
    && (task.route !== 'buytoken' || task.error?.recovery_confirmed === true)
    && task.status === "pending" && !task.active && ["IMAGE_TASK_PENDING", "IMAGE_SAVE_PENDING"].includes(task.error?.code)
    && Number.isSafeInteger(task.createdAt) && task.createdAt <= now
    && now - task.createdAt < IMAGE_RECOVERY_WINDOW_MS);
}

// This only schedules the caller's existing GET query. Each instance has one
// pending request; the caller also shares its lock with manual task queries.
export function startImageTaskRecovery({ readTask, query, visibility = document,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, busy = false, stopped = false;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const eligible = () => !stopped && visibility.visibilityState === "visible" && canAutoQueryImageTask(readTask(), now());
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
  arm();
  return () => { stopped = true; clear(); visibility.removeEventListener("visibilitychange", arm); };
}
