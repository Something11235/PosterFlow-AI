import React, { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { fetchImageBlob } from "../lib/client";

export default function ImageModal({ filename, onClose, onModify, onDownloadImage, isDownloading = false, authenticated = false, authHeaders }) {
  const [modifyText, setModifyText] = useState("");
  const [assetUrl, setAssetUrl] = useState("");
  const [assetError, setAssetError] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    setAssetUrl("");
    setAssetError("");
    fetchImageBlob(filename, { authenticated, headers: authHeaders, forceRefresh: retryCount > 0 }).then((blob) => {
      if (alive) {
        objectUrl = URL.createObjectURL(blob);
        setAssetUrl(objectUrl);
      }
    }).catch((reason) => { if (alive) setAssetError(reason?.message || "图片暂时无法读取"); });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [authHeaders, authenticated, filename, retryCount]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div role="dialog" aria-modal="true" aria-label="原图预览" className="fixed inset-0 z-50 flex flex-col bg-black/82 backdrop-blur-sm animate-fade-in">
      <div className="flex items-center justify-between border-b border-white/10 bg-bg-primary/72 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-white">原图预览</p>
          <p className="mt-0.5 text-xs text-text-muted">{filename}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-text-secondary transition hover:bg-white/10 hover:text-white"
          aria-label="关闭预览"
        >
          <X size={20} />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-h-0 items-center justify-center rounded-lg border border-white/10 bg-bg-primary/72 p-3">
          {!assetUrl && !assetError && (
            <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 size={18} className="animate-spin" />
              正在加载原图，请稍候…
            </p>
          )}
          {assetError && (
            <div className="flex flex-col items-center gap-4 px-3 text-center">
              <p role="alert" className="text-sm leading-6 text-text-secondary">{assetError}</p>
              <button type="button" onClick={() => setRetryCount(value => value + 1)}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-4 text-sm text-accent transition hover:bg-accent/20">
                <RefreshCw size={16} />重新加载原图
              </button>
            </div>
          )}
          {assetUrl && !assetError && <img
            src={assetUrl}
            alt="生成图片原图预览"
            referrerPolicy="no-referrer"
            className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
            onError={() => setAssetError("图片解码失败，请重新加载原图。")}
          />}
        </div>

        <aside className="flex flex-col rounded-lg border border-white/10 bg-bg-secondary p-4">
          <p className="text-sm font-semibold text-text-primary">审稿操作</p>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            可下载当前原图，也可在迭代模式下输入修改方向继续生成新版。
          </p>

          <button
            type="button"
            onClick={() => onDownloadImage(filename)}
            disabled={isDownloading}
            aria-busy={isDownloading}
            className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-wait disabled:opacity-65"
          >
            {isDownloading ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
            {isDownloading ? "正在读取原图…" : "下载原图"}
          </button>

          {onModify && (
            <div className="mt-5 border-t border-border-subtle pt-5">
              <label htmlFor="modal-modify" className="text-sm font-medium text-text-secondary">
                迭代修改
              </label>
              <textarea
                id="modal-modify"
                value={modifyText}
                onChange={(e) => setModifyText(e.target.value)}
                rows={6}
                placeholder="例如：提升留白，去掉炫光，强化城市天际线和芯片主体。"
                className="mt-2 w-full resize-y rounded-lg border border-border-default bg-bg-primary px-3 py-3 text-sm leading-6 text-text-primary placeholder:text-text-muted focus:border-accent/65"
              />
              <button
                type="button"
                disabled={!modifyText.trim()}
                onClick={() => {
                  onModify(modifyText, filename);
                  onClose();
                }}
                className={`mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition ${
                  modifyText.trim()
                    ? "bg-bg-elevated text-text-primary hover:bg-bg-hover"
                    : "cursor-not-allowed bg-bg-elevated text-text-muted"
                }`}
              >
                <RefreshCw size={17} />
                生成迭代版
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
