import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download, LoaderCircle, ReceiptText, RefreshCw } from 'lucide-react';
import { fetchTavernRequest, fetchTavernRequests } from '../../lib/tavernClient';
import { displayCredits } from '../../lib/credits';
import { TavernDialog } from './TavernDialogs';
import './tavern-billing.css';

const billingLabels = { held: '积分已预留', settled: '已结算', refunded: '已退款', awaiting_review: '待核对' };
export function TavernBillingSummary({ billing }) {
  if (!billing) return null;
  const final = ['settled', 'refunded'].includes(billing.status);
  return <div className={`tv-billing-summary is-${billing.status}`}>
    <strong>{billingLabels[billing.status] || '账单状态待确认'}</strong>
    <span>预留 {displayCredits(billing.reserved_credits, '未返回')} 积分</span>
    <span>{final ? `实际扣费 ${displayCredits(billing.charged_credits, '待确认')} 积分` : '实际扣费待确认'}</span>
  </div>;
}

export function TavernBillingRecord({ request, children }) {
  const date = new Date(request.created_at);
  const usage = request.usage;
  return <article className="tv-billing-record">
    <div className="tv-billing-record-head"><strong>{request.kind === 'summary' ? '剧情摘要' : '角色对话'}</strong><span>{Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '时间未返回'}</span></div>
    <p className="tv-billing-model">{request.model || '模型未返回'}</p>
    <TavernBillingSummary billing={request.billing || request} />
    <details className="tv-billing-details"><summary>请求与用量明细</summary><dl><div><dt>请求编号</dt><dd>{request.request_id}</dd></div>{request.user_id && <div><dt>用户编号</dt><dd>{request.user_id}</dd></div>}{[['input_tokens', '输入 Token'], ['output_tokens', '输出 Token'], ['cache_read_tokens', '缓存读取（含在输入内）']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key].toLocaleString('zh-CN') : '未返回'}</dd></div>)}</dl>{request.error_code && <p>状态代码：{request.error_code}</p>}</details>
    {children}
  </article>;
}

function RecoveredContent({ request, onNotice }) {
  if (!request.content) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(request.content); onNotice('已复制恢复内容。'); }
    catch { onNotice('复制未成功，可以在下方选中文字复制。'); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([request.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `酒馆恢复-${request.request_id}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="tv-billing-recovery"><summary>查看可恢复{request.kind === 'summary' ? '摘要' : '回复'}</summary><p>内容仅供核对、复制或导出，不会自动加入当前对话或覆盖剧情摘要。</p><textarea readOnly value={request.content} rows={7} aria-label="可恢复内容" /><div className="tv-billing-actions"><button type="button" onClick={copy}><Copy size={15} />复制内容</button><button type="button" onClick={download}><Download size={15} />导出文字</button></div></details>;
}

export default function TavernBillingPanel({ authHeaders, onClose, onAccountRefresh, onReconcile, pendingRequestIds = [] }) {
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true), sequence = useRef(0), lock = useRef(false);
  const callbacks = useRef({ authHeaders, onAccountRefresh, onReconcile }); callbacks.current = { authHeaders, onAccountRefresh, onReconcile };
  const refreshBalance = () => Promise.resolve(callbacks.current.onAccountRefresh?.()).catch(() => {});
  async function load() {
    if (lock.current) return;
    lock.current = true; const turn = ++sequence.current; setBusy('list'); setError('');
    try {
      const data = await fetchTavernRequests(callbacks.current.authHeaders, { admin: false });
      if (alive.current && turn === sequence.current) setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch (reason) { if (alive.current && turn === sequence.current) setError(reason.message || '账单读取失败，请重试。'); }
    finally { lock.current = false; if (alive.current && turn === sequence.current) { setBusy(''); void refreshBalance(); } }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  async function verify(id) {
    if (lock.current) return;
    lock.current = true; setBusy(id); setError(''); setNotice('');
    try {
      const data = await fetchTavernRequest(id, callbacks.current.authHeaders);
      if (!alive.current) return;
      if (!data.request) throw new Error('未取得请求记录，请稍后再核对。');
      setRequests(previous => [data.request, ...previous.filter(item => item.request_id !== id)]);
      await callbacks.current.onReconcile?.(data.request);
      if (alive.current) setNotice('已核对服务端账单，没有重新发送模型请求。');
    } catch (reason) { if (alive.current) setError(reason.message || '核对失败，请稍后重试。'); }
    finally { lock.current = false; if (alive.current) { setBusy(''); void refreshBalance(); } }
  }
  const absentIds = pendingRequestIds.filter(id => !requests.some(item => item.request_id === id));
  return <TavernDialog title="平台账单" eyebrow="TAVERN BILLING" icon={ReceiptText} onClose={onClose} className="tv-billing-dialog">
    <div className="tv-dialog-body tv-billing-panel">
      <p className="tv-billing-note">这里只展示平台积分请求。提交先预留，结算后退回差额；待核对不代表扣费为 0。自带 API 不扣网站积分。</p>
      <p className="tv-billing-note">回复与摘要可在请求创建后 12 小时内尝试恢复；请及时复制或导出。核对只读取记录，不会重发请求。</p>
      <div className="tv-billing-toolbar"><span>最近平台请求</span><button type="button" onClick={load} disabled={Boolean(busy)}><RefreshCw size={15} className={busy === 'list' ? 'tv-spin' : ''} />刷新账单</button></div>
      {error && <p className="tv-form-error" role="alert">{error}</p>}{notice && <p className="tv-billing-notice" role="status">{notice}</p>}
      {busy === 'list' && <p className="tv-billing-note" role="status"><LoaderCircle size={16} className="tv-spin" />正在读取账单…</p>}
      {absentIds.length > 0 && <section className="tv-billing-unresolved" aria-label="本地待确认请求"><h3>本地还有待确认请求</h3>{absentIds.map(id => <div key={id}><code>{id}</code><button type="button" disabled={Boolean(busy)} onClick={() => verify(id)}>{busy === id ? '核对中…' : '核对请求'}</button></div>)}</section>}
      {!busy && !error && !requests.length && <p className="tv-billing-empty">暂时没有平台账单。</p>}
      <div className="tv-billing-records">{requests.map(request => <TavernBillingRecord key={request.request_id} request={request}><div className="tv-billing-actions"><button type="button" disabled={Boolean(busy)} onClick={() => verify(request.request_id)}><RefreshCw size={15} />{busy === request.request_id ? '核对中…' : '核对 / 恢复内容'}</button></div><RecoveredContent request={request} onNotice={setNotice} /></TavernBillingRecord>)}</div>
    </div>
  </TavernDialog>;
}
