import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createAdminTavernTotalsStore } from './adminTavernTotals';
import { fetchAdminTavernTotals } from './tavernClient';

export function useAdminTavernTotals(open, authHeaders) {
  const store = useMemo(() => createAdminTavernTotalsStore(() => fetchAdminTavernTotals(authHeaders)), [authHeaders]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { if (open) void store.load({ force: true }); }, [open, store]);
  return { ...state, refresh: () => store.load({ force: true }) };
}
