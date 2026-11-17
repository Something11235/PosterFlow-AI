import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Gift, Loader2, RefreshCw, Search } from 'lucide-react';
import { displayCredits } from '../lib/credits';
import { ADMIN_REFERRAL_PAGE_SIZE, ADMIN_REFERRAL_SEARCH_LIMIT, createAdminReferralStore, referralBeijingTime, referralMember, referralRecordStatus } from '../lib/adminReferrals';

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-default px-3 text-sm text-text-secondary transition hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40';
const rowColumns = 'lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,.65fr)_minmax(0,.65fr)_minmax(0,.7fr)]';
const metrics = [['inviter_count', '邀请人'], ['invitee_count', '受邀用户'], ['redemption_count', '兑换次数'], ['redeemed_credits', '兑换积分'], ['reward_credits', '已发邀请奖励积分']];

export default function AdminReferralRewards({ authHeaders }) {
  const store = useMemo(() => createAdminReferralStore(authHeaders), [authHeaders]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { void store.start(); return () => store.dispose(); }, [store]);
  const { view, draftSearch, search, page, data, loading, error } = state;
  const relations = view === 'relations';
  const records = Array.isArray(data?.records) ? data.records : [];
  const total = Number(data?.total_count || 0);
  const headings = relations ? ['邀请人', '受邀用户', '绑定时间 / 北京时间', '兑换次数', '兑换积分', '邀请奖励积分'] : ['邀请人', '受邀用户', '兑换时间 / 北京时间', '兑换积分', '邀请奖励积分', '奖励状态'];
  return <section className="my-5 min-w-0 rounded-lg border border-accent/25 bg-bg-tertiary" aria-label="邀请奖励管理">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Gift size={17} className="text-accent" />邀请奖励</h3><p className="mt-1 text-xs leading-5 text-text-muted">全历史邀请关系与兑换奖励，独立于上方创作记录的日期筛选。</p></div><button type="button" disabled={loading} onClick={() => void store.refresh()} className={button} aria-label="刷新管理员邀请奖励"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新</button></header>
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="全历史邀请奖励统计">{metrics.map(([key, label], index) => <div key={key} className={`rounded-lg border p-3 ${index === 4 ? 'col-span-2 border-accent/25 bg-accent/5 lg:col-span-1' : 'border-border-subtle bg-bg-primary'}`}><p className="text-xs leading-5 text-text-muted">{label}</p><p className={`mt-2 text-xl font-semibold tabular-nums ${index === 4 ? 'text-accent' : 'text-text-primary'}`}>{data?.totals?.[key] == null ? loading ? '…' : '—' : key.endsWith('_credits') ? displayCredits(data.totals[key]) : Number(data.totals[key]).toLocaleString('zh-CN')}</p></div>)}</div>
      <div role="tablist" aria-label="邀请奖励记录类型" className="flex flex-wrap gap-2">{[['relations', '邀请关系'], ['rewards', '兑换与奖励记录']].map(([key, label]) => <button key={key} type="button" role="tab" id={`admin-referral-tab-${key}`} aria-selected={view === key} aria-controls="admin-referral-records" onClick={() => void store.setView(key)} className={`min-h-11 rounded-lg border px-3 text-sm transition ${view === key ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border-subtle text-text-muted hover:bg-bg-elevated'}`}>{label}</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void store.query(); }} className="flex flex-col gap-2 sm:flex-row"><label className="min-w-0 flex-1"><span className="sr-only">搜索邀请人或受邀用户</span><input aria-label="搜索邀请人或受邀用户" value={draftSearch} onChange={event => store.setDraft(event.target.value)} maxLength={ADMIN_REFERRAL_SEARCH_LIMIT} autoComplete="off" placeholder="搜索双方昵称、邮箱或用户编号" className="min-h-11 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent" /></label><button type="submit" disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"><Search size={15} />查询邀请记录</button></form>
      <p className="text-xs leading-5 text-text-muted">搜索仅筛选下方记录；上方统计始终汇总全部历史。仅好友兑换码到账计入奖励，注册赠送、退款和管理员调整不计入。</p>
      {error && <div role="alert" className="rounded-lg border border-error/30 bg-error/5 px-3 py-3 text-sm leading-6 text-error">{error}<button type="button" onClick={() => void store.refresh()} className="ml-3 min-h-11 text-accent">刷新重试</button></div>}
      <div id="admin-referral-records" role="tabpanel" aria-labelledby={`admin-referral-tab-${view}`} aria-busy={loading}>
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-primary">
          <div className={`hidden gap-3 border-b border-border-subtle bg-bg-secondary px-4 py-3 text-xs leading-5 text-text-muted lg:grid ${rowColumns}`}>{headings.map(heading => <span key={heading}>{heading}</span>)}</div>
          {loading ? <p role="status" className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-text-muted"><Loader2 size={17} className="animate-spin" />正在加载邀请记录…</p> : error ? <p className="px-4 py-8 text-center text-sm text-text-muted">记录暂未同步，请刷新重试。</p> : records.length ? <div className="max-h-[34rem] divide-y divide-border-subtle overflow-y-auto overscroll-contain">{records.map((record, index) => <div key={relations ? record.invitee_id || index : record.id || index} className={`grid grid-cols-2 gap-3 px-4 py-4 text-sm ${rowColumns}`}>
            <MemberCell record={record} side="inviter" label="邀请人" />
            <MemberCell record={record} side="invitee" label="受邀用户" />
            <div className="col-span-2 min-w-0 lg:col-span-1"><FieldLabel>{relations ? '绑定时间 / 北京时间' : '兑换时间 / 北京时间'}</FieldLabel><time className="break-words text-xs leading-6 text-text-muted" dateTime={relations ? record.bound_at : record.redeemed_at}>{referralBeijingTime(relations ? record.bound_at : record.redeemed_at)}</time></div>
            {relations ? <>
              <div><FieldLabel>兑换次数</FieldLabel><span className="text-text-secondary">{Number(record.redemption_count || 0).toLocaleString('zh-CN')}</span></div>
              <div><FieldLabel>兑换积分</FieldLabel><span className="text-text-secondary">{displayCredits(record.redeemed_credits)}</span></div>
              <div><FieldLabel>邀请奖励积分</FieldLabel><strong className="text-mint">{displayCredits(record.reward_credits)}</strong></div>
            </> : <>
              <div><FieldLabel>兑换积分</FieldLabel><span className="text-text-secondary">{displayCredits(record.redeemed_credits)}</span></div>
              <div><FieldLabel>邀请奖励积分</FieldLabel><strong className={record.status === 'rewarded' ? 'text-mint' : 'text-text-secondary'}>{record.status === 'rewarded' ? '+' : ''}{displayCredits(record.reward_credits)}</strong></div>
              <div><FieldLabel>奖励状态</FieldLabel><span className={`inline-flex rounded-md border px-2 py-1 text-xs ${record.status === 'rewarded' ? 'border-mint/25 bg-mint/5 text-mint' : 'border-gold/25 bg-gold/5 text-gold'}`}>{referralRecordStatus(record.status)}</span></div>
            </>}
          </div>)}</div> : <div className="px-4 py-9 text-center"><p className="text-sm text-text-secondary">{search ? '未找到匹配的邀请记录' : relations ? '暂无邀请关系' : '暂无兑换与奖励记录'}</p><p className="mt-2 text-xs leading-6 text-text-muted">{search ? '可以搜索邀请人或受邀用户的昵称、邮箱和用户编号。' : relations ? '新用户注册时绑定邀请码后，邀请双方会显示在这里。' : '受邀用户成功兑换积分后，这里会记录兑换与奖励发放情况。'}</p></div>}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted"><span>{loading ? '正在同步记录…' : error ? '记录暂未确认' : `${total.toLocaleString('zh-CN')} 条记录 · 每页 ${ADMIN_REFERRAL_PAGE_SIZE} 条`}</span><div className="flex items-center gap-3"><button type="button" disabled={page === 0 || loading} onClick={() => void store.setPage(page - 1)} className={button} aria-label="上一页邀请记录"><ChevronLeft size={16} /></button><span>第 {page + 1} 页</span><button type="button" disabled={!data?.has_more || loading || Boolean(error)} onClick={() => void store.setPage(page + 1)} className={button} aria-label="下一页邀请记录"><ChevronRight size={16} /></button></div></div>
      </div>
    </div>
  </section>;
}

function FieldLabel({ children }) { return <span className="mb-1 block text-xs text-text-muted lg:hidden">{children}</span>; }

function MemberCell({ record, side, label }) {
  const member = referralMember(record, side);
  return <div className="min-w-0"><FieldLabel>{label}</FieldLabel><p className="break-words font-medium text-text-primary">{member.name}</p>{member.email && <p className="mt-1 break-all text-xs leading-5 text-text-muted">{member.email}</p>}<p className="mt-1 break-all font-mono text-[10px] leading-4 text-text-muted" title={member.id}>编号：{member.id || '记录未提供'}</p></div>;
}
