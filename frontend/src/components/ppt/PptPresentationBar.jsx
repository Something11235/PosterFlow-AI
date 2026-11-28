import { useEffect, useId, useRef, useState } from "react";
import { FilePlus2, FolderOpen, Pencil, Trash2 } from "lucide-react";
import "./pptPageActions.css";
import "./pptPresentationBar.css";

export default function PptPresentationBar({ projects, projectId, currentTitle, locked, onCreate, onRename, onSelect, onDelete }) {
  const [target, setTarget] = useState(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const active = projects.find(entry => entry.id === projectId);
  const confirming = target !== null && target.id === projectId;
  const isDelete = target?.action === "delete";
  const isRename = target?.action === "rename";
  const title = currentTitle || active?.title || "";

  useEffect(() => {
    if (!confirming) return;
    const dialog = dialogRef.current;
    dialog.showModal();
    if (isRename) dialog.querySelector("input")?.select();
    return () => dialog.close();
  }, [confirming, isRename]);

  function open(action) {
    setName(action === "rename" ? title : "");
    setError("");
    setTarget({ action, id: projectId, title });
  }

  async function submit(event) {
    event.preventDefault();
    if (locked || saving) return;
    if (isDelete) {
      setTarget(null);
      onDelete(target.id);
      return;
    }
    const value = name.trim();
    if (isRename && !value) return;
    setSaving(true);
    setError("");
    try {
      const saved = isRename ? await onRename(target.id, value) : await onCreate(value);
      if (saved === false) setError("未能保存，请重试。");
      else setTarget(null);
    } catch (cause) {
      setError(cause?.message || "未能保存，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return <section className="ppt-presentation-bar" aria-label="演示稿管理">
    <label className="ppt-presentation-picker">
      <span><FolderOpen size={16} aria-hidden="true" />当前演示稿</span>
      <select value={projectId || ""} disabled={locked || !active} aria-label="切换演示稿"
        onChange={event => onSelect(event.target.value)}>
        {!active && <option value="">正在加载演示稿…</option>}
        {projects.map(entry => <option key={entry.id} value={entry.id}>
          {(entry.id === projectId && currentTitle) || entry.title}
        </option>)}
      </select>
    </label>
    <div className="ppt-presentation-actions">
      <button type="button" className="ppt-secondary" disabled={locked} onClick={() => open("create")}><FilePlus2 size={16} aria-hidden="true" />新建演示稿</button>
      <button type="button" className="ppt-secondary" disabled={locked || !active} onClick={() => open("rename")}><Pencil size={16} aria-hidden="true" />重命名</button>
      <button type="button" className="ppt-secondary" disabled={locked || !active} onClick={() => open("delete")}><Trash2 size={16} aria-hidden="true" />删除演示稿</button>
    </div>
    {confirming && <dialog className="ppt-page-dialog" ref={dialogRef} aria-labelledby={titleId} aria-describedby={isDelete ? descriptionId : undefined}
      onCancel={event => { event.preventDefault(); if (!saving) setTarget(null); }}>
      <form onSubmit={submit}>
        <h3 id={titleId}>{isDelete ? "删除整份演示稿？" : isRename ? "重命名演示稿" : "新建演示稿"}</h3>
        {isDelete ? <p id={descriptionId}>「{target.title}」的全部幻灯片、参考资料和 AI 对话记录将从本浏览器删除。删除后无法恢复。</p> :
          <label className="ppt-field"><span>演示稿名称{!isRename && "（选填）"}</span>
            <input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={240} required={isRename}
              disabled={saving} placeholder={isRename ? "输入演示稿名称" : "留空将自动命名"} />
          </label>}
        {error && <p role="alert" className="ppt-page-error">{error}</p>}
        <div className="ppt-page-dialog-actions">
          <button type="button" className="ppt-secondary" autoFocus={isDelete} disabled={saving} onClick={() => setTarget(null)}>取消</button>
          <button type="submit" className={isDelete ? "ppt-page-delete" : "ppt-primary"} disabled={locked || saving || (isRename && !name.trim())}>
            {isDelete ? "确认删除演示稿" : isRename ? "保存名称" : "创建演示稿"}
          </button>
        </div>
      </form>
    </dialog>}
  </section>;
}
