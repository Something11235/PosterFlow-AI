import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchAdminTavernOverview } from '../lib/tavernClient';
import { displayCredits } from '../lib/credits';
import { TavernBillingRecord } from './tavern/TavernBillingPanel';
import './tavern/tavern-usage.css';

const count = value => value === null || value === undefined ? '未返回' : /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('zh-CN') : '—';
export default function AdminTavernOverview({ authHeaders, refreshKey }) {
  const [days, setDays] = useState(30), [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const seq = useRef(0), alive = useRef(true), headers = useRef(authHeaders); headers.current = authHeaders;
  const load = useCallback(async () => {
    const turn = ++seq.current; setBusy(true); setError('');
    try { const value = await fetchAdminTavernOverview(headers.current, days); if (alive.current && turn === seq.current) setData(value); }
    catch (failure) { if (alive.current && turn === seq.current) { setData(null); setError(failure.message); } }
    finally { if (alive.current && turn === seq.current) setBusy(false); }
  }, [days]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load, refreshKey]);
  const stats = data?.stats;
  return <section className="tv-admin-billing" aria-label="AI 酒馆运营">
    <div className="tv-billing-toolbar"><h3>AI 酒馆 · 运营总览</h3><label>统计时间 <select aria-label="酒馆统计时间" value={days} onChange={event => setDays(Number(event.target.value))}>{[7,30,90].map(value => <option key={value} value={value}>近{value}天</option>)}</select></label><button type="button" onClick={load} disabled={busy}><RefreshCw size={15} />刷新运营数据</button></div>
    <p className="tv-billing-note">按北京时间统计平台积分调用，包含聊天、剧情摘要和AI助写；自带API调用只保存在用户浏览器。积分消耗不等于充值收入，预留不计为实扣。不展示聊天正文。</p>
    {error && <p className="tv-form-error" role="alert">{error}</p>}{busy && <p role="status">正在读取酒馆运营数据…</p>}
    {!busy && stats && <><dl className="tavern-usage-totals">{[['requests','总调用'],['users','使用用户'],['chat','角色对话'],['summary','剧情摘要'],['assist','AI助写'],['settled','已结算'],['refunded','已退款'],['unresolved','未结算'],['input_tokens','输入Token'],['output_tokens','输出Token'],['cache_read_tokens','已返回的缓存Token'],['missing_cache_calls','未返回缓存明细']].map(([key,label]) => <div key={key}><dt>{label}</dt><dd>{count(stats[key])}</dd></div>)}<div><dt>实际消耗积分</dt><dd>{displayCredits(stats.credits_spent, '未返回')}</dd></div><div><dt>未结算预留积分</dt><dd>{displayCredits(stats.credits_held, '未返回')}</dd></div></dl><details><summary>查看本时段最近50条平台请求</summary><div className="tv-billing-records">{data.requests.map(request => <TavernBillingRecord key={`${request.user_id}-${request.request_id}`} request={request} />)}{!data.requests.length && <p>该时段暂无调用。</p>}</div></details></>}
  </section>;
}
