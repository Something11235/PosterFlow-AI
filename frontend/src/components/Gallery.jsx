import React, { useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Expand,
  ImagePlus,
  Loader2,
  Maximize2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const API_BASE = "/api";

export default function Gallery({
  images,
  isGenerating,
  error,
  currentPrompt,
  mode,
  selectedCount,
  onPreview,
  onModify,
  selectedImages,
  onSelectImage,
  onSelectAll,
  onClearSelection,
  onDownloadBatch,
  onCopyPrompt,
  onRetry,
  providerModel,
  presetName,
  presetCategory,
}) {
  const [modifyTarget, setModifyTarget] = useState(null);
  const [modifyText, setModifyText] = useState("");

  const hasImages = images.length > 0;

  return (
    <div className="surface flex h-full min-h-0 flex-col rounded-lg">
      <div className="flex flex-col gap-3 border-b border-border-subtle px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ImagePlus size={17} className="text-accent" />
            生成画廊
            {hasImages && (
              <span className="rounded-md bg-bg-elevated px-2 py-0.5 text-xs font-medium text-text-muted">
                {images.length} 张
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-text-muted">
            {currentPrompt ? currentPrompt : "等待创建第一组图片视觉。"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(currentPrompt || hasImages) && (
            <button
              type="button"
              onClick={onCopyPrompt}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border-subtle px-3 text-xs text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"
            >
              <Copy size={14} />
              复制提示词
            </button>
          )}
          {hasImages && (
            <>
              <button
                type="button"
                onClick={selectedCount === images.length ? onClearSelection : onSelectAll}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border-subtle px-3 text-xs text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"
              >
                <Check size={14} />
                {selectedCount === images.length ? "取消选择" : "全选"}
              </button>
              <button
                type="button"
                onClick={onDownloadBatch}
                disabled={selectedCount === 0}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition ${
                  selectedCount === 0
                    ? "cursor-not-allowed bg-bg-elevated text-text-muted"
                    : "bg-accent text-white hover:bg-accent-hover"
                }`}
              >
                <Download size={14} />
                批量导出
              </button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isGenerating && <LoadingState />}
        {!isGenerating && error && <ErrorState error={error} onRetry={onRetry} />}
        {!isGenerating && !error && !hasImages && <EmptyState mode={mode} presetName={presetName} presetCategory={presetCategory} />}
        {!isGenerating && !error && hasImages && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {images.map((img, index) => {
              const selected = selectedImages.has(img.filename);
              return (
                <article
                  key={img.filename}
                  className={`group overflow-hidden rounded-lg border bg-bg-tertiary transition ${
                    selected ? "border-accent/65 shadow-lg shadow-accent/10" : "border-border-subtle hover:border-border-default"
                  }`}
                >
                  <div className="relative aspect-[16/10] overflow-hidden bg-bg-primary">
                    <img
                      src={`${API_BASE}/images/${img.filename}`}
                      alt={`AI生成图片 ${index + 1}`}
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
                      loading="lazy"
                    />
                    <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3">
                      <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md bg-bg-primary/78 px-2.5 text-xs text-text-secondary backdrop-blur">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => onSelectImage(img.filename)}
                          className="h-4 w-4 accent-accent"
                        />
                        选择
                      </label>
                      <span className="rounded-md bg-bg-primary/78 px-2.5 py-1 text-xs font-medium text-text-secondary backdrop-blur">
                        #{index + 1}
                      </span>
                    </div>

                    <div className="absolute inset-x-0 bottom-0 flex translate-y-2 items-center justify-end gap-2 bg-gradient-to-t from-bg-primary/88 to-transparent p-3 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => onPreview(img.filename)}
                        className="flex min-h-10 min-w-10 items-center justify-center rounded-md bg-bg-secondary/90 text-text-secondary transition hover:text-text-primary"
                        title="放大预览"
                      >
                        <Expand size={16} />
                      </button>
                      <a
                        href={`${API_BASE}/download/${img.filename}`}
                        download
                        className="flex min-h-10 min-w-10 items-center justify-center rounded-md bg-bg-secondary/90 text-text-secondary transition hover:text-text-primary"
                        title="下载"
                      >
                        <Download size={16} />
                      </a>
                      {onModify && (
                        <button
                          type="button"
                          onClick={() => {
                            setModifyTarget(img.filename);
                            setModifyText("");
                          }}
                          className="flex min-h-10 min-w-10 items-center justify-center rounded-md bg-accent text-white transition hover:bg-accent-hover"
                          title="迭代修改"
                        >
                          <RefreshCw size={16} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">生成图片版本 {index + 1}</p>
                      <p className="mt-0.5 truncate text-xs text-text-muted">PNG · {providerModel || "图片模型"} · 可下载</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onPreview(img.filename)}
                      className="flex min-h-9 min-w-9 items-center justify-center rounded-md border border-border-subtle text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
                      title="查看原图"
                    >
                      <Maximize2 size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {modifyTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-lg border border-border-default bg-bg-secondary p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <RefreshCw size={17} className="text-accent" />
                迭代修改
              </div>
              <button
                type="button"
                onClick={() => setModifyTarget(null)}
                className="min-h-9 rounded-md px-2 text-sm text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
              >
                关闭
              </button>
            </div>
            <textarea
              value={modifyText}
              onChange={(e) => setModifyText(e.target.value)}
              rows={5}
              placeholder="描述本轮需要调整的内容，例如：减少文字、提升留白、强化芯片主体、降低霓虹感。"
              className="w-full resize-y rounded-lg border border-border-default bg-bg-primary px-3 py-3 text-sm leading-6 text-text-primary placeholder:text-text-muted focus:border-accent/65"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModifyTarget(null)}
                className="min-h-10 rounded-md border border-border-subtle px-4 text-sm text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!modifyText.trim()) return;
                  onModify(modifyText, modifyTarget);
                  setModifyTarget(null);
                }}
                className="min-h-10 rounded-md bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover"
              >
                生成迭代版
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingState() {
  const skeletonCards = [0, 1, 2, 3];

  return (
    <div className="min-h-[520px]">
      <div className="mb-4 rounded-lg border border-accent/25 bg-accent/8 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-accent/35 bg-accent/12 text-accent">
            <Loader2 size={21} className="animate-spin-soft" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">正在生成图片资产</p>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              图片服务正在处理提示词、画幅和批量任务。结果完成后会自动写入画廊与历史记录。
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">
        {skeletonCards.map((item) => (
          <div key={item} className="overflow-hidden rounded-lg border border-border-subtle bg-bg-tertiary">
            <div className="aspect-[16/10] animate-pulse bg-gradient-to-br from-bg-elevated via-bg-hover to-bg-tertiary" />
            <div className="space-y-3 p-3">
              <div className="h-3 w-3/5 animate-pulse rounded-full bg-bg-elevated" />
              <div className="h-3 w-2/5 animate-pulse rounded-full bg-bg-elevated" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  const errorInfo =
    typeof error === "string"
      ? {
          message: error,
          code: "GENERATE_FAILED",
          detail: "本次请求没有完成，请根据建议检查服务状态。",
          recovery: ["检查 API Key", "确认后端进程", "重新发起生成"],
        }
      : error;
  const recovery = errorInfo?.recovery?.length
    ? errorInfo.recovery
    : ["检查 API Key", "确认后端进程", "重新发起生成"];

  return (
    <div className="grid min-h-[520px] items-center gap-5 xl:grid-cols-[0.95fr_1.05fr]">
      <div className="max-w-xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm font-medium text-warning">
          <AlertTriangle size={16} />
          服务状态需要处理
        </div>
        <h2 className="max-w-lg text-2xl font-semibold leading-tight text-text-primary">
          {errorInfo?.message || "画廊已准备好，当前生成服务暂时没有完成响应。"}
        </h2>
        <p className="mt-3 max-w-lg text-sm leading-7 text-text-muted">
          {errorInfo?.detail ||
            "你仍然可以编辑提示词、调整参数和复用历史。确认图片服务可用后，重新连接即可继续生成。"}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {recovery.map((chip) => (
            <span key={chip} className="rounded-md border border-border-subtle bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary">
              {chip}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover"
        >
          <RefreshCw size={16} />
          重新生成
        </button>
      </div>

      <div className="rounded-lg border border-border-default bg-bg-primary/62 p-5">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ShieldCheck size={17} className="text-mint" />
            运行诊断
          </div>
          <span className="rounded-md border border-error/30 bg-error/10 px-2 py-1 text-xs font-medium text-error">
            未完成
          </span>
        </div>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-muted">当前状态</dt>
            <dd className="text-right font-medium text-text-primary">{errorInfo?.code || "GENERATE_FAILED"}</dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-muted">恢复动作</dt>
            <dd className="text-right font-medium text-text-primary">按建议处理后重试</dd>
          </div>
          <div>
            <dt className="mb-2 text-text-muted">建议说明</dt>
            <dd className="rounded-lg border border-error/25 bg-error/8 p-3 text-sm leading-6 text-text-secondary">
              {recovery.join(" / ")}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function EmptyState({ mode, presetName, presetCategory }) {
  const chips =
    mode === "text-to-image"
      ? ["摄影", "插画", "3D渲染", "产品展示"]
      : ["参考图继承", "结构优化", "细节微调", "批量出图"];

  return (
    <div className="relative min-h-[520px] overflow-hidden rounded-md">
      <img
        src="/assets/demo-poster.png"
        alt="通用图片生成示例预览"
        className="absolute inset-0 h-full w-full object-cover opacity-54"
        loading="eager"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-bg-secondary via-bg-secondary/92 to-bg-secondary/38" />
      <div className="absolute inset-0 bg-gradient-to-t from-bg-secondary via-transparent to-transparent" />

      <div className="relative z-10 flex min-h-[520px] items-center p-5 sm:p-6">
        <div className="max-w-xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/14 px-3 py-2 text-sm font-medium text-accent backdrop-blur">
            <Sparkles size={16} />
            通用视觉工作台
          </div>
          <h2 className="max-w-xl text-2xl font-semibold leading-tight text-text-primary sm:text-3xl">
            从预设或自由提示词开始，生成任何类型的视觉资产。
          </h2>
          <p className="mt-3 max-w-lg text-sm leading-7 text-text-secondary">
            这里会展示生成结果、下载状态和迭代入口。空状态保留预览结构，避免首次进入时像一个未完成的工具页面。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <span
                key={chip}
                className="rounded-md border border-white/12 bg-bg-primary/62 px-3 py-1.5 text-xs text-text-secondary backdrop-blur"
              >
                {chip}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="absolute bottom-5 right-5 z-10 hidden w-64 rounded-lg border border-white/12 bg-bg-primary/72 p-3 backdrop-blur sm:block">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">{presetName || "自由创作示例"}</p>
            <p className="mt-0.5 text-xs text-text-secondary">{presetCategory || "多类型图片"} · 16:9 · 高清导出</p>
          </div>
          <span className="rounded-md border border-mint/25 bg-mint/12 px-2.5 py-1 text-xs font-medium text-mint">
            Preview
          </span>
        </div>
      </div>
    </div>
  );
}
