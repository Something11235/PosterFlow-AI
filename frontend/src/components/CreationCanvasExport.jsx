import { useEffect, useRef, useState } from "react";
import { Archive, Download, ExternalLink, X } from "lucide-react";
import { saveBrowserFile } from "../lib/browserSave";
import { CANVAS_MEDIA_LABELS, canvasBackupUrl, canvasBatchDownloads, canvasDownloadName, createCanvasArchive, readCanvasDownload, safeCanvasName } from "../lib/creationCanvasDownloads";

export function CanvasDownloadAction({ item, scope }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [backup, setBackup] = useState("");
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => () => { if (backup.startsWith("blob:")) URL.revokeObjectURL(backup); }, [backup]);

  async function download(alternate) {
    if (busy) return;
    setError(""); setBusy(alternate ? "backup" : "primary");
    try {
      if (alternate) {
        const url = await canvasBackupUrl(item, scope);
        if (active.current) setBackup(url);
        else if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      } else {
        await saveBrowserFile(canvasDownloadName(item), () => readCanvasDownload(item, scope));
      }
    } catch (failure) { if (active.current) setError(failure.message || "下载失败，请重试。"); }
    finally { if (active.current) setBusy(""); }
  }
  const link = backup || item.url;
  return <>
    <button type="button" onClick={() => download(false)} disabled={Boolean(busy)}><Download size={14}/>{busy === "primary" ? "正在下载…" : "下载" + CANVAS_MEDIA_LABELS[item.kind]}</button>
    {(item.kind !== "frame" || item.url) && (link
      ? <a className="cc-backup-link" href={link} download={canvasDownloadName(item)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ExternalLink size={14}/>备用下载{backup ? " · 打开文件" : ""}</a>
      : <button type="button" disabled={Boolean(busy)} onClick={() => download(true)}><ExternalLink size={14}/>{busy === "backup" ? "正在准备…" : "备用下载"}</button>)}
    {error && <p className="cc-export-error" role="alert">{error}</p>}
  </>;
}

export default function CreationCanvasExport({ project, scope, onClose }) {
  const [items] = useState(() => canvasBatchDownloads(project));
  const [selected, setSelected] = useState(() => new Set(items.map(item => item.id)));
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    return () => previous?.focus?.({ preventScroll: true });
  }, []);
  async function exportZip() {
    if (progress || !selected.size) return;
    setError(""); setProgress("正在准备…");
    try {
      const result = await saveBrowserFile(safeCanvasName(project.name) + ".zip", () => createCanvasArchive(items.filter(item => selected.has(item.id)), scope,
        (i, count, title) => setProgress("正在导出 " + (i + 1) + "/" + count + " · " + title)));
      if (result !== "cancelled") onClose();
    } catch (failure) { setError(failure.message || "导出失败，请重试。"); }
    finally { setProgress(""); }
  }
  return <dialog className="cc-dialog cc-export-dialog" ref={dialog} aria-label="批量导出" onCancel={e => { e.preventDefault(); if (!progress) onClose(); }}>
    <header><h2>批量导出</h2><button disabled={Boolean(progress)} onClick={onClose} aria-label="关闭导出窗口"><X size={18}/></button></header>
    {items.length ? <><p>选择要打包到 ZIP 的画布素材。</p>
      <div className="cc-export-list">{items.map(item => <label key={item.id}>
        <input type="checkbox" checked={selected.has(item.id)} disabled={Boolean(progress)} onChange={() => setSelected(current => {
          const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;
        })}/><span>{item.title}</span><small>{CANVAS_MEDIA_LABELS[item.kind]}</small>
      </label>)}</div>
      {progress && <p role="status">{progress}</p>}{error && <p role="alert" className="cc-export-error">{error}</p>}
      <footer><button disabled={Boolean(progress)} onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map(item => item.id)))}>{selected.size === items.length ? "取消全选" : "全选"}</button>
        <button className="cc-primary" disabled={!selected.size || Boolean(progress)} onClick={exportZip}><Archive size={15}/>导出 ZIP（{selected.size}）</button></footer>
    </> : <p>画布还没有可导出的文件。添加参考素材、完成生成或提取尾帧后即可导出。</p>}
  </dialog>;
}
