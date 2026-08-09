import React, { useCallback, useEffect, useState } from "react";
import { Clock3, Search, Trash2, X } from "lucide-react";

const API_BASE = "/api";

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function History({ onClose, onLoadEntry }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  const fetchHistory = useCallback(async (nextPage = 0, keyword = "") => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/history?page=${nextPage}&page_size=20&search=${encodeURIComponent(keyword)}`);
      const data = await res.json();
      setEntries((prev) => (nextPage === 0 ? data.history || [] : [...prev, ...(data.history || [])]));
      setHasMore(data.has_more);
      setTotal(data.total);
      setPage(nextPage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => fetchHistory(0, search), 180);
    return () => window.clearTimeout(timer);
  }, [fetchHistory, search]);

  const handleDelete = async (id) => {
    await fetch(`${API_BASE}/history/${id}`, { method: "DELETE" });
    fetchHistory(0, search);
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[380px] flex-col border-l border-border-subtle bg-bg-secondary shadow-2xl animate-slide-in lg:relative lg:z-auto lg:w-[344px] lg:max-w-none">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <Clock3 size={17} className="text-accent" />
          <div>
            <p className="text-sm font-semibold text-text-primary">历史记录</p>
            <p className="text-xs text-text-muted">{total} 条生成任务</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
          aria-label="关闭历史记录"
        >
          <X size={18} />
        </button>
      </div>

      <div className="border-b border-border-subtle p-3">
        <label className="relative block">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索提示词或风格"
            className="min-h-11 w-full rounded-lg border border-border-subtle bg-bg-primary pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/60"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && entries.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-text-muted">正在读取历史...</div>
        )}

        {!loading && entries.length === 0 && (
          <div className="px-4 py-8 text-center">
            <Clock3 size={28} className="mx-auto text-text-muted" />
            <p className="mt-3 text-sm font-medium text-text-secondary">暂无历史记录</p>
            <p className="mt-1 text-xs text-text-muted">生成图片后会自动保存到这里。</p>
          </div>
        )}

        {entries.map((entry) => (
          <article
            key={entry.id}
            className="group border-b border-border-subtle p-3 transition hover:bg-bg-tertiary/65"
          >
            <button type="button" onClick={() => onLoadEntry(entry)} className="block w-full text-left">
              <p className="line-clamp-3 text-sm leading-6 text-text-primary">{entry.prompt}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-muted">{formatTime(entry.timestamp)}</span>
                {entry.style && (
                  <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                    {entry.style}
                  </span>
                )}
                <span className="text-xs text-text-muted">{entry.count} 张</span>
              </div>
            </button>

            {entry.images?.length > 0 && (
              <div className="mt-3 flex gap-2">
                {entry.images.slice(0, 4).map((filename) => (
                  <div key={filename} className="h-14 w-16 overflow-hidden rounded-md border border-border-subtle bg-bg-primary">
                    <img src={`${API_BASE}/images/${filename}`} alt="" className="h-full w-full object-cover" loading="lazy" />
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => handleDelete(entry.id)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted opacity-100 transition hover:bg-bg-elevated hover:text-error lg:opacity-0 lg:group-hover:opacity-100"
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </article>
        ))}

        {hasMore && (
          <button
            type="button"
            onClick={() => fetchHistory(page + 1, search)}
            className="min-h-11 w-full text-sm text-text-muted transition hover:bg-bg-tertiary hover:text-text-secondary"
          >
            加载更多
          </button>
        )}
      </div>
    </aside>
  );
}
