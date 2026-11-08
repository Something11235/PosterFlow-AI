import {useEffect, useSyncExternalStore} from 'react';
import {MODEL_BADGE_OPTIONS} from './modelBadgeCatalog.js';

export const BADGE_LABELS = {'': '无', new: '新', hot: '热'};
export const DEFAULT_MODEL_BADGES = Object.fromEntries(MODEL_BADGE_OPTIONS.map(model => [model.value, model.value.startsWith('gpt-image-2.6-') ? 'hot' : model.value.startsWith('seedream-') ? 'new' : '']));
let snapshot = {revision: 0, badges: DEFAULT_MODEL_BADGES};
let pending = null, timer = null, lastRead = 0;
const listeners = new Set();

export function parseModelBadges(data) {
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || !data.badges || typeof data.badges !== 'object' || Array.isArray(data.badges)) throw new Error('模型角标数据无效。');
  const badges = {};
  for (const model of MODEL_BADGE_OPTIONS) {
    const value = Object.hasOwn(data.badges, model.value) ? data.badges[model.value] : DEFAULT_MODEL_BADGES[model.value];
    if (typeof value !== 'string' || !Object.hasOwn(BADGE_LABELS, value)) throw new Error('模型角标数据无效。');
    badges[model.value] = value;
  }
  return {revision: data.revision, badges};
}

export function publishModelBadges(data) {
  const next = parseModelBadges(data);
  // A public read started before an administrator's save may finish afterward.
  if (next.revision < snapshot.revision) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export async function refreshModelBadges() {
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch('/api/model-badges', {credentials: 'omit', cache: 'no-store'});
    if (!response.ok) throw new Error('模型角标暂时无法读取。');
    publishModelBadges(await response.json());
    lastRead = Date.now();
  })().finally(() => { pending = null; });
  return pending;
}

function check() {
  if (Date.now() - lastRead > 30000 && document.visibilityState !== 'hidden') void refreshModelBadges().catch(() => {});
}
function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    check();
    timer = setInterval(check, 30000);
    window.addEventListener('focus', check);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = null; window.removeEventListener('focus', check); }
  };
}
const getSnapshot = () => snapshot;
export function useModelBadges() {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(check, []);
  return value;
}
