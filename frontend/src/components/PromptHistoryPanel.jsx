import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, History, Loader2, RefreshCw, SquarePen, X } from "lucide-react";
import { cleanPromptHistory, readGuestPrompts } from "../lib/promptHistory";

export default function PromptHistoryPanel({ open, userId, authHeaders, onClose, onUsePrompt }) {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const active = useRef(null);

  const load = useCallback(async (nextCursor = null) => {
    if (!open || active.current) return;
    setError(""); setCopied("");
    if (!userId) { setEntries(readGuestPrompts()); setCursor(null); return; }
    const controller = new AbortController(); active.current = controller; setLoading(true);
    try {
      const params = new URLSearchParams(nextCursor ? { cursor: nextCursor } : {});
      const response = await fetch(`/api/history?${params}`, { headers: authHeaders, credentials: "include", signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.detail || data.error || "提示词历史加载失败");
      const page = cleanPromptHistory(data.entries || []);
      setEntries(current => cleanPromptHistory(nextCursor ? [...current, ...page] : page));
      setCursor(data.next_cursor || null);
    } catch (reason) { if (!controller.signal.aborted) setError(reason.message || "提示词历史加载失败"); }
    finally { if (active.current === controller) { active.current = null; setLoading(false); } }
  }, [open, userId, authHeaders]);

  useEffect(() => {
    setEntries([]); setCursor(null); setError(""); setCopied(""); setLoading(false);
    if (open) load();
    return () => { active.current?.abort(); active.current = null; };
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = event => { if (event.key === "Escape") onClose(); };
    const refreshOnFocus = () => setEntries(current => cleanPromptHistory(current));
    document.addEventListener("keydown", onKey); window.addEventListener("focus", refreshOnFocus);
    // Expire visible text too if the window remains open across the cutoff.
    const timer = setInterval(() => setEntries(current => cleanPromptHistory(current)), 60000);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener("focus", refreshOnFocus); clearInterval(timer); };
  }, [open, onClose]);

  const copy = async item => {
    try { await navigator.clipboard.writeText(item.prompt); setCopied(item.id); setError(""); }
    catch { setError("复制失败，请选中文本后手动复制。"); }
  };
  if (!open) return null;
  return <div className="fixed inset-0 z-[114] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="prompt-history-title">
    <section className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
      <header className="flex items-start justify-between gap-3 border-b border-border-subtle p-5"><div className="flex gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent"><History size={20} /></span><div><h2 id="prompt-history-title" className="text-base font-semibold text-text-primary">历史记录</h2><p className="mt-1 text-xs leading-5 text-text-muted">近七天的提示词文本 · {userId ? "当前账号" : "当前浏览器"}</p></div></div><div className="flex shrink-0 gap-1"><button type="button" aria-label="刷新提示词历史" disabled={loading} onClick={() => load()} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated disabled:opacity-50"><RefreshCw size={17} className={loading ? "animate-spin-soft" : ""} /></button><button type="button" aria-label="关闭历史记录" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated"><X size={18} /></button></div></header>
      <div className="min-h-0 space-y-3 overflow-y-auto p-4 sm:p-5">
        {error && <p role="alert" className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">{error}<button type="button" disabled={loading} onClick={() => load(cursor && entries.length ? cursor : null)} className="ml-3 underline">重试</button></p>}
        {!loading && !error && !entries.length && <div className="py-14 text-center"><History size={28} className="mx-auto text-text-muted" /><p className="mt-3 text-sm text-text-secondary">近七天还没有提示词记录</p><p className="mt-2 text-xs text-text-muted">提交生成请求后，可在这里复制或再次使用提示词。</p></div>}
        {entries.map(item => <article key={item.id} className="rounded-lg border border-border-subtle bg-bg-tertiary p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><time dateTime={item.created_at} className="text-xs text-text-muted">{new Date(item.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time><span className="text-xs text-text-muted">{item.prompt.length} 字</span></div><p className="select-text whitespace-pre-wrap break-words text-sm leading-7 text-text-secondary [overflow-wrap:anywhere]">{item.prompt}</p><div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-3"><button type="button" onClick={() => copy(item)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-xs text-text-secondary hover:bg-bg-elevated">{copied === item.id ? <Check size={15} className="text-mint" /> : <Copy size={15} />}{copied === item.id ? "已复制" : "复制提示词"}</button><button type="button" onClick={() => onUsePrompt(item.prompt)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 text-xs text-accent hover:bg-accent/15"><SquarePen size={15} />填入编辑器</button></div></article>)}
        {loading && <p className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted" role="status"><Loader2 size={17} className="animate-spin-soft" />正在加载提示词…</p>}
        {cursor && !loading && <button type="button" onClick={() => load(cursor)} className="min-h-11 w-full rounded-md border border-border-default text-sm text-text-secondary hover:bg-bg-elevated">加载更多</button>}
      </div>
    </section>
  </div>;
}
