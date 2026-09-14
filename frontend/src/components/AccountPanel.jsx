import React, { useState } from "react";
import { CircleUserRound, CreditCard, LogOut, MailCheck, Trash2, X } from "lucide-react";

export default function AccountPanel({ open, account, loading, paymentEnabled, onClose, onSignOut, onDelete, onOpenRecharge }) {
  const [deleting, setDeleting] = useState(false);
  if (!open) return null;
  const profile = account?.profile || {};
  const credits = account?.credits || {};
  const verified = Boolean(profile.email_confirmed_at || profile.email_verified || account?.email_verified);
  const deleteAccount = async () => {
    if (!window.confirm("确定删除账号吗？该操作不可撤销。")) return;
    setDeleting(true);
    try { await onDelete?.(); } finally { setDeleting(false); }
  };
  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="account-panel-title">
      <div className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
        <div className="flex items-start justify-between border-b border-border-subtle px-5 py-4"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent"><CircleUserRound size={20} /></div><div><h2 id="account-panel-title" className="text-base font-semibold text-text-primary">账户中心</h2><p className="mt-1 text-sm text-text-muted">管理账户状态与平台积分</p></div></div><button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭账户中心"><X size={18} /></button></div>
        <div className="space-y-4 px-5 py-5">
          <div className="rounded-lg border border-border-subtle bg-bg-tertiary p-4"><p className="text-sm font-medium text-text-primary">{profile.username || account?.email || "PosterFlow 用户"}</p><p className="mt-1 break-all text-sm text-text-muted">{account?.email || ""}</p><p className={`mt-3 inline-flex items-center gap-2 text-xs ${loading ? "animate-pulse text-text-muted" : verified ? "text-mint" : "text-gold"}`}><MailCheck size={14} />{loading ? "正在同步邮箱与积分状态…" : verified ? "邮箱已验证，积分奖励已激活" : "邮箱尚未验证，验证后领取 10 个积分"}</p></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="当前积分" value={loading ? "…" : credits.balance ?? "--"} accent /><Stat label="累计发放" value={loading ? "…" : credits.total_granted ?? "--"} /><Stat label="累计消费" value={loading ? "…" : credits.total_spent ?? "--"} /><Stat label="已退款" value={loading ? "…" : credits.total_refunded ?? "--"} /></div>
          {verified && <button type="button" onClick={onOpenRecharge} disabled={!paymentEnabled} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"><CreditCard size={16} />{paymentEnabled ? "一键购买积分" : "在线充值暂未开放"}</button>}
          <div><h3 className="text-sm font-semibold text-text-primary">最近积分流水</h3><div className="mt-2 divide-y divide-border-subtle rounded-lg border border-border-subtle bg-bg-tertiary">{(account?.transactions || []).slice(0, 6).map((item) => <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-3 text-sm"><span className="text-text-secondary">{item.type === "signup_bonus" ? "注册奖励" : item.type === "refund" ? "生成退款" : item.type === "purchase" ? "充值到账" : item.type === "spend" ? "生图消费" : item.type === "reserve" ? "生成预扣" : "积分调整"}</span><strong className={Number(item.delta) >= 0 ? "text-mint" : "text-text-primary"}>{Number(item.delta) > 0 ? "+" : ""}{item.delta}</strong></div>)}{loading ? <p className="animate-pulse px-3 py-4 text-sm text-text-muted">正在同步积分流水…</p> : !(account?.transactions || []).length && <p className="px-3 py-4 text-sm text-text-muted">暂时没有流水记录</p>}</div></div>
          <div className="flex flex-col-reverse gap-2 border-t border-border-subtle pt-4 sm:flex-row sm:justify-between"><button type="button" onClick={onSignOut} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-default px-4 text-sm text-text-secondary hover:bg-bg-elevated"><LogOut size={16} />退出登录</button><button type="button" disabled={deleting} onClick={deleteAccount} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm text-error hover:bg-error/10 disabled:opacity-50"><Trash2 size={16} />{deleting ? "删除中" : "删除账号"}</button></div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false }) { return <div className="rounded-lg border border-border-subtle bg-bg-tertiary p-3"><p className="text-xs text-text-muted">{label}</p><p className={`mt-1 text-xl font-semibold ${accent ? "text-accent" : "text-text-primary"}`}>{value}</p></div>; }
