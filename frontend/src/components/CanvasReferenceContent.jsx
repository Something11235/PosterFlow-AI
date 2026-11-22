import { FileText, Music2, Upload } from "lucide-react";
import { CANVAS_REFERENCE_ACCEPT, canvasInputInfo } from "../lib/creationCanvasMedia";

export default function CanvasReferenceContent({
  node, media, hasMedia, uploader, working, onUpload, onExpand, onMediaError,
}) {
  const { kind, name, duration_ms } = canvasInputInfo(node);
  const previewFailed = () => onMediaError?.(media);
  const seconds = duration_ms ? Number((duration_ms / 1000).toFixed(2)) : null;
  let preview;
  if (hasMedia && kind === "image") {
    preview = <button type="button" className="cc-media-preview" title="放大图片" onClick={() => onExpand?.()}>
      <img src={media} alt={name} draggable={false} onError={previewFailed} />
    </button>;
  } else if (hasMedia && kind === "video") {
    preview = <video controls playsInline preload="metadata" src={media} aria-label={name} onError={previewFailed} />;
  } else if (hasMedia && kind === "audio") {
    preview = <div className="cc-placeholder"><Music2 size={18} aria-hidden="true" />
      <audio controls preload="metadata" src={media} style={{ width: "100%", minWidth: 0 }} aria-label={name} onError={previewFailed} />
    </div>;
  } else if (node.assetId && kind === "document") {
    // Display the attachment without embedding user-provided documents.
    preview = <div className="cc-placeholder"><FileText size={22} aria-hidden="true" /><span>{name}</span></div>;
  } else {
    const label = working ? "正在保存素材…" : node.assetId ? "素材已保存，点击更换" : "上传参考素材";
    preview = <button type="button" className="cc-ref-upload" disabled={working} onClick={() => uploader.current?.click()}>
      <Upload size={20} aria-hidden="true" /><span>{label}</span>
      {seconds !== null && <small>{seconds} 秒</small>}
    </button>;
  }
  return <>
    <input ref={uploader} type="file" accept={CANVAS_REFERENCE_ACCEPT} hidden aria-label="选择参考素材" disabled={working}
      onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void onUpload(file);
      }} />
    {preview}
  </>;
}
