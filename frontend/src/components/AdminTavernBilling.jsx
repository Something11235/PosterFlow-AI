import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchTavernRequests, resolveTavernRequest } from '../lib/tavernClient';
import { TavernBillingRecord } from './tavern/TavernBillingPanel';
import './tavern/tavern-billing.css';

const usageFields = [['input_tokens', '输入 Token'], ['output_tokens', '输出 Token'], ['total_tokens', '总 Token'], ['cache_read_tokens', '缓存读取 Token（含在输入内）']];

function ResolveForm({ request, onCancel, onResolved, authHeaders }) {
  const [action, setAction] = useState('refund');
  const [reason, setReason] = useState('');
  const [values, setValues] = useState(() => Object.fromEntries(usageFields.map(([key]) => [key, Number.isSafeInteger(request.usage?.[key]) ? String(request.usage[key]) : ''])));
  const [review, setReview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function prepare(event) {
    event.preventDefault(); setError('');
    if (reason.trim().length < 5 || reason.trim().length > 500) { setError('请填写 5–500 字的核对依据与处理原因。'); return; }
    let usage;
    if (action === 'settle') {
      usage = { status: 'confirmed', cache_miss_tokens: null, reasoning_tokens: null };
      for (const [key, label] of usageFields) {
        if (key === 'cache_read_tokens' && values[key] === '') { usage[key] = null; continue; }
        if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key]))) { setError(`${label}需填写服务商确认的非负整数，不能用 0 代替未知用量。`); return; }
        usage[key] = Number(values[key]);
      }
      if (!Number.isSafeInteger(usage.input_tokens + usage.output_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens) { setError('总 Token 必须等于输入与输出之和。'); return; }
      if (usage.cache_read_tokens > usage.input_tokens) { setError('缓存读取不能超过输入 Token。'); return; }
    }
    setReview({ user_id: request.user_id, action, reason: reason.trim(), ...(usage ? { usage } : {}) });
  }
  async function confirm() {
    if (lock.current || !review) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const data = await resolveTavernRequest(request.request_id, review, authHeaders);
      if (!data.request) throw new Error('未取得处理结果，请刷新列表核对，勿重复处理。');
      if (alive.current) await onResolved(data.request);
    } catch (failure) { if (alive.current) setError(failure.message || '处理结果待确认，请先刷新列表核对。'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <form className="tv-admin-billing-form" onSubmit={prepare}>
    {!review ? <><label>处理方式<select aria-label="处理方式" value={action} onChange={event => setAction(event.target.value)} disabled={busy}><option value="refund">退回预留积分</option><option value="settle">补录实际用量并结算</option></select></label>
      {action === 'settle' && <><p className="tv-billing-note">只填写已从服务商核实的实际用量。服务器按该请求的计费规则结算，实际扣费不能超过该笔预留；无法确认合理用量时请先核对，不要猜测。</p><div className="tv-admin-usage-fields">{usageFields.map(([key, label]) => <label key={key}>{label}<input inputMode="numeric" pattern="[0-9]+" required value={values[key]} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} disabled={busy} /></label>)}</div></>}
      <label>核对依据与处理原因<textarea required minLength={5} maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} placeholder="记录服务商核对结果及处理依据" /></label><div className="tv-billing-actions"><button type="button" onClick={onCancel} disabled={busy}>取消处理</button><button type="submit" disabled={busy || !request.user_id}>检查处理内容</button></div></> : <div className="tv-admin-billing-confirm"><p><strong>{review.action === 'refund' ? '确认退回该请求的预留积分？' : '确认按以下已核实用量结算？'}</strong></p><p>请求：{request.request_id}<br />用户：{request.user_id}</p>{review.usage && <dl>{usageFields.map(([key, label]) => <div key={key}>{label}：{review.usage[key].toLocaleString('zh-CN')}</div>)}</dl>}<p>原因：{review.reason}</p><p>此操作会变更账户积分并写入审计记录。</p><div className="tv-billing-actions"><button type="button" disabled={busy} onClick={() => setReview(null)}>返回修改</button><button type="button" disabled={busy} onClick={confirm}>{busy ? '正在提交…' : review.action === 'refund' ? '确认退款' : '确认结算'}</button></div></div>}
    {error && <p className="tv-form-error" role="alert">{error}</p>}
  </form>;
}

export default function AdminTavernBilling({ authHeaders, refreshKey, onResolved }) {
  const [requests, setRequests] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [editing, setEditing] = useState(null);
  const alive = useRef(true), seq = useRef(0);
  const callbacks = useRef({ authHeaders, onResolved }); callbacks.current = { authHeaders, onResolved };
  async function load() {
    const turn = ++seq.current; setBusy(true); setError('');
    try {
      const data = await fetchTavernRequests(callbacks.current.authHeaders, { admin: true });
      if (alive.current && turn === seq.current) setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch (failure) { if (alive.current && turn === seq.current) setError(failure.message || '待核对账单读取失败。'); }
    finally { if (alive.current && turn === seq.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [refreshKey]);
  async function resolved(request) {
    setRequests(previous => previous.filter(item => item.request_id !== request.request_id)); setEditing(null); setNotice('处理结果已保存，积分变动以服务端账单为准。');
    try { await callbacks.current.onResolved?.(request); } catch { /* The resolution already succeeded; refresh errors do not undo it. */ }
  }
  if (!busy && !error && !notice && !requests.length) return null;
  return <section className="tv-admin-billing" aria-label="酒馆平台待核对账单">
    <div className="tv-billing-toolbar"><h3><ShieldCheck size={16} aria-hidden="true" /> AI 酒馆 · 待核对账单</h3><button type="button" onClick={load} disabled={busy || Boolean(editing)}><RefreshCw size={15} className={busy ? 'tv-spin' : ''} />刷新酒馆账单</button></div>
    <p className="tv-billing-note">独立展示最近 50 条已预留或待核对的平台请求，不受上方用户与日期筛选影响。请先核实服务商记录，再退款或补录结算；不要重新发送对话。</p>
    {error && <p className="tv-form-error" role="alert">{error}</p>}{notice && <p className="tv-billing-notice" role="status">{notice}</p>}
    {busy && <p className="tv-billing-note" role="status">正在读取待核对请求…</p>}
    {!busy && !error && !requests.length && <p className="tv-billing-empty">暂无待核对的酒馆账单。</p>}
    <div className="tv-billing-records">{requests.map(request => <TavernBillingRecord key={request.request_id} request={request}>{editing === request.request_id ? <ResolveForm request={request} authHeaders={authHeaders} onCancel={() => setEditing(null)} onResolved={resolved} /> : ['held', 'awaiting_review'].includes(request.status) && <div className="tv-billing-actions"><button type="button" disabled={busy || Boolean(editing)} onClick={() => setEditing(request.request_id)}>核对并处理</button></div>}</TavernBillingRecord>)}</div>
  </section>;
}
