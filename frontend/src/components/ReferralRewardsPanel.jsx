import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Copy, Gift, Link2, Loader2, RefreshCw, Users, X } from 'lucide-react';
import { displayCredits } from '../lib/credits';
import { copyInvitationText, invitationLink, referralApi } from '../lib/referrals';

const PAGE_SIZE = 20;
const secondaryButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-default px-3 text-sm text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

export default function ReferralRewardsPanel({ session, authHeaders, onClose, onLogin }) {
  const identity = session?.user?.id || '';
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(identity));
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const dialog = useRef(null);
  const headers = useRef(authHeaders); headers.current = authHeaders;
  const close = useRef(onClose); close.current = onClose;
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    const previous = document.activeElement;
    const panel = dialog.current;
    panel?.querySelector('button')?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(panel?.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') || [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { active.current = false; document.removeEventListener('keydown', onKeyDown); previous?.focus?.({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    referralApi(`?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { authHeaders: headers.current, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [identity, page, revision]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(value, kind) {
    const ok = await copyInvitationText(value);
    if (!active.current) return;
    setCopied(ok ? kind : '');
    setCopyNotice(ok ? `${kind === 'code' ? '邀请码' : '邀请链接'}已复制，可以分享给好友。` : '浏览器未允许复制，请选中下方内容手动复制。');
  }

  const link = data?.code ? invitationLink(data.code) : '';
  const records = Array.isArray(data?.records) ? data.records : [];
  return <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="referral-title">
    <div ref={dialog} className="flex max-h-[100dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-xl border border-border-default bg-bg-secondary shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent"><Gift size={22} /></span><div><h2 id="referral-title" className="text-lg font-semibold text-text-primary">邀请奖励</h2><p className="mt-1 text-sm text-text-muted">分享创作灵感，收获奖励积分</p></div></div>
        <button type="button" onClick={onClose} aria-label="关闭邀请奖励" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-muted hover:bg-bg-elevated hover:text-text-primary"><X size={20} /></button>
      </header>
      <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-5 sm:p-6">
        {!identity ? <section className="rounded-xl border border-accent/25 bg-accent/5 p-6"><h3 className="text-lg font-semibold text-text-primary">你的分享，可以带来更多创作积分</h3><p className="mt-3 text-sm leading-7 text-text-secondary">好友使用你的邀请码注册后，每次成功兑换积分，你都将额外获得兑换额度的 10% 作为邀请奖励积分。</p><button type="button" onClick={onLogin} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover">登录查看我的邀请码<ArrowRight size={16} /></button></section> : <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="邀请奖励概览">
            <Metric label="累计奖励积分" value={loading ? '…' : data ? displayCredits(data.total_rewards) : '—'} accent />
            <Metric label="邀请注册人数" value={loading ? '…' : data ? `${data.invited_count ?? 0} 人` : '—'} />
            <Metric label="奖励比例" value="10%" />
          </div>
          {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error"><span>{error}</span><button type="button" onClick={() => setRevision(value => value + 1)} className={secondaryButton}><RefreshCw size={15} />刷新重试</button></div>}
          <section className="rounded-xl border border-accent/25 bg-bg-tertiary p-4 sm:p-5" aria-labelledby="my-referral-code">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 id="my-referral-code" className="text-sm font-semibold text-text-primary">我的邀请码</h3><p className="mt-1 text-xs leading-5 text-text-muted">分享链接会自动填写邀请码；好友也可以在注册时手动输入。</p></div><span className="rounded-md border border-accent/25 bg-accent/10 px-2 py-1 text-xs text-accent">可重复邀请</span></div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-primary px-4 py-3"><span className="select-all break-all font-mono text-xl font-semibold tracking-wider text-text-primary sm:text-2xl" aria-label="我的邀请码">{loading ? '正在加载…' : data?.code || '—'}</span><button type="button" disabled={!data?.code || loading} onClick={() => copy(data.code, 'code')} className={secondaryButton}>{copied === 'code' ? <Check size={16} className="text-mint" /> : <Copy size={16} />}复制邀请码</button></div>
            <label className="mt-4 block text-xs text-text-muted" htmlFor="referral-link">邀请链接</label><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input id="referral-link" value={link} readOnly onFocus={event => event.target.select()} placeholder="加载成功后显示邀请链接" className="min-h-11 min-w-0 flex-1 rounded-lg border border-border-default bg-bg-primary px-3 text-sm text-text-secondary outline-none focus:border-accent" /><button type="button" disabled={!link || loading} onClick={() => copy(link, 'link')} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-40">{copied === 'link' ? <Check size={16} /> : <Link2 size={16} />}复制邀请链接</button></div>
            {copyNotice && <p role="status" className={`mt-3 text-xs leading-5 ${copied ? 'text-mint' : 'text-text-secondary'}`}>{copyNotice}</p>}
          </section>
          <section aria-labelledby="referral-records-title">
            <div className="mb-3 flex items-center justify-between gap-3"><div><h3 id="referral-records-title" className="text-sm font-semibold text-text-primary">奖励记录</h3><p className="mt-1 text-xs text-text-muted">奖励自动进入积分余额，可直接用于站内创作。</p></div><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} className={secondaryButton} aria-label="刷新邀请奖励记录"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /><span className="hidden sm:inline">刷新记录</span></button></div>
            <div className="overflow-hidden rounded-xl border border-border-subtle bg-bg-primary">
              <div className="hidden grid-cols-[minmax(0,1fr)_1fr_1fr_1.3fr] gap-4 border-b border-border-subtle bg-bg-tertiary px-4 py-3 text-xs text-text-muted sm:grid"><span>受邀好友</span><span>兑换积分</span><span>奖励积分</span><span>到账时间 / 北京时间</span></div>
              {loading ? <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-text-muted" role="status"><Loader2 size={17} className="animate-spin" />正在加载奖励记录…</p> : error ? <p className="px-4 py-8 text-center text-sm text-text-muted">记录暂未同步，请刷新重试。</p> : records.length ? <div className="divide-y divide-border-subtle">{records.map(record => <div key={record.id} className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_1fr_1fr_1.3fr] sm:items-center"><span className="truncate font-medium text-text-secondary" title={record.invitee_name || '受邀好友'}>{record.invitee_name || '受邀好友'}</span><span className="text-right text-text-secondary sm:text-left"><span className="mr-1 text-xs text-text-muted sm:hidden">兑换</span>{displayCredits(record.redeemed_credits)}</span><strong className="text-mint">+{displayCredits(record.reward_credits)}<span className="ml-1 text-xs font-normal sm:hidden">奖励积分</span></strong><time className="text-right text-xs leading-5 text-text-muted sm:text-left" dateTime={record.created_at}>{formatTime(record.created_at)}</time></div>)}</div> : <div className="px-5 py-9 text-center"><Users size={25} className="mx-auto text-text-muted" /><p className="mt-3 text-sm text-text-secondary">还没有邀请奖励记录</p><p className="mt-1 text-xs leading-6 text-text-muted">好友通过邀请码注册并兑换积分后，奖励会显示在这里。</p></div>}
            </div>
            {(page > 0 || data?.has_more) && <div className="mt-3 flex items-center justify-end gap-3"><button type="button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)} className={secondaryButton} aria-label="上一页奖励记录"><ChevronLeft size={16} /></button><span className="text-xs text-text-muted">第 {page + 1} 页</span><button type="button" disabled={!data?.has_more || loading} onClick={() => setPage(value => value + 1)} className={secondaryButton} aria-label="下一页奖励记录"><ChevronRight size={16} /></button></div>}
          </section>
        </>}
        <section className="rounded-xl border border-border-subtle p-4 sm:p-5" aria-labelledby="referral-rules"><h3 id="referral-rules" className="text-sm font-semibold text-text-primary">邀请奖励说明</h3><ol className="mt-3 space-y-2 text-sm leading-6 text-text-secondary"><li>1. 好友在注册时填写你的邀请码，邀请关系绑定后不可更改。</li><li>2. 好友每次成功兑换积分，你额外获得兑换额度的 10%；好友的到账积分不受影响。</li><li>3. 仅奖励你直接邀请的好友，注册赠送、退款及管理员调整积分不计入。</li></ol><p className="mt-3 border-t border-border-subtle pt-3 text-xs leading-6 text-text-muted">例如：好友兑换 70 积分，你将获得 7 邀请奖励积分。已有账号不能补填邀请码。</p></section>
      </div>
    </div>
  </div>;
}

function Metric({ label, value, accent = false }) {
  return <div className={`rounded-xl border p-4 ${accent ? 'col-span-2 border-accent/30 bg-accent/8 sm:col-span-1' : 'border-border-subtle bg-bg-tertiary'}`}><p className="text-xs text-text-muted">{label}</p><p className={`mt-2 text-2xl font-semibold tabular-nums ${accent ? 'text-accent' : 'text-text-primary'}`}>{value}</p></div>;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
