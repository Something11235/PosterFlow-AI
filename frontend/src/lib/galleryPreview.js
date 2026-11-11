// A preview is a read of an existing result, never a generation intent.
// The shared blob reader can outlive a mounted card; ignore late results rather
// than cancelling another consumer's download, and release only our object URL.
export function createGalleryPreview({ filename, authenticated, headers, forceRefresh = false,
  loadUrl, loadBlob, onChange, createObjectURL = blob => URL.createObjectURL(blob),
  revokeObjectURL = url => URL.revokeObjectURL(url),
  directTimeoutMs = 15000, recoveryTimeoutMs = 90000,
  schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false, generation = 0, timer = null, phase = 'address', source = '', objectUrl = '';
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const emit = (state, url = '') => { source = url; if (!stopped) onChange({ state, url }); };
  const fail = () => {
    clearTimer(); generation += 1; phase = 'error'; emit('error');
    if (objectUrl) { revokeObjectURL(objectUrl); objectUrl = ''; }
  };
  const recover = async () => {
    if (stopped || !['address', 'direct'].includes(phase)) return;
    clearTimer(); phase = 'recovering'; const attempt = ++generation;
    emit('recovering');
    timer = schedule(fail, recoveryTimeoutMs);
    try {
      const blob = await loadBlob(filename, { authenticated, headers, variant: 'original', forceBackup: true, forceRefresh, directReadTimeoutMs: 8000 });
      if (stopped || attempt !== generation) return;
      clearTimer();
      objectUrl = createObjectURL(blob); phase = 'blob'; emit('loading', objectUrl);
      timer = schedule(fail, directTimeoutMs);
    } catch { if (!stopped && attempt === generation) fail(); }
  };
  const start = async () => {
    const attempt = ++generation;
    emit('loading');
    // Bound both URL lookup and the browser's subsequent image load. A stalled
    // cross-origin image must not leave a permanent blank card.
    timer = schedule(recover, directTimeoutMs);
    try {
      const url = await loadUrl(filename, { authenticated, headers, forceRefresh,
        variant: filename.toLowerCase().endsWith('.gif') ? 'original' : 'thumbnail' });
      if (stopped || attempt !== generation || phase !== 'address') return;
      clearTimer(); phase = 'direct'; emit('loading', url);
      timer = schedule(recover, directTimeoutMs);
    } catch { if (!stopped && attempt === generation) void recover(); }
  };
  void start();
  return {
    loaded(url) {
      if (stopped || !url || url !== source || !['direct', 'blob'].includes(phase)) return;
      clearTimer(); phase = 'ready'; emit('ready', url);
    },
    failed(url) {
      if (stopped || !url || url !== source) return;
      if (phase === 'direct') void recover();
      else if (phase === 'blob') fail();
    },
    dispose() {
      stopped = true; generation += 1; clearTimer();
      if (objectUrl) { revokeObjectURL(objectUrl); objectUrl = ''; }
    },
  };
}
