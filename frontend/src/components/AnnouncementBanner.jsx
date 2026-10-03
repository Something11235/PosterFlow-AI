import React, { useEffect, useState } from "react";
import { Bell, ChevronRight, Megaphone, X } from "lucide-react";

const TYPE_META = {
  info: { label: "通知", className: "border-accent/30 bg-accent/8 text-accent" },
  important: { label: "重要", className: "border-gold/35 bg-gold/10 text-gold" },
  maintenance: { label: "维护", className: "border-mint/30 bg-mint/8 text-mint" },
};

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem("posterflow-announcement-dismissed") === "1");

  useEffect(() => {
    let alive = true;
    fetch("/api/announcements?limit=20")
      .then((response) => response.json())
      .then((data) => {
        if (alive && Array.isArray(data.announcements)) setAnnouncements(data.announcements);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!announcements.length || dismissed) return null;
  const primary = announcements[0];
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
          <button type="button" onClick={() => (announcements.length > 1 ? setShowAll(true) : setSelected(primary))} className="hidden min-h-9 items-center gap-1 rounded-md px-2 text-xs text-text-muted hover:bg-bg-elevated hover:text-text-primary sm:inline-flex">
            {announcements.length > 1 ? `查看全部（${announcements.length}）` : "查看详情"}<ChevronRight size={14} />
          </button>
          <button type="button" onClick={() => { setDismissed(true); sessionStorage.setItem("posterflow-announcement-dismissed", "1"); }} className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="暂时关闭公告"><X size={16} /></button>
        </div>
      </section>

      {(selected || showAll) && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="announcement-dialog-title">
          <div className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl border border-border-default bg-bg-secondary shadow-2xl sm:rounded-xl">
            <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4"><div className="flex items-center gap-2"><Bell size={17} className="text-accent" /><h2 id="announcement-dialog-title" className="text-base font-semibold text-text-primary">系统公告</h2></div><button type="button" onClick={() => { setSelected(null); setShowAll(false); }} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭公告"><X size={18} /></button></div>
            <div className="min-h-0 space-y-3 overflow-y-auto p-5">
              {(showAll ? announcements : [selected]).filter(Boolean).map((item) => {
                const itemMeta = TYPE_META[item.announcement_type] || TYPE_META.info;
                return <article key={item.id} className="rounded-lg border border-border-subtle bg-bg-tertiary p-4"><div className="flex flex-wrap items-start gap-2"><h3 className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{item.title}</h3><span className={`rounded-md border px-2 py-0.5 text-[11px] ${itemMeta.className}`}>{itemMeta.label}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-secondary">{item.content}</p><p className="mt-3 text-xs text-text-muted">{formatDate(item.published_at || item.created_at)}{item.is_pinned ? " · 置顶公告" : ""}</p></article>;
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
