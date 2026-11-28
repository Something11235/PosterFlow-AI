import { useEffect, useId, useRef, useState } from "react";
import { FilePlus2, Trash2 } from "lucide-react";
import { insertPptPage, removePptPage } from "../../lib/pptPageActions";
import "./pptPageActions.css";

export default function PptPageActions({ page, count, maxPages = 16, locked, patch, onSelectPage, onError }) {
  const [action, setAction] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const titleId = useId();
  const adding = action?.type === "add";

  useEffect(() => {
    if (!action) return;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, [action]);

  function open(type) {
    setError("");
    setAction({ type, page });
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || locked) return;
    const data = new FormData(event.currentTarget);
    const id = adding ? crypto.randomUUID() : null;
    let nextIndex;
    setSaving(true);
    try {
      await patch(current => {
        if (adding) {
          const next = insertPptPage(current, action.page, {
            id, title: String(data.get("title") || ""), body: String(data.get("body") || ""),
          }, maxPages);
          nextIndex = next.deck.slides.findIndex(slide => slide.id === id);
          return next;
        }
        const next = removePptPage(current, action.page);
        const removedIndex = current.deck.slides.findIndex(slide => slide.id === action.page.id);
        nextIndex = Math.max(0, Math.min(removedIndex, (next.deck?.slides.length || 0) - 1));
        return next;
      });
      onSelectPage(nextIndex);
      onError?.("");
      setAction(null);
    } catch (cause) {
      setError(cause.message || "页面未能保存，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return <div className="ppt-page-actions">
    <button type="button" className="ppt-page-action" onClick={() => open("add")} disabled={locked || count >= maxPages}
      title={count >= maxPages ? `已达到 ${maxPages} 页上限` : page ? "在当前页后新建一页" : "新建第一页"}>
      <FilePlus2 size={15} aria-hidden="true" />新建页
    </button>
    {page && <button type="button" className="ppt-page-action" disabled={locked} onClick={() => open("delete")}><Trash2 size={15} aria-hidden="true" />删除页</button>}
    {action && <dialog ref={dialogRef} className="ppt-page-dialog" aria-labelledby={titleId} onCancel={event => {
      event.preventDefault();
      if (!saving) setAction(null);
    }}>
      <form onSubmit={submit}>
        <h3 id={titleId}>{adding ? "新建幻灯片" : "删除当前页？"}</h3>
        {adding ? <>
          <label className="ppt-field"><span>页标题</span><input autoFocus name="title" maxLength={240} placeholder="新幻灯片" /></label>
          <label className="ppt-field"><span>正文（选填）</span><textarea name="body" rows={3} maxLength={6000} /></label>
        </> : <p>将从演示稿中移除「{action.page.title}」。</p>}
        {error && <p role="alert" className="ppt-page-error">{error}</p>}
        <div className="ppt-page-dialog-actions">
          <button type="button" className="ppt-secondary" autoFocus={!adding} disabled={saving} onClick={() => setAction(null)}>取消</button>
          <button type="submit" className={adding ? "ppt-primary" : "ppt-page-delete"} disabled={locked || saving}>{adding ? "新建此页" : "确认删除此页"}</button>
        </div>
      </form>
    </dialog>}
  </div>;
}
