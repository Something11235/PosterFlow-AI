import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Aperture, ArrowRight, CircleAlert, Film, LoaderCircle, MoreHorizontal, Play,
  Plus, ScanLine, Type, X } from "lucide-react";
import { getCanvasAsset } from "../lib/creationCanvasProject";
import { CANVAS_NODE_TYPES } from "./creationCanvasLayout";
import { CANVAS_ICONS } from "./creationCanvasIcons";
import CanvasNodeParameters from "./CanvasNodeParameters";
import CanvasReferenceContent from "./CanvasReferenceContent";
import ReferenceUploadProgress from "./ReferenceUploadProgress";

function useNodeMedia(owner, projectId, node) {
  const asset = node.run ? node.run.assetId : node.assetId;
  const remote = node.run?.url || node.url || "";
  const [local, setLocal] = useState(null);
  useEffect(() => {
    if (!asset) return;
    let disposed = false;
    let url;
    getCanvasAsset(owner, projectId, asset).then(blob => {
      if (!blob || disposed) return;
      url = URL.createObjectURL(blob);
      setLocal({ asset, url });
    }).catch(() => {});
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [asset, owner, projectId]);
  if (asset && local?.asset === asset) return local.url;
  return remote.startsWith("https://") ? remote : "";
}

export default function CreationCanvasCard({
  node, projectId, owner, position, selected, connectSource, list, quote, inputs, outgoing, staleFrame, menuOpen,
  onSelect, onConnectStart, onConnectEnd, onRun, onCancel, onUpload, onExtract, onNextShot, onText, onMenu, onModelChange, onParamChange,
}) {
  const Icon = CANVAS_ICONS[node.type];
  const spec = CANVAS_NODE_TYPES[node.type];
  const media = useNodeMedia(owner, projectId, node);
  const [badMedia, setBadMedia] = useState(null);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState(node.text || "");
  const field = useRef(null);
  const uploader = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const isGeneration = node.type === "image" || node.type === "video";
  const isPending = node.run?.status === "pending";
  const isPreparing = isPending && node.run.phase === "preparing";
  const isFailed = node.run?.status === "failed";
  const hasMedia = Boolean(media && media !== badMedia);
  const hasOutput = Boolean((node.run ? node.run.status === "completed" : true) && (node.assetId || media));
  useEffect(() => {
    if (document.activeElement !== field.current) setDraft(node.text || "");
  }, [node.text]);
  const act = async action => {
    if (working) return;
    setWorking(true);
    try { await action(); } finally { setWorking(false); }
  };
  const cost = quote?.billingMode === "own_key" ? "自带 Key" : Number.isFinite(quote?.credits)
    ? `预计 ${quote.credits} 积分${node.type === "image" ? " / 张" : ""}` : "";
  const reservation = quote?.reservedCredits > quote?.credits ? `预留 ${quote.reservedCredits} 积分` : "";
  const runLabel = isPending ? "查询原任务" : quote?.needsDuration ? "读取时长" : hasOutput ? "重新生成" : node.type === "image" ? "生成图片" : "生成视频";
  const canReceive = !["reference", "prompt"].includes(node.type);
  const stateText = isPending ? "待确认" : isFailed ? "未完成" : hasOutput ? "已就绪" : "";
  const displayMedia = <>{node.type === "video"
    ? <video src={media} controls playsInline preload="metadata" onError={() => setBadMedia(media)} aria-label={node.title} />
    : <button className="cc-media-preview" title="放大图片" onClick={() => setExpanded(true)}><img src={media} draggable={false} alt={node.title} onError={() => setBadMedia(media)} /></button>}</>;
  const outputPort = <button type="button" className={`cc-port cc-out ${connectSource === node.id ? "cc-armed" : ""}`}
    data-output-port={node.id} aria-label={`从${node.title}输出`} aria-pressed={connectSource === node.id}
    onClick={event => { if (list || event.detail === 0) onConnectStart(node.id); }}>{list ? <>输出<ArrowRight size={12} /></> : <i />}</button>;
  const inputPort = canReceive && <button className={`cc-port cc-in ${connectSource && connectSource !== node.id ? "cc-available" : ""}`}
    data-input-port={node.id} aria-label={`连接到${node.title}输入`} onClick={() => onConnectEnd(node.id)}>
    {list ? <><Plus size={12} />输入</> : <i />}</button>;
  return <article className={`cc-node cc-kind-${node.type}${selected ? " cc-selected" : ""}`}
    style={{ "--cc-node-color": spec.color, ...(list ? {} : { left: position.x, top: position.y }) }}
    data-node-id={node.id} data-canvas-node-type={node.type} aria-label={node.title} onPointerDown={() => onSelect(node.id)}>
    <header className="cc-node-header" data-node-handle={node.id} tabIndex={list ? undefined : 0}
      role="group" aria-label={`${node.title}节点位置`} aria-description={list ? undefined : "可拖动，或按方向键移动，按住 Shift 可加快"}
      title={list ? undefined : "拖动节点，或聚焦后用方向键移动"}>
      <div className="cc-node-icon"><Icon size={15} /></div>
      <h3>{node.title}</h3>
      <button className="cc-more" aria-expanded={menuOpen} aria-label={`${node.title}节点操作`} onClick={() => onMenu(node.id)}><MoreHorizontal size={17} /></button>
    </header>
    <div className="cc-node-contents">
      {node.type === "prompt" ? <textarea ref={field} aria-label="节点提示词" placeholder="描述画面、角色与镜头…" maxLength={6000} value={draft}
        onChange={e => { setDraft(e.target.value); onText(node.id, e.target.value); }} />
      : node.type === "reference" ? <CanvasReferenceContent node={node} media={media} hasMedia={hasMedia} uploader={uploader} working={working}
        onUpload={file => act(() => onUpload(node.id, file))} onExpand={() => setExpanded(true)} onMediaError={() => setBadMedia(media)} />
      : quote?.upload ? <div className="cc-upload-progress"><ReferenceUploadProgress progress={quote.upload} /></div>
      : hasMedia && !staleFrame ? displayMedia : <div className={`cc-placeholder cc-placeholder-${node.type}`}>
        {isPending || working ? <LoaderCircle className="cc-spin" size={21} /> : isFailed ? <CircleAlert size={21} /> : node.type === "video" ? <Film size={24} /> : node.type === "frame" ? <ScanLine size={25} /> : <Aperture size={24} />}
        <span>{staleFrame ? "视频已变化，请重新取帧" : badMedia && badMedia === media ? "素材暂时无法预览" : isPreparing ? "准备素材中" : isPending ? "等待原任务结果" : isFailed ? node.run?.message || "生成未完成" : node.type === "video" ? "视频预览" : node.type === "image" ? "分镜预览" : "视频末帧"}</span>
      </div>}
    </div>
    {isGeneration && quote && <div className="cc-node-model">
      <select aria-label={`${node.title}的模型`} title={quote.model} value={quote.model || ""} disabled={isPending || working || !quote.options.length}
        onChange={event => onModelChange(node.id, event.target.value)}>
        {!quote.options.some(option => option.value === quote.model) && <option value={quote.model || ""}>{quote.model || "请选择模型"}</option>}
        {quote.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>}
    {isGeneration && quote && <CanvasNodeParameters title={node.title} quote={quote} disabled={isPending || working}
      onChange={(key, value) => onParamChange(node.id, quote.model, key, value)} />}
    <footer className="cc-node-footer">
      {node.type === "prompt" ? <><span><Type size={12}/>文字</span><span>{draft.length} / 6000</span></>
      : node.type === "reference" ? <><span title={node.filename}>{node.filename || "参考素材"}</span><button onClick={() => uploader.current?.click()}>{hasMedia ? "替换" : "选择"}</button></>
      : isGeneration ? <><span title={quote?.error || [cost, reservation, quote?.model].filter(Boolean).join(" · ")}>{quote?.error || reservation || cost || (quote?.needsDuration ? "待核对报价" : stateText)}</span>{isPreparing ? <button className="cc-run"
        onClick={() => onCancel(node.id,node.run.requestId)}><X size={12}/>取消准备</button> : <button className="cc-run" disabled={working || Boolean(quote?.error && !isPending)}
        onClick={() => act(() => onRun(node.id, node.run?.requestId || null, quote))}>{working ? <LoaderCircle className="cc-spin" size={12}/> : <Play size={11} fill="currentColor" />}{runLabel}</button>}</>
      : <><button className="cc-run" disabled={working} onClick={() => act(() => onExtract(node.id))}>{working ? <LoaderCircle className="cc-spin" size={12}/> : <ScanLine size={12}/>}{hasOutput ? "重新取帧" : "提取尾帧"}</button>
        {hasOutput && <button onClick={() => onNextShot(node)}>接下一镜<ArrowRight size={12} /></button>}</>}
    </footer>
    {!list && <>{inputPort}{outputPort}</>}
    {list && <div className="cc-list-ports">{inputPort}<span>{inputs.length ? `输入 ${inputs.length}` : ""}{outgoing ? ` · 输出 ${outgoing}` : ""}</span>{outputPort}</div>}
    {expanded && createPortal(<div className="cc-image-scrim" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setExpanded(false)} onKeyDown={e => { if (e.key === "Escape") setExpanded(false); }}>
      <button autoFocus onClick={() => setExpanded(false)} aria-label="关闭预览"><X size={18} /></button><img alt={node.title} src={media} /></div>, document.body)}
  </article>;
}
