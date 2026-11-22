import { useEffect, useRef, useState } from "react";
import { Check, Megaphone, X } from "lucide-react";
import { claimGuestPopupReceipt, hasPopupReceipt, POPUP_RECEIPT_PREFIX, rememberPopupReceipt } from "../lib/popupReceipts";

function syncReceipt(id, authHeaders) {
  // If the network drops, the next successful list request will return this ID
  // and retry the idempotent receipt. The local click takes effect immediately.
  return fetch(`/api/announcements/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST", headers: authHeaders, credentials: "omit", keepalive: true,
  }).catch(() => {});
}

function PopupDialog({ announcement, onAcknowledge, onDismiss }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  return <dialog ref={dialog} aria-labelledby="popup-announcement-title"
    className="m-auto max-h-[85dvh] w-[min(32rem,calc(100%-2rem))] max-w-none overflow-hidden rounded-xl border border-border-default bg-bg-secondary p-0 text-text-primary shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <div className="flex max-h-[85dvh] flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-accent"><Megaphone size={17} aria-hidden="true" />网站公告</span>
        <button type="button" aria-label="暂时关闭公告" title="暂时关闭公告" onClick={onDismiss}
          className="grid size-11 place-items-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary"><X size={18} /></button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
        <h2 id="popup-announcement-title" tabIndex={-1} autoFocus className="text-lg font-semibold break-words outline-none">{announcement.title}</h2>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-text-secondary">{announcement.content}</p>
      </div>
      <footer className="flex shrink-0 justify-end border-t border-border-subtle px-5 py-3">
        <button type="button" onClick={onAcknowledge} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover">
          <Check size={16} aria-hidden="true" />朕已知晓
        </button>
      </footer>
    </div>
  </dialog>;
}

export default function PopupAnnouncements({ userId, authHeaders }) {
  const [pending, setPending] = useState([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch("/api/announcements/popups", {
          headers: authHeaders, credentials: "omit", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) return;
        const { announcements } = await response.json();
        if (controller.signal.aborted || !Array.isArray(announcements)) return;
        const unread = [];
        for (const item of announcements) {
          if (!item?.id || !item.is_popup) continue;
          if (hasPopupReceipt(userId, item.id) || claimGuestPopupReceipt(userId, item.id)) {
            if (userId) void syncReceipt(item.id, authHeaders);
          } else {
            unread.push(item);
          }
        }
        setPending(unread);
      } catch { /* An unavailable announcement service must not block the site. */ }
      finally { loading = false; }
    };
    const storageChanged = event => {
      if (!event.key?.startsWith(POPUP_RECEIPT_PREFIX)) return;
      setPending(items => items.filter(item => !hasPopupReceipt(userId, item.id)));
    };
    void load();
    window.addEventListener("online", load);
    window.addEventListener("storage", storageChanged);
    return () => {
      controller.abort();
      window.removeEventListener("online", load);
      window.removeEventListener("storage", storageChanged);
    };
  }, [userId, authHeaders, dismissed]);

  const current = pending[0];
  useEffect(() => {
    if (!current?.ends_at || dismissed) return;
    const expiresAt = Date.parse(current.ends_at);
    if (!Number.isFinite(expiresAt)) return;
    let timer;
    function checkExpiry() {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) setPending(items => items.filter(item => item.id !== current.id));
      else timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647));
    }
    checkExpiry();
    return () => clearTimeout(timer);
  }, [current, dismissed]);

  if (!current || dismissed) return null;
  function acknowledge() {
    rememberPopupReceipt(userId, current.id);
    setPending(items => items.filter(item => item.id !== current.id));
    if (userId) void syncReceipt(current.id, authHeaders);
  }
  return <PopupDialog key={current.id} announcement={current} onAcknowledge={acknowledge} onDismiss={() => setDismissed(true)} />;
}
