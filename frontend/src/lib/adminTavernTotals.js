// Scoped to one mounted admin panel and its current credentials. No storage.
export function createAdminTavernTotalsStore(fetchTotals) {
  let state = { data: null, busy: false, error: '' }, pending;
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const load = ({ force = false } = {}) => {
    if (pending) return pending;
    if (state.data && !force) return Promise.resolve(state.data);
    publish({ busy: true, error: '' });
    pending = Promise.resolve().then(fetchTotals).then(data => {
      publish({ data }); return data;
    }).catch(error => { publish({ error: error.message || '酒馆数据读取失败，请重试。' }); return null; })
      .finally(() => { pending = null; publish({ busy: false }); });
    return pending;
  };
  return { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, load };
}
