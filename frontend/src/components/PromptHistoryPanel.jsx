import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, History, Loader2, RefreshCw, SquarePen, X } from "lucide-react";
import { cleanPromptHistory, readGuestPrompts, HISTORY_PREVIEW_WINDOW_MS } from "../lib/promptHistory";
import HistoryImagePreviews from "./HistoryImagePreviews";

export default function PromptHistoryPanel({ open, userId, authHeaders, onClose, onUsePrompt, onOpenImageTasks }) {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [previewWarning, setPreviewWarning] = useState("");
  const active = useRef(null);

  const load = useCallback(async (nextCursor = null) => {
    if (!open || active.current) return;
    setError(""); setCopied(""); setPreviewWarning("");
    if (!userId) { setEntries(readGuestPrompts()); setCursor(null); return; }
    const controller = new AbortController(); active.current = controller; setLoading(true);
    try {
      const params = new URLSearchParams(nextCursor ? { cursor: nextCursor } : {});
      const response = await fetch(`/api/history?${params}`, { headers: authHeaders, credentials: "include", signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.detail || data.error || "提示词历史加载失败");
      const page = cleanPromptHistory(data.entries || []);
      if (data.previews_unavailable) setPreviewWarning("预览信息暂时无法读取，提示词仍可正常使用。可稍后刷新。");
      setEntries(current => cleanPromptHistory(nextCursor ? [...current, ...page] : page));
      setCursor(data.next_cursor || null);
    } catch (reason) { if (!controller.signal.aborted) setError(reason.message || "提示词历史加载失败"); }
    finally { if (active.current === controller) { active.current = null; setLoading(false); } }
  }, [open, userId, authHeaders]);

  useEffect(() => {
    setEntries([]); setCursor(null); setError(""); setCopied(""); setLoading(false); setPreviewWarning("");
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
      <header className="flex items-start justify-between gap-3 border-b border-border-subtle p-5"><div className="flex gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent"><History size={20} /></span><div><p className="mb-1 flex items-center gap-1 text-xs text-text-muted">资料与工具<ChevronRight size={12} /></p><h2 id="prompt-history-title" className="text-base font-semibold text-text-primary">历史记录</h2><p className="mt-1 text-xs leading-5 text-text-muted">近七天的图像、音乐与视频提示词 · {userId ? "当前账号" : "当前浏览器"}</p></div></div><div className="flex shrink-0 gap-1"><button type="button" aria-label="刷新提示词历史" disabled={loading} onClick={() => load()} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated disabled:opacity-50"><RefreshCw size={17} className={loading ? "animate-spin-soft" : ""} /></button><button type="button" aria-label="关闭历史记录" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated"><X size={18} /></button></div></header>
      <div className="min-h-0 space-y-3 overflow-y-auto p-4 sm:p-5">
        {onOpenImageTasks && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/8 p-3"><p className="text-sm leading-6 text-text-secondary">生成未完成或刷新后找不到图片？</p><button type="button" onClick={onOpenImageTasks} className="min-h-11 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover">生图任务 · 查询与查看结果</button></div>}
        <p className="rounded-md border border-accent/20 bg-accent/5 p-3 text-xs leading-6 text-text-secondary">{userId ? "图片预览仅保留 12 小时，点击后加载小尺寸缩略图，不读取原图。提示词仍保留 7 天。" : "当前浏览器保留近 7 天提示词；登录后可查看账号最近 12 小时的图片预览。"}</p>
        {previewWarning && <p role="status" className="text-xs leading-6 text-text-muted">{previewWarning}</p>}
        {error && <p role="alert" className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">{error}<button type="button" disabled={loading} onClick={() => load(cursor && entries.length ? cursor : null)} className="ml-3 underline">重试</button></p>}
        {!loading && !error && !entries.length && <div className="py-14 text-center"><History size={28} className="mx-auto text-text-muted" /><p className="mt-3 text-sm text-text-secondary">近七天还没有提示词记录</p><p className="mt-2 text-xs text-text-muted">提交生成请求后，可在这里复制或再次使用提示词。</p></div>}
        {entries.map(item => <article key={item.id} className="rounded-lg border border-border-subtle bg-bg-tertiary p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-accent">{item.kind === "music" ? "音乐" : item.kind === "video" ? "视频" : "图像"}</span><time dateTime={item.created_at} className="text-xs text-text-muted">{new Date(item.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time><span className="text-xs text-text-muted">{Array.from(item.prompt).length} 字符</span></div>
          <p className="select-text whitespace-pre-wrap break-words text-sm leading-7 text-text-secondary [overflow-wrap:anywhere]">{item.prompt}</p>
          {userId && !["music","video"].includes(item.kind) && item.preview_count > 0 && <HistoryImagePreviews entryId={item.id} count={item.preview_count} expiresAt={item.preview_expires_at} authHeaders={authHeaders} />}
          {userId && !["music","video"].includes(item.kind) && Date.parse(item.created_at) <= Date.now() - HISTORY_PREVIEW_WINDOW_MS && <p className="mt-3 text-xs text-text-muted">图片预览已过期，提示词仍可使用。</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-3"><button type="button" onClick={() => copy(item)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-xs text-text-secondary hover:bg-bg-elevated">{copied === item.id ? <Check size={15} className="text-mint" /> : <Copy size={15} />}{copied === item.id ? "已复制" : "复制提示词"}</button><button type="button" onClick={() => onUsePrompt(item.prompt, item)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 text-xs text-accent hover:bg-accent/15"><SquarePen size={15} />{item.kind === "music" ? "填入音乐编辑器" : item.kind === "video" ? "填入视频编辑器" : "填入图像编辑器"}</button></div>
        </article>)}
        {loading && <p className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted" role="status"><Loader2 size={17} className="animate-spin-soft" />正在加载提示词…</p>}
        {cursor && !loading && <button type="button" onClick={() => load(cursor)} className="min-h-11 w-full rounded-md border border-border-default text-sm text-text-secondary hover:bg-bg-elevated">加载更多</button>}
      </div>
    </section>
  </div>;
}
