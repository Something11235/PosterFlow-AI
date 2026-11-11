import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchAdminTavernTotals } from '../lib/tavernClient';
import { displayCredits } from '../lib/credits';

const count = value => value === null || value === undefined ? '未返回' : /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('zh-CN') : '—';
export default function AdminTavernOverview({ authHeaders, refreshKey }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const seq = useRef(0), alive = useRef(true), headers = useRef(authHeaders); headers.current = authHeaders;
  const load = useCallback(async () => {
    const turn = ++seq.current; setBusy(true); setError('');
    try { const value = await fetchAdminTavernTotals(headers.current); if (alive.current && turn === seq.current) setData(value); }
    catch (failure) { if (alive.current && turn === seq.current) { setData(null); setError(failure.message); } }
    finally { if (alive.current && turn === seq.current) setBusy(false); }
  }, []);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load, refreshKey, authHeaders]);
  const stats = data?.stats;
  return <div aria-label="AI 酒馆运营">
    <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-6 text-text-muted">累计全部历史平台调用，不受日期与用户筛选影响。消耗积分仅计实际扣分，自带 API 调用不计入。</p><button type="button" onClick={load} disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-subtle px-3 text-xs text-text-secondary hover:bg-bg-elevated disabled:opacity-50"><RefreshCw size={15} className={busy?'animate-spin':''} />刷新酒馆数据</button></div>
    {error && <p className="mt-3 text-xs text-gold" role="alert">{error}</p>}{busy && <p role="status" className="mt-3 text-xs text-text-muted">正在读取酒馆累计数据…</p>}
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{[['requests','总调用'],['users','使用用户'],['chat','角色对话'],['summary','剧情摘要'],['assist','AI助写'],['credits_spent','消耗积分']].map(([key,label]) => <div key={key} className="rounded-md border border-border-subtle bg-bg-primary/60 p-3"><dt className="text-xs text-text-muted">{label}</dt><dd className="mt-2 text-xl font-semibold tabular-nums text-text-primary">{busy || !stats?'—':key==='credits_spent'?displayCredits(stats[key],'—'):count(stats[key])}</dd></div>)}</dl>
  </div>;
}
