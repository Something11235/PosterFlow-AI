import { useId, useRef } from "react";
import { ArrowUpRight, FilePenLine, LoaderCircle, WandSparkles } from "lucide-react";
import { PPT_MODEL_NAMES } from "../../lib/pptProject";
import { pptMotionPendingPages } from "../../lib/pptGeneration";
import "./pptExtensions.css";

export default function PptExtensions({ project, locked, onOpen, onToggle, onPlan, metadataError, metadataLoading, onRetryMetadata }) {
  const picker = useRef(null);
  const helpId = useId();
  const hasPages = Boolean(project.deck?.slides.length);
  const enabled = Boolean(project.motionEnabled);
  const pending = hasPages && enabled && !metadataLoading ? pptMotionPendingPages(project).length : 0;
  const planning = project.generation?.mode === "motion" && project.generation.status === "running";
  const hasPlan = project.deck?.slides.some(slide => slide.motion);
  return <section className="ppt-extensions" aria-label="扩展功能">
    <h2>扩展功能</h2>
    <div className="ppt-extension-grid">
      <button className="ppt-extension ppt-open-original" type="button" disabled={locked}
        aria-label="在已有的PPT上进行修改" onClick={() => picker.current?.click()}>
        <span className="ppt-extension-icon" aria-hidden="true"><FilePenLine size={20}/></span>
        <span><strong>在已有的PPT上<span className="ppt-extension-verb">进行修改</span></strong><small>打开 .pptx，保留原稿版式并修改指定页。</small></span>
        <ArrowUpRight size={18} aria-hidden="true"/>
      </button>
      <input ref={picker} type="file" accept=".pptx" aria-label="选择 PPTX 原稿" hidden disabled={locked}
        onChange={event => { const file = event.target.files[0]; event.target.value = ""; if (file) onOpen(file); }}/>
      <div className={"ppt-extension ppt-motion-extension" + (enabled ? " is-enabled" : "")}>
        <label>
          <span className="ppt-extension-icon" aria-hidden="true"><WandSparkles size={20}/></span>
          <span><strong>AI 添加动效</strong><small id={helpId}>{project.originalPptx ? "保留原有动效，为缺少动效的页面补充编排。" :
            "由 AI 按内容编排元素入场和页面转场。"}</small></span>
          <input type="checkbox" role="switch" aria-label="AI 添加动效" aria-describedby={helpId} checked={enabled}
            disabled={locked} onChange={event => onToggle(event.target.checked)}/>
        </label>
        {enabled && <div className="ppt-motion-details">
          {metadataError ? <><small role="alert">{metadataError}</small><button type="button" className="ppt-secondary" disabled={locked} onClick={onRetryMetadata}>重试读取</button></> :
           metadataLoading ? <small role="status">正在读取原稿动效…</small> :
           !hasPages ? <small>生成时一并编排，按实际 Token 结算。</small> :
           planning ? <small role="status"><LoaderCircle size={14} className="ppt-spin"/>正在为演示稿编排动效…</small> :
           pending ? <><small>{PPT_MODEL_NAMES[project.model]} · 按实际 Token 结算</small>
             <button type="button" className="ppt-secondary" disabled={locked} onClick={onPlan}>为 {pending} 页编排动效</button></> :
           <small>{hasPlan ? "已保存的动效可免费开关，导出后可在 PowerPoint 放映中播放。" : "本稿已有动效，无需补充编排。"}</small>}
        </div>}
      </div>
    </div>
  </section>;
}
