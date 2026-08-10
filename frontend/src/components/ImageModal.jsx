import React, { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { apiAssetUrl } from "../lib/client";

export default function ImageModal({ filename, onClose, onModify }) {
  const [modifyText, setModifyText] = useState("");

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
    <div className="fixed inset-0 z-50 flex flex-col bg-black/82 backdrop-blur-sm animate-fade-in">
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
          <img
            src={apiAssetUrl("images", filename)}
            alt="生成图片原图预览"
            className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
          />
        </div>

        <aside className="flex flex-col rounded-lg border border-white/10 bg-bg-secondary p-4">
          <p className="text-sm font-semibold text-text-primary">审稿操作</p>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            可下载当前原图，也可在迭代模式下输入修改方向继续生成新版。
          </p>

          <a
            href={apiAssetUrl("download", filename)}
            download
            className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover"
          >
            <Download size={17} />
            下载原图
          </a>

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
