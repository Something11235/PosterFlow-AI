import React, { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { canvasTextReceipt } from "../lib/creationCanvasText";

const modes = { draft: "助写", polish: "润色", complete: "补全" };

export default function CanvasPromptWriter({ nodeId, project, quote, configured, routeLabel, onStart, onApply, onDismiss, onClose }) {
  const dialog = useRef(null);
  const node = project.nodes.find(item => item.id === nodeId);
  const destinations = project.edges.filter(edge => edge.from === nodeId).map(edge => project.nodes.find(item => item.id === edge.to));
  const [kind, setKind] = useState(destinations.some(item => item?.type === "video") ? "video" : "image");
  const [action, setAction] = useState(node?.text?.trim() ? "polish" : "draft");
  const [context, setContext] = useState("");
  const text = node?.text || "";
  const candidate = project.textProposal?.input.nodeId === nodeId ? project.textProposal : null;
  const receipt = candidate && canvasTextReceipt(candidate);
  const busy = Boolean(project.textRequest || project.textProposal);
  const changed = candidate && candidate.input.text !== text;
  const target = destinations.find(item => item?.type === kind);
  useEffect(() => { if (!dialog.current.open) dialog.current.showModal(); }, []);
  return <dialog className="cc-dialog cc-prompt-writer" ref={dialog} aria-labelledby="cc-writer-title" onCancel={onClose}
    onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <header><h2 id="cc-writer-title"><Sparkles size={17}/> 提示词助手</h2><button aria-label="关闭提示词助手" onClick={onClose}><X size={16}/></button></header>
    {candidate ? <>
      <label>当前提示词<textarea readOnly value={text} rows={2}/></label>
      <label>AI 建议<textarea readOnly value={candidate.text} rows={7}/></label>
      {receipt && <small>{receipt}</small>}
      {changed && <p>原提示词已经修改。你可以复制建议中的内容，或保留当前提示词。</p>}
      <footer><button onClick={onDismiss}>放弃建议</button><button className="cc-primary" disabled={!node || changed} onClick={() => onApply(current => {
        const latest = current.nodes.find(item => item.id === nodeId);
        if (!latest || (latest.text || "") !== candidate.input.text) throw new Error("提示词已变化，请重新查看。");
        return { ...current, nodes: current.nodes.map(item => item.id === nodeId ? { ...item, text: candidate.text } : item) };
      })}>采用建议</button></footer>
    </> : <>
      <div className="cc-writer-options"><label>写作用途<select value={kind} onChange={e => setKind(e.target.value)}><option value="image">图片</option><option value="video">视频</option></select></label>
        <label>处理方式<select value={action} onChange={e => setAction(e.target.value)}>{Object.entries(modes).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      {text && <label>当前提示词<textarea readOnly value={text} rows={3}/></label>}
      <label>创作要求<textarea rows={3} maxLength={6000} value={context} onChange={e => setContext(e.target.value)} placeholder="例如，保留人物的红围巾，补全夜雨中的灯光和运镜"/></label>
      {routeLabel && <small>{routeLabel}</small>}
      <p role="status">{project.textRequest ? "AI 正在处理，刷新后可继续查看。" : project.textProposal ? "请先处理项目中已有的 AI 建议。" : configured === false ? "AI 文字服务等待开通。" : project.textError || "文本按实际 Token 扣积分。建议可预览后采纳。"}</p>
      <footer><button onClick={onClose}>关闭</button><button className="cc-primary" disabled={!node || configured === false || busy || !(text.trim() || (action === "draft" && context.trim()))}
        onClick={() => onStart({ action, kind, text, context, nodeId, target_model: target ? quote(target).model : "" })}><Sparkles size={14}/>生成建议</button></footer>
    </>}
  </dialog>;
}
