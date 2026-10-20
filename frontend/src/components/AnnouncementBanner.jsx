import React, { useEffect, useState } from "react";
import { Bell, ChevronRight, Megaphone, X } from "lucide-react";
import { announcementVersion, browserStorage, CLOSED_KEY, HIDDEN_KEY, readVersions, rememberVersions } from "../lib/announcementVisibility";

const TYPE_META = {
  info: { label: "通知", className: "border-accent/30 bg-accent/8 text-accent" },
  important: { label: "重要", className: "border-gold/35 bg-gold/10 text-gold" },
  maintenance: { label: "维护", className: "border-mint/30 bg-mint/8 text-mint" },
};

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [hidden, setHidden] = useState(() => readVersions(browserStorage("localStorage"), HIDDEN_KEY));
  const [closed, setClosed] = useState(() => readVersions(browserStorage("sessionStorage"), CLOSED_KEY));

  useEffect(() => {
    let alive = true;
    let active = null, lastRead = 0;
    const load = async () => {
      if (document.visibilityState === "hidden" || active || Date.now() - lastRead < 30000) return;
      const controller = new AbortController(); active = controller; lastRead = Date.now();
      try {
        const response = await fetch("/api/announcements?limit=20", { signal: controller.signal });
        const data = await response.json();
        if (alive && response.ok && Array.isArray(data.announcements)) setAnnouncements(data.announcements);
      } catch { /* An optional notice must never block the workspace. */ }
      finally { if (active === controller) active = null; }
    };
    const syncHidden = event => { if (event.key === HIDDEN_KEY || event.key === null) setHidden(readVersions(browserStorage("localStorage"), HIDDEN_KEY)); };
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("storage", syncHidden);
    return () => { alive = false; active?.abort(); window.removeEventListener("focus", load); document.removeEventListener("visibilitychange", load); window.removeEventListener("storage", syncHidden); };
  }, []);

  const visible = announcements.filter(item => !hidden.includes(announcementVersion(item)) && !closed.includes(announcementVersion(item)));
  const selectedItem = selected ? visible.find(item => item.id === selected.id) : null;
  const hideItem = item => {
    setHidden(current => rememberVersions(browserStorage("localStorage"), HIDDEN_KEY, current, [announcementVersion(item)]));
    setSelected(null);
  };
  if (!visible.length) return null;
  const primary = visible[0];
  const meta = TYPE_META[primary.announcement_type] || TYPE_META.info;

  return (
    <>
      <section className="border-b border-border-subtle bg-bg-secondary/80 px-4 py-2.5 lg:px-6" aria-label="系统公告">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3">
          <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border ${meta.className}`}><Megaphone size={15} /></div>
          <span className={`hidden rounded-md border px-2 py-1 text-[11px] font-medium sm:inline-flex ${meta.className}`}>{meta.label}</span>
          <button type="button" onClick={() => setSelected(primary)} className="min-w-0 flex-1 truncate text-left text-sm text-text-secondary hover:text-text-primary">
            <span className="font-medium text-text-primary">{primary.title}</span><span className="mx-2 text-text-muted">·</span>{primary.content.replace(/\s+/g, " ")}
          </button>
          <button type="button" onClick={() => (visible.length > 1 ? setShowAll(true) : setSelected(primary))} className="hidden min-h-9 items-center gap-1 rounded-md px-2 text-xs text-text-muted hover:bg-bg-elevated hover:text-text-primary sm:inline-flex">
            {visible.length > 1 ? `查看全部（${visible.length}）` : "查看详情"}<ChevronRight size={14} />
          </button>
          <button type="button" onClick={() => hideItem(primary)} className="hidden min-h-9 shrink-0 rounded-md px-2 text-xs text-text-muted hover:bg-bg-elevated hover:text-text-primary sm:inline-flex sm:items-center">本条不再显示</button>
          <button type="button" onClick={() => setClosed(current => rememberVersions(browserStorage("sessionStorage"), CLOSED_KEY, current, visible.map(announcementVersion)))} className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="暂时关闭当前公告"><X size={16} /></button>
        </div>
      </section>

      {(selectedItem || showAll) && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="announcement-dialog-title">
          <div className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl border border-border-default bg-bg-secondary shadow-2xl sm:rounded-xl">
            <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4"><div className="flex items-center gap-2"><Bell size={17} className="text-accent" /><h2 id="announcement-dialog-title" className="text-base font-semibold text-text-primary">系统公告</h2></div><button type="button" onClick={() => { setSelected(null); setShowAll(false); }} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭公告"><X size={18} /></button></div>
            <div className="min-h-0 space-y-3 overflow-y-auto p-5">
              {(showAll ? visible : [selectedItem]).filter(Boolean).map((item) => {
                const itemMeta = TYPE_META[item.announcement_type] || TYPE_META.info;
                return <article key={item.id} className="rounded-lg border border-border-subtle bg-bg-tertiary p-4"><div className="flex flex-wrap items-start gap-2"><h3 className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{item.title}</h3><span className={`rounded-md border px-2 py-0.5 text-[11px] ${itemMeta.className}`}>{itemMeta.label}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-secondary">{item.content}</p><p className="mt-3 text-xs text-text-muted">{formatDate(item.published_at || item.created_at)}（北京时间）{item.is_pinned ? " · 置顶公告" : ""}</p><div className="mt-3 border-t border-border-subtle pt-3"><button type="button" onClick={() => hideItem(item)} className="min-h-11 rounded-md border border-border-default px-3 text-xs text-text-secondary hover:bg-bg-elevated">本条公告不再显示</button><p className="mt-2 text-xs leading-5 text-text-muted">仅在当前浏览器记住此选择。新公告或本条公告更新后仍会显示。</p></div></article>;
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
