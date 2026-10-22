import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CircleDollarSign, CreditCard, Loader2, RefreshCw, Search, Send, ShieldCheck, UsersRound, X } from "lucide-react";
import AnnouncementManager from "./AnnouncementManager";
import AdminBookkeepingPanel from "./AdminBookkeepingPanel";
import { beijingDate, initialStatsFrom } from "../lib/adminBookkeeping";

const METRIC_LABELS = {
  registered_users: "新增用户", verified_users: "已验证邮箱", daily_active_users: "今日活跃", monthly_active_users: "本月活跃",
  generated_images: "生成图片", success_rate: "生成成功率", average_duration_ms: "平均耗时", credits_granted: "发放积分",
  credits_consumed: "消费积分", credits_refunded: "退款积分", platform_jobs: "平台模式任务", own_key_jobs: "自带 Key 任务",
};
const EMPTY_SNAPSHOT = { metrics: {}, users: [], usage: [], orders: [], settings: {} };

function formatMetric(key, value) {
  if (key === "success_rate") return `${value}%`;
  if (key === "average_duration_ms") return `${Number(value || 0).toLocaleString("zh-CN")} ms`;
  return Number(value || 0).toLocaleString("zh-CN");
}

function dateValue(offset) {
  return beijingDate(offset);
}

