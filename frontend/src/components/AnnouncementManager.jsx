import React, { useCallback, useEffect, useState } from "react";
import { Bell, Edit3, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { toApiDate, toInputDate } from "../lib/announcementTime";

const EMPTY_FORM = { id: "", title: "", content: "", announcement_type: "info", status: "draft", is_pinned: false, starts_at: "", ends_at: "" };
const STATUS_LABELS = { all: "全部", draft: "草稿", published: "已发布", offline: "已下线" };
const TYPE_LABELS = { info: "普通通知", important: "重要提醒", maintenance: "服务维护" };

export default function AnnouncementManager({ authHeaders }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status, search });
      const response = await fetch(`/api/admin/announcements?${params}`, { headers: authHeaders, credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "公告加载失败");
      setItems(Array.isArray(data.announcements) ? data.announcements : []);
    } catch (reason) { setError(reason.message || "公告加载失败"); }
    finally { setLoading(false); }
  }, [authHeaders, search, status]);

  useEffect(() => { load(); }, [load]);

  const edit = (item) => setForm({ ...item, starts_at: toInputDate(item.starts_at), ends_at: toInputDate(item.ends_at) });
  const reset = () => setForm(EMPTY_FORM);
  const updateField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.content.trim()) { setError("请填写公告标题和内容。"); return; }
    setSaving(true); setError(""); setSuccess("");
    try {
      const payload = { ...form, starts_at: toApiDate(form.starts_at), ends_at: toApiDate(form.ends_at) };
      delete payload.id;
      const response = await fetch(form.id ? `/api/admin/announcements/${form.id}` : "/api/admin/announcements", { method: form.id ? "PATCH" : "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "公告保存失败");
      setSuccess(form.id ? "公告已更新。" : "公告已创建。"); reset(); await load();
    } catch (reason) { setError(reason.message || "公告保存失败"); }
    finally { setSaving(false); }
  };

  const remove = async (item) => {
    if (!window.confirm(`确定删除公告“${item.title}”吗？`)) return;
    setError(""); setSuccess("");
    try {
      const response = await fetch(`/api/admin/announcements/${item.id}`, { method: "DELETE", headers: authHeaders, credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "公告删除失败");
      if (form.id === item.id) reset(); setSuccess("公告已删除。"); await load();
    } catch (reason) { setError(reason.message || "公告删除失败"); }
  };

  return <section className="mt-5 rounded-lg border border-border-subtle bg-bg-tertiary">
    <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3"><div className="flex items-center gap-2"><Bell size={16} className="text-accent" /><h3 className="text-sm font-semibold text-text-primary">公告管理</h3></div><span className="text-xs text-text-muted">发布后所有用户都能看到</span><button type="button" onClick={reset} className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-3 text-xs font-medium text-accent hover:bg-accent/15"><Plus size={14} />新建公告</button></div>
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap gap-2"><input value={search} onChange={(event) => setSearch(event.target.value)} className="min-h-10 min-w-48 flex-1 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" placeholder="搜索标题或内容" aria-label="搜索公告" />{Object.entries(STATUS_LABELS).map(([key, label]) => <button key={key} type="button" onClick={() => setStatus(key)} className={`min-h-10 rounded-md border px-3 text-xs ${status === key ? "border-accent/40 bg-accent/12 text-accent" : "border-border-default text-text-muted hover:text-text-primary"}`}>{label}</button>)}</div>
        <div className="max-h-[440px] space-y-2 overflow-y-auto">{loading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted"><Loader2 size={16} className="animate-spin-soft" />正在加载公告</div>}{!loading && !items.length && <p className="py-12 text-center text-sm text-text-muted">暂时没有公告</p>}{!loading && items.map((item) => <article key={item.id} className="rounded-md border border-border-subtle bg-bg-secondary p-3"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium text-text-primary">{item.title}</h4><span className="rounded border border-border-default px-1.5 py-0.5 text-[10px] text-text-muted">{TYPE_LABELS[item.announcement_type] || item.announcement_type}</span><span className={`rounded border px-1.5 py-0.5 text-[10px] ${item.status === "published" ? "border-mint/30 text-mint" : item.status === "draft" ? "border-gold/30 text-gold" : "border-border-default text-text-muted"}`}>{STATUS_LABELS[item.status]}</span>{item.is_pinned && <span className="text-[10px] text-accent">置顶</span>}</div><p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-text-muted">{item.content}</p></div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => edit(item)} className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label={`编辑公告 ${item.title}`}><Edit3 size={14} /></button><button type="button" onClick={() => remove(item)} className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-text-muted hover:bg-red-500/10 hover:text-red-300" aria-label={`删除公告 ${item.title}`}><Trash2 size={14} /></button></div></div></article>)}</div>
      </div>
      <form onSubmit={save} className="rounded-md border border-border-subtle bg-bg-secondary p-4"><div className="mb-3 flex items-center justify-between"><p className="text-sm font-medium text-text-primary">{form.id ? "编辑公告" : "新建公告"}</p>{form.id && <button type="button" onClick={reset} className="text-xs text-text-muted hover:text-text-primary">取消编辑</button>}</div><label className="block text-xs text-text-secondary">标题<input value={form.title} onChange={(event) => updateField("title", event.target.value)} maxLength={120} className="mt-1 min-h-10 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" placeholder="例如：平台服务调整通知" /></label><label className="mt-3 block text-xs text-text-secondary">内容<textarea value={form.content} onChange={(event) => updateField("content", event.target.value)} maxLength={5000} rows={6} className="mt-1 w-full resize-y rounded-md border border-border-default bg-bg-primary px-3 py-2 text-sm leading-6 text-text-primary" placeholder="写清楚公告内容、影响范围和处理方式" /></label><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs text-text-secondary">类型<select value={form.announcement_type} onChange={(event) => updateField("announcement_type", event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary">{Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="text-xs text-text-secondary">状态<select value={form.status} onChange={(event) => updateField("status", event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary">{Object.entries(STATUS_LABELS).filter(([key]) => key !== "all").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="text-xs text-text-secondary">开始展示（北京时间）<input type="datetime-local" value={form.starts_at} onChange={(event) => updateField("starts_at", event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" /></label><label className="text-xs text-text-secondary">结束展示（北京时间，可选）<input type="datetime-local" value={form.ends_at} onChange={(event) => updateField("ends_at", event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary" /></label></div><label className="mt-3 flex min-h-10 items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={form.is_pinned} onChange={(event) => updateField("is_pinned", event.target.checked)} className="h-4 w-4 accent-accent" />置顶这条公告</label><button type="submit" disabled={saving} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"><Save size={15} />{saving ? "保存中…" : form.id ? "保存修改" : "创建公告"}</button></form>
    </div>
    {(error || success) && <div className={`mx-4 mb-4 rounded-md border px-3 py-2 text-sm ${error ? "border-red-400/30 bg-red-400/8 text-red-200" : "border-mint/30 bg-mint/8 text-mint"}`}>{error || success}<button type="button" onClick={() => { setError(""); setSuccess(""); }} className="float-right text-current/70" aria-label="关闭提示"><X size={15} /></button></div>}
  </section>;
}
