import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PPT_MODEL_NAMES } from "../../lib/pptProject";
import "./pptPageActions.css";

export default function PptRegeneratePages({ project, page, locked, onStart }) {
  const [selection, setSelection] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialog = useRef(null);
  const titleId = useId();
  const original = Boolean(project.originalPptx);
  const dialogTitle = original ? "修改指定页" : "重新生成指定页";
  const supportsPage = slide => !original || slide.elements.some(el => typeof el.originalText === "string");
  const open = Boolean(selection);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [open]);

  function begin() {
    setError(""); setInstruction("");
    setSelection({ deck: project.deck, model: project.model, revision: project.revision, ids: supportsPage(page) ? [page.id] : [] });
  }
  function toggle(id) {
    setSelection(prev => ({ ...prev, ids: prev.ids.includes(id) ? prev.ids.filter(item => item !== id) : [...prev.ids, id] }));
  }
  async function submit(event) {
    event.preventDefault();
    if (!selection.ids.length || locked || saving || (original && !instruction.trim())) return;
    setSaving(true);
    try {
      await onStart(selection, instruction);
      setSelection(null);
    } catch (cause) { setError(cause.message || "未能启动本次生成。"); }
    finally { setSaving(false); }
  }
  const numbers = selection?.deck.slides.flatMap((slide, i) => selection.ids.includes(slide.id) ? [i + 1] : []);
  return <>
    <button type="button" className="ppt-secondary" disabled={locked || !page} onClick={begin}>
      <RefreshCw size={15} aria-hidden="true"/>{dialogTitle}
    </button>
    {selection && <dialog ref={dialog} className="ppt-page-dialog ppt-regenerate-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); if (!saving) setSelection(null); }}>
      <form onSubmit={submit}>
        <h3 id={titleId}>{dialogTitle}</h3>
        <label className="ppt-field ppt-batch-instruction">{original ? "修改要求" : "重做要求（选填）"}<textarea rows={2} maxLength={6000} disabled={saving} required={original}
          placeholder={original ? "写下所选页面的共同要求，例如：根据论文补充研究方法，保留原有术语和数据。" : "写下所选页面的共同要求，例如：保留数据，把文字对比改成图表。"} value={instruction} onChange={event => setInstruction(event.target.value)}/></label>
        <fieldset className="ppt-regenerate-choices" disabled={saving}>
          <legend>{original ? "选择要修改文字的页面" : "选择要替换的页面"}</legend>
          <div>{selection.deck.slides.map((slide, i) => <label key={slide.id}>
            <input type="checkbox" disabled={!supportsPage(slide)} checked={selection.ids.includes(slide.id)} onChange={() => toggle(slide.id)}/>
            <span>第 {i + 1} 页 · {slide.title}{!supportsPage(slide) && "（无可修改文字）"}</span>
          </label>)}</div>
          <button type="button" disabled={!selection.ids.length} onClick={() => setSelection({ ...selection, ids: [] })}>清除选择</button>
        </fieldset>
        <div className="ppt-regenerate-summary"><strong aria-live="polite">{numbers.length > 8 ? `已选中 ${numbers.length} 页` : numbers.length ? (original ? "将修改第 " : "将替换第 ") + numbers.join("、") + " 页" : "请选择至少一页"}</strong>
          <p>{PPT_MODEL_NAMES[selection.model]} 将按页生成，每页按实际 Token 单独结算。其他页面保持原样。</p></div>
        {error && <p role="alert" className="ppt-page-error">{error}</p>}
        <div className="ppt-page-dialog-actions">
          <button type="button" className="ppt-secondary" disabled={saving} onClick={() => setSelection(null)}>取消</button>
          <button type="submit" className="ppt-primary" disabled={locked || saving || !numbers.length || (original && !instruction.trim())}>{original ? "确认修改" : "确认重新生成"}{numbers.length ? `（${numbers.length} 页）` : ""}</button>
        </div>
      </form>
    </dialog>}
  </>;
}
