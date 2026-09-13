import React, { useEffect, useState } from "react";
import { BarChart3, Loader2, X } from "lucide-react";

export default function AdminMetricsPanel({ open, authHeaders, onClose }) {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setBusy(true); setError("");
    fetch("/api/admin/metrics", { headers: authHeaders, credentials: "include" })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.detail || data.error || "统计数据加载失败"); return data; })
      .then((data) => setMetrics(data.metrics || {}))
      .catch((reason) => setError(reason.message))
      .finally(() => setBusy(false));
  }, [authHeaders, open]);
  if (!open) return null;
  const values = Object.entries(metrics || {}).filter(([, value]) => typeof value !== "object");
  return <div className="fixed inset-0 z-[115] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="metrics-title"><div className="max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg"><div className="flex items-center justify-between border-b border-border-subtle px-5 py-4"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent"><BarChart3 size={20} /></div><div><h2 id="metrics-title" className="text-base font-semibold text-text-primary">运营统计</h2><p className="mt-1 text-sm text-text-muted">仅显示聚合数据，不展示用户隐私</p></div></div><button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭运营统计"><X size={18} /></button></div><div className="p-5">{busy && <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted"><Loader2 size={16} className="animate-spin-soft" />加载统计数据</div>}{error && <p className="rounded-lg border border-error/35 bg-error/10 px-3 py-3 text-sm text-error">{error}</p>}{!busy && !error && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{values.map(([key, value]) => <div key={key} className="rounded-lg border border-border-subtle bg-bg-tertiary p-4"><p className="break-words text-xs text-text-muted">{key}</p><p className="mt-2 text-xl font-semibold text-text-primary">{typeof value === "number" ? value.toLocaleString("zh-CN") : String(value)}</p></div>)}</div>}</div></div></div>;
}