export default function AdminMetricsPanel({ open, authHeaders, onClose }) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [bookkeepingSaving, setBookkeepingSaving] = useState(false);
  const [clearingStorage, setClearingStorage] = useState(false);
  const [signupBonusCredits, setSignupBonusCredits] = useState("10");
  const [settingsReason, setSettingsReason] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(() => initialStatsFrom());
  const [to, setTo] = useState(() => dateValue(0));
  const [selectedUser, setSelectedUser] = useState(null);
  const [delta, setDelta] = useState("10");
  const [reason, setReason] = useState("管理员发放积分");
  const [success, setSuccess] = useState("");
  const adjustmentKeyRef = useRef(null);
  const settingsLoadedRef = useRef(false);
  const queryRef = useRef({ from, to, search });
  const activeRequestRef = useRef(null);
  const panelStateRef = useRef({ open: false, authHeaders: null });

  useEffect(() => {
    // Editing filters must not trigger database requests before clicking Query.
    queryRef.current = { from, to, search };
  }, [from, to, search]);

  useEffect(() => {
    adjustmentKeyRef.current = null;
  }, [delta, reason, selectedUser?.user_id]);

  const loadSnapshot = useCallback(async () => {
    if (!open || !panelStateRef.current.open || panelStateRef.current.authHeaders !== authHeaders || activeRequestRef.current) return;
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams(queryRef.current);
      const response = await fetch(`/api/admin/console?${params}`, { headers: authHeaders, credentials: "include", signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.detail || data.error || "管理数据加载失败");
      const settings = data.settings || {};
      setSnapshot({ metrics: data.metrics || {}, users: data.users || [], usage: data.usage || [], orders: [], settings, bookkeeping: data.bookkeeping });
      if (!settingsLoadedRef.current && settings.signup_bonus_credits !== undefined) {
        setSignupBonusCredits(String(settings.signup_bonus_credits));
        settingsLoadedRef.current = true;
      }
    } catch (reasonValue) {
      if (!controller.signal.aborted) setError(reasonValue.message || "管理数据加载失败");
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        setBusy(false);
      }
    }
  }, [authHeaders, open]);

  useEffect(() => {
    panelStateRef.current = { open, authHeaders };
    setSnapshot(EMPTY_SNAPSHOT);
    setSelectedUser(null);
    setBookkeepingSaving(false);
    settingsLoadedRef.current = false;
    if (open) {
      setSuccess("");
      loadSnapshot();
    } else {
      setBusy(false);
    }
    return () => {
      panelStateRef.current.open = false;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [authHeaders, loadSnapshot, open]);

  const saveSignupBonus = async (event) => {
    event.preventDefault();
    if (!/^\d+$/.test(signupBonusCredits.trim())) {
      setError("新用户注册赠送积分必须是 0 到 10000 之间的整数。");
      return;
    }
    const value = Number(signupBonusCredits);
    if (!Number.isSafeInteger(value) || value < 0 || value > 10000) {
      setError("新用户注册赠送积分必须是 0 到 10000 之间的整数。");
      return;
    }
    setSavingSettings(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/admin/settings/credits", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ signup_bonus_credits: value, reason: settingsReason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "积分设置保存失败");
      setSignupBonusCredits(String(data.settings?.signup_bonus_credits ?? value));
      setSuccess(`已将新用户注册赠送积分设置为 ${data.settings?.signup_bonus_credits ?? value}。只影响尚未领取注册奖励的用户。`);
      await loadSnapshot();
    } catch (reasonValue) {
      setError(reasonValue.message || "积分设置保存失败");
    } finally {
      setSavingSettings(false);
    }
  };

  const adjustCredits = async (event) => {
    event.preventDefault();
    if (!selectedUser) return;
    const value = Number.parseInt(delta, 10);
    if (!Number.isInteger(value) || value === 0) {
      setError("积分调整必须是一个不为 0 的整数。");
      return;
    }
    setAdjusting(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/admin/credits/adjust", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ user_id: selectedUser.user_id, delta: value, reason, idempotency_key: adjustmentKeyRef.current || (adjustmentKeyRef.current = globalThis.crypto?.randomUUID?.() || `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "积分调整失败");
      setSelectedUser((current) => current ? { ...current, balance: data.balance } : current);
      setSuccess(`已为 ${selectedUser.username || selectedUser.email || "该用户"} 调整 ${value > 0 ? "+" : ""}${value} 积分。`);
      adjustmentKeyRef.current = null;
      await loadSnapshot();
    } catch (reasonValue) {
      setError(reasonValue.message || "积分调整失败");
    } finally {
      setAdjusting(false);
    }
  };

  const clearHistoryStorage = async () => {
    if (!window.confirm("确认清空所有用户已保存的历史图片吗？此操作不可恢复，旧图片链接和画布引用也会失效；生成统计和积分流水不会删除。")) return;
    setClearingStorage(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/admin/storage/clear-history", {
        method: "POST",
        headers: authHeaders,
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.detail || data.error || "历史图片清理失败");
      setSuccess(`已清空历史图片，共删除 ${data.removed || 0} 个存储对象。生成统计和积分流水未受影响。`);
    } catch (reasonValue) {
      setError(reasonValue.message || "历史图片清理失败");
    } finally {
      setClearingStorage(false);
    }
  };

  const metricEntries = useMemo(() => Object.entries(snapshot.metrics).filter(([key, value]) => !["paid_orders", "purchase_credits", "topup_amount_yuan"].includes(key) && typeof value !== "object"), [snapshot.metrics]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[115] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="metrics-title" aria-busy={busy}>
      <div className="flex max-h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 items-center gap-3"><div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent"><ShieldCheck size={20} /></div><div className="min-w-0"><h2 id="metrics-title" className="text-base font-semibold text-text-primary">管理员控制台</h2><p className="mt-1 text-sm text-text-muted">查看用户与用量、记录收支，并管理平台积分</p></div></div>
          <div className="flex items-center gap-1"><button type="button" onClick={() => loadSnapshot()} disabled={busy || adjusting || savingSettings || bookkeepingSaving} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50" aria-label="刷新管理数据" title="刷新"><RefreshCw size={17} className={busy ? "animate-spin-soft" : ""} /></button><button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭管理员控制台"><X size={18} /></button></div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {busy && <p className="mb-4 flex items-center gap-2 text-sm text-text-muted" role="status"><Loader2 size={16} className="animate-spin-soft" />正在加载管理数据…</p>}
          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metricEntries.map(([key, value]) => <div key={key} className="rounded-lg border border-border-subtle bg-bg-tertiary p-4"><p className="text-xs text-text-muted">{METRIC_LABELS[key] || key}</p><p className="mt-2 text-xl font-semibold text-text-primary">{formatMetric(key, value)}</p></div>)}</div>
          <section className="mb-5" aria-label="用户查询与积分记录">
          <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-tertiary p-3 lg:flex-row lg:items-end">
            <label className="flex-1 text-xs text-text-muted">搜索用户<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="用户名或邮箱" className="mt-1 min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent/70" /></label>
            <label className="text-xs text-text-muted">开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1 min-h-11 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" /></label>
            <label className="text-xs text-text-muted">结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1 min-h-11 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" /></label>
            <button type="button" onClick={() => loadSnapshot()} disabled={busy || adjusting || savingSettings || bookkeepingSaving} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"><Search size={15} />查询</button>
          </div>
          {error && <p className="mb-4 rounded-lg border border-error/35 bg-error/10 px-3 py-3 text-sm text-error" role="alert">{error}</p>}{success && <p className="mb-4 rounded-lg border border-mint/30 bg-mint/10 px-3 py-3 text-sm text-mint" role="status">{success}</p>}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <section className="min-w-0 rounded-lg border border-border-subtle bg-bg-tertiary"><div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3"><UsersRound size={16} className="text-accent" /><h3 className="text-sm font-semibold text-text-primary">用户积分</h3><span className="ml-auto text-xs text-text-muted">{snapshot.users.length} 位</span></div><div className="max-h-[390px] overflow-y-auto p-2">{busy && <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted"><Loader2 size={16} className="animate-spin-soft" />正在加载</div>}{!busy && !snapshot.users.length && <p className="px-3 py-10 text-center text-sm text-text-muted">没有匹配的用户</p>}{!busy && snapshot.users.map((item) => <button type="button" key={item.user_id} onClick={() => setSelectedUser(item)} className={`flex w-full items-center gap-3 rounded-md p-3 text-left transition ${selectedUser?.user_id === item.user_id ? "bg-accent/12" : "hover:bg-bg-elevated"}`}><div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border-default bg-bg-primary text-xs text-accent">{String(item.username || "U").slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-text-primary">{item.username || "未命名用户"}</p><p className="truncate text-xs text-text-muted">{item.email || item.user_id}</p></div><strong className="text-sm text-accent">{item.balance ?? 0}</strong></button>)}</div><form onSubmit={adjustCredits} className="border-t border-border-subtle p-4"><p className="mb-3 text-xs font-medium text-text-secondary">{selectedUser ? `调整：${selectedUser.username || selectedUser.email}` : "先选择一位用户"}</p><div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2"><input type="number" step="1" value={delta} onChange={(event) => setDelta(event.target.value)} disabled={!selectedUser || adjusting || busy} className="min-h-11 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" placeholder="+10 / -10" /><input value={reason} onChange={(event) => setReason(event.target.value)} disabled={!selectedUser || adjusting || busy} className="min-h-11 min-w-0 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" placeholder="调整原因" /></div><button type="submit" disabled={!selectedUser || adjusting || busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-accent/35 bg-accent/10 text-sm font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"><Send size={15} />{adjusting ? "提交中…" : "提交积分调整"}</button></form></section>
            <section className="min-w-0 rounded-lg border border-border-subtle bg-bg-tertiary"><div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3"><Activity size={16} className="text-mint" /><h3 className="text-sm font-semibold text-text-primary">积分使用记录</h3><span className="ml-auto text-xs text-text-muted">手动刷新更新</span></div><div className="max-h-[520px] overflow-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="sticky top-0 bg-bg-tertiary text-text-muted"><tr><th className="px-4 py-3 font-medium">用户</th><th className="px-4 py-3 font-medium">时间</th><th className="px-4 py-3 font-medium">模式</th><th className="px-4 py-3 font-medium">状态</th><th className="px-4 py-3 font-medium">积分</th><th className="px-4 py-3 font-medium">请求</th></tr></thead><tbody className="divide-y divide-border-subtle">{snapshot.usage.map((item) => <tr key={item.id} className="text-text-secondary"><td className="max-w-[190px] px-4 py-3"><p className="truncate font-medium text-text-primary">{item.username || "未知用户"}</p><p className="truncate text-text-muted">{item.email || item.user_id}</p></td><td className="whitespace-nowrap px-4 py-3">{item.created_at ? new Date(item.created_at).toLocaleString("zh-CN") : "-"}</td><td className="px-4 py-3">{item.billing_mode === "platform" ? "平台积分" : "自带 Key"}</td><td className="px-4 py-3">{item.status === "succeeded" ? <span className="text-mint">成功</span> : item.status === "refunded" ? <span className="text-gold">已退款</span> : <span className="text-text-muted">{item.status || "处理中"}</span>}</td><td className="px-4 py-3 font-semibold">{item.charged_credits || 0}</td><td className="max-w-[220px] truncate px-4 py-3" title={item.model}>{item.model || "图片生成"}</td></tr>)}</tbody></table>{!snapshot.usage.length && <p className="px-4 py-10 text-center text-sm text-text-muted">所选日期范围内还没有生成记录</p>}</div></section>
          </div>
          <div className="mt-4 grid gap-3 text-xs leading-5 text-text-muted sm:grid-cols-3"><p className="flex gap-2"><CircleDollarSign size={15} className="mt-0.5 flex-shrink-0 text-accent" />正数代表发放积分，负数代表扣除积分；所有操作都会写入流水。</p><p className="flex gap-2"><CreditCard size={15} className="mt-0.5 flex-shrink-0 text-accent" />管理员调整使用幂等编号，重复提交不会重复到账。</p><p className="flex gap-2"><Activity size={15} className="mt-0.5 flex-shrink-0 text-mint" />这里只展示账户与用量信息，不显示平台图片服务的真实地址。</p></div>
          </section>
          <AdminBookkeepingPanel initialData={snapshot.bookkeeping} authHeaders={authHeaders} loading={busy} onSavingChange={setBookkeepingSaving} />
          <section className="mb-4 rounded-lg border border-accent/25 bg-accent/5 p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0"><h3 className="text-sm font-semibold text-text-primary">新用户注册赠送积分</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">只影响还没有领取注册奖励的用户；已经到账的积分不会自动变化。可设置为 0，范围是 0–10000 的整数。</p></div>
              <form onSubmit={saveSignupBonus} className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto"><label className="sr-only" htmlFor="signup-bonus-credits">注册赠送积分数量</label><input id="signup-bonus-credits" type="number" min="0" max="10000" step="1" value={signupBonusCredits} onChange={(event) => setSignupBonusCredits(event.target.value)} disabled={savingSettings || busy} className="min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary sm:w-32" placeholder="10" /><label className="sr-only" htmlFor="signup-bonus-reason">修改原因</label><input id="signup-bonus-reason" value={settingsReason} onChange={(event) => setSettingsReason(event.target.value)} disabled={savingSettings || busy} className="min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary sm:w-52" placeholder="修改说明（可选）" /><button type="submit" disabled={savingSettings || busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{savingSettings ? <Loader2 size={15} className="animate-spin-soft" /> : <CircleDollarSign size={15} />}{savingSettings ? "保存中…" : "保存设置"}</button></form>
            </div>
          </section>
          <section className="mb-4 rounded-lg border border-error/25 bg-error/5 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div><h3 className="text-sm font-semibold text-text-primary">清理历史图片存储</h3><p className="mt-1 text-xs leading-5 text-text-muted">网站已停止保存新的图片历史。清理后会删除所有用户的生成图片和本地输出文件，旧图片链接将无法恢复；生成统计、积分流水和账户数据会保留。</p></div>
              <button type="button" onClick={clearHistoryStorage} disabled={clearingStorage} className="inline-flex min-h-11 flex-none items-center justify-center gap-2 rounded-md border border-error/35 bg-error/10 px-4 text-sm font-medium text-error hover:bg-error/15 disabled:cursor-not-allowed disabled:opacity-50">{clearingStorage ? <Loader2 size={15} className="animate-spin-soft" /> : <RefreshCw size={15} />}{clearingStorage ? "清理中…" : "清空历史图片"}</button>
            </div>
          </section>
          <AnnouncementManager authHeaders={authHeaders} />

        </div>
      </div>
    </div>
  );
}
