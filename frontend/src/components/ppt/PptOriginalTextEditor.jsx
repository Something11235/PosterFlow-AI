import { useEffect, useId, useRef, useState } from "react";
import { Pencil } from "lucide-react";

export default function PptOriginalTextEditor({ page, element, locked, patch }) {
  const dialog = useRef(null);
  const label = useId();
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const open = Boolean(edit);
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, [open]);
  if (typeof element?.originalText !== "string") return null;
  async function save(event) {
    event.preventDefault();
    if (locked || saving) return;
    const text = new FormData(event.currentTarget).get("text");
    setSaving(true);
    try {
      await patch(current => {
        const currentPage = current.deck?.slides.find(s => s.id === edit.pageId);
        const target = currentPage?.elements.find(el => el.id === edit.id);
        if (current.pending || current.generation?.status === "paused" || target?.text !== edit.text || typeof target?.originalText !== "string") {
          throw new Error("这段文字或任务状态已更新，请取消后重新打开。");
        }
        if (text === edit.text) return current;
        const changed = { ...currentPage, elements: currentPage.elements.map(el => el === target ? { ...el, text } : el) };
        if (currentPage.originalTitleId === target.id) changed.title = text.trim().slice(0,240) || currentPage.title;
        return { ...current, deck: { ...current.deck, slides: current.deck.slides.map(s => s === currentPage ? changed : s) } };
      });
      setEdit(null);
    } catch (cause) { setError(cause.message || "文字未能保存，请重试。"); }
    finally { setSaving(false); }
  }
  return <>
    <button type="button" className="ppt-secondary" disabled={locked} onClick={() => {
      setError(""); setEdit({ pageId: page.id, id: element.id, text: element.text });
    }}><Pencil size={15}/>手动编辑文字</button>
    {edit && <dialog className="ppt-page-dialog" ref={dialog} aria-labelledby={label} onCancel={event => { event.preventDefault(); if (!saving) setEdit(null); }}>
      <form onSubmit={save}><h3 id={label}>手动编辑文字</h3>
        <label className="ppt-field">文字内容<textarea autoFocus rows={6} name="text" defaultValue={edit.text} disabled={saving}/></label>
        {error && <p role="alert">{error}</p>}
        <div className="ppt-page-dialog-actions"><button type="button" className="ppt-secondary" disabled={saving} onClick={() => setEdit(null)}>取消</button>
          <button type="submit" className="ppt-primary" disabled={saving || locked}>保存文字</button></div>
      </form>
    </dialog>}
  </>;
}
