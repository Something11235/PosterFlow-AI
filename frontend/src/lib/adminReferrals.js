import { referralApi } from './referrals.js';

export const ADMIN_REFERRAL_PAGE_SIZE = 20;
export const ADMIN_REFERRAL_SEARCH_LIMIT = 120;

export function adminReferralPath({ view = 'relations', search = '', page = 0 } = {}) {
  if (!['relations', 'rewards'].includes(view) || !Number.isSafeInteger(page) || page < 0 || page * ADMIN_REFERRAL_PAGE_SIZE > 1000000) throw new Error('邀请奖励查询参数无效。');
  const clean = String(search || '').trim();
  if (clean.length > ADMIN_REFERRAL_SEARCH_LIMIT) throw new Error(`搜索内容最多 ${ADMIN_REFERRAL_SEARCH_LIMIT} 个字符。`);
  return '/admin?' + new URLSearchParams({ view, search: clean, limit: String(ADMIN_REFERRAL_PAGE_SIZE), offset: String(page * ADMIN_REFERRAL_PAGE_SIZE) });
}

// Each mounted credential scope owns its filters, data and cancellation state.
// Editing a draft is local; only Query applies it to records. Totals stay global.
export function createAdminReferralStore(authHeaders, fetchPage = referralApi) {
  let state = { view: 'relations', draftSearch: '', search: '', page: 0, data: null, loading: true, error: '' };
  let controller, generation = 0, active = false;
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const load = async () => {
    if (!active) return null;
    controller?.abort();
    const request = new AbortController(); controller = request;
    const version = ++generation;
    publish({ loading: true, error: '' });
    try {
      const data = await fetchPage(adminReferralPath(state), { authHeaders, signal: request.signal });
      if (!active || request.signal.aborted || version !== generation) return null;
      publish({ data }); return data;
    } catch (error) {
      if (active && !request.signal.aborted && version === generation) publish({ error: error?.message || '邀请奖励数据暂未加载，请刷新重试。' });
      return null;
    } finally {
      if (active && !request.signal.aborted && version === generation) publish({ loading: false });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: () => { active = true; return load(); },
    dispose: () => { active = false; generation += 1; controller?.abort(); },
    setDraft: draftSearch => publish({ draftSearch }),
    query: () => { publish({ search: state.draftSearch.trim(), page: 0 }); return load(); },
    setView: view => { if (!['relations', 'rewards'].includes(view) || view === state.view) return; publish({ view, page: 0 }); return load(); },
    setPage: page => { if (!Number.isSafeInteger(page) || page < 0 || state.loading) return; publish({ page }); return load(); },
    refresh: load,
  };
}

export function referralMember(record, side) {
  const id = record?.[`${side}_id`] || '';
  const email = record?.[`${side}_email`] || '';
  return { id, email, name: record?.[`${side}_name`] || (email ? '未设置昵称' : id ? '已注销用户' : '未知用户') };
}

export function referralRecordStatus(status) {
  return status === 'rewarded' ? '已发放' : status === 'not_issued' ? '未发放' : '待确认';
}

export function referralBeijingTime(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
