import { useEffect, useRef } from "react";
import { Check, CirclePause, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { CREDIT_SCALE, displayCredits } from "../../lib/credits";
import { pptStepPageIndex } from "../../lib/pptGeneration";
import "./pptGeneration.css";

export default function PptGenerationProgress({ generation, live, onReconnect, onResume, onEnd, following, onFollow }) {
  const draft = useRef(null);
  useEffect(() => {
    if (draft.current) draft.current.scrollTop = draft.current.scrollHeight;
  }, [live?.text]);
  if (!generation) return null;
  const { outline, completed, status } = generation;
  const regenerating = generation.mode === "regenerate";
  const motion = generation.mode === "motion";
  const targeted = regenerating || motion;
  const total = targeted ? generation.targets.length : outline?.slides.length;
  const paused = status === "paused";
  const done = status === "done" || status === "ended";
  const index = pptStepPageIndex(generation);
  const stage = outline ? `第 ${index + 1} 页 · ${outline.slides[index]?.title || ""}` : "演示大纲";
  return <div className="ppt-generation">
    {!done && <>
      <div className="ppt-generation-heading" role="status">
        {paused ? <CirclePause size={16}/> : <LoaderCircle size={16} className="ppt-spin"/>}
        <strong>{motion ? (paused ? "动效编排已暂停" : "正在编排动效") : paused ? (generation.originalEdit ? "修改已暂停" : "生成已暂停") : generation.originalEdit ? "正在修改原稿文字" : regenerating ? "正在重新生成" : outline ? "正在生成" : "正在撰写"} · {stage}</strong>
        {total && <span>已保存 {completed} / {total} 页</span>}
      </div>
      {total && <progress aria-label="已保存的页面" value={completed} max={total}/>}
      {paused ? <p role="alert">{generation.error}</p> : live?.notice && <p role="status">{live.notice}</p>}
      {!paused && live?.text && <div ref={draft} className="ppt-live-draft" aria-label="模型正在撰写的内容">{live.text}</div>}
      <div className="ppt-generation-controls">
        {paused && <><button type="button" className="ppt-secondary" onClick={onResume}><Play size={14}/>{motion ? "继续编排" : generation.originalEdit ? "继续修改" : "继续生成"}{outline ? `第 ${index + 1} 页` : "大纲"}</button>
          <button type="button" onClick={onEnd}>{motion ? "结束本次编排" : generation.originalEdit ? "结束本次修改" : "结束本次生成"}</button></>}
        {!paused && live?.reconnect && <button type="button" onClick={onReconnect}><RefreshCw size={14}/>重新连接</button>}
        {!paused && outline && !following && <button type="button" onClick={onFollow}>跟随生成预览</button>}
      </div>
    </>}
    {outline && <details className="ppt-outline"><summary>{motion ? "查看动效编排页" : regenerating ? "查看指定页" : "查看生成大纲"} · {total} 页</summary><ol>
      {(targeted ? generation.targets.map(target => target.index) : outline.slides.map((_, i) => i)).map((page, i) =>
        <li key={page} value={page + 1}><div><strong>{outline.slides[page].title}</strong>{i < completed && <Check size={13} aria-label="已保存"/>}</div><p>{outline.slides[page].brief}</p></li>)}
    </ol></details>}
    {!done && <small>{targeted ? "所选页面按实际 Token 逐页结算。" : "大纲和每页按实际 Token 分步结算。"}已结算 {displayCredits(generation.chargedUnits / CREDIT_SCALE)} 积分。</small>}
  </div>;
}
