import React from "react";
import {
  CheckCircle2,
  Eye,
  Frame,
  Gauge,
  Image as ImageIcon,
  Loader2,
  ServerCog,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";

const QUALITY_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "medium", label: "标准" },
  { value: "high", label: "高清" },
];

export default function CanvasAiPanel({
  workflow,
  onWorkflowChange,
  onClose,
  ratios,
  ratioKey,
  onRatioChange,
  onCreateFrame,
  selection,
  prompt,
  onPromptChange,
  strength,
  onStrengthChange,
  quality,
  onQualityChange,
  onPreviewReferences,
  previewBusy,
  onGenerate,
  busy,
  error,
  providerConfigured,
  providerName,
  onOpenProvider,
}) {
  const isFrameWorkflow = workflow === "frame";
  const hasTarget = isFrameWorkflow ? Boolean(selection.holder) : Boolean(selection.image);
  const hasInstruction =
    Boolean(prompt.trim()) || (!isFrameWorkflow && Boolean(selection.annotationTexts?.length));
  const generateLabel = isFrameWorkflow ? "生成到选中图框" : "生成重绘版本";

  return (
    <aside
      className="absolute inset-x-2 top-2 z-[450] max-h-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-border-default bg-bg-secondary shadow-2xl sm:left-auto sm:right-3 sm:w-[350px]"
      aria-label="画布 AI 工作台"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle bg-bg-secondary/96 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-accent/35 bg-accent/12 text-accent">
            <Sparkles size={17} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">画布 AI</h2>
            <p className="truncate text-xs text-text-muted">{providerName || "图片生成服务"}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
          aria-label="关闭画布 AI 面板"
          title="关闭"
        >
          <X size={17} />
        </button>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 rounded-md border border-border-subtle bg-bg-primary p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={isFrameWorkflow}
            onClick={() => onWorkflowChange("frame")}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm transition ${
              isFrameWorkflow ? "bg-bg-elevated text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <Frame size={15} />
            AI 图片框
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isFrameWorkflow}
            onClick={() => onWorkflowChange("redraw")}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm transition ${
              !isFrameWorkflow ? "bg-bg-elevated text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <WandSparkles size={15} />
            标注重绘
          </button>
        </div>

        {isFrameWorkflow && (
          <div className="mt-4 border-b border-border-subtle pb-4">
            <label htmlFor="canvas-frame-ratio" className="text-xs font-medium text-text-muted">
              新图框比例
            </label>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select
                id="canvas-frame-ratio"
                value={ratioKey}
                onChange={(event) => onRatioChange(event.target.value)}
                className="min-h-11 min-w-0 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary focus:border-accent/65"
              >
                {Object.entries(ratios).map(([key, ratio]) => (
                  <option key={key} value={key}>
                    {ratio.label} · {ratio.width}×{ratio.height}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={onCreateFrame}
                disabled={busy}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 text-sm font-medium text-accent transition hover:bg-accent/16 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Frame size={16} />
                新建
              </button>
            </div>
          </div>
        )}

        <div
          className={`mt-4 flex items-start gap-3 rounded-md border px-3 py-3 ${
            hasTarget ? "border-mint/30 bg-mint/8" : "border-border-subtle bg-bg-primary/60"
          }`}
          aria-live="polite"
        >
          {hasTarget ? (
            <CheckCircle2 size={17} className="mt-0.5 flex-shrink-0 text-mint" />
          ) : isFrameWorkflow ? (
            <Frame size={17} className="mt-0.5 flex-shrink-0 text-text-muted" />
          ) : (
            <ImageIcon size={17} className="mt-0.5 flex-shrink-0 text-text-muted" />
          )}
          <div className="min-w-0">
            <p className={`text-sm font-medium ${hasTarget ? "text-text-primary" : "text-text-secondary"}`}>
              {isFrameWorkflow
                ? selection.holder
                  ? `已选 ${selection.holder.meta?.posterflowRatioLabel || "AI 图片框"}`
                  : "请选择一个 AI 图片框"
                : selection.image
                  ? "已选重绘原图"
                  : "请选择一张画布图片"}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-text-muted">
              {isFrameWorkflow
                ? selection.holder
                  ? `${Math.round(selection.holder.props.w)} × ${Math.round(selection.holder.props.h)} 画布单位`
                  : "新建图框后会自动选中，也可点击已有图框。"
                : selection.image
                  ? selection.annotationCount > 0
                    ? selection.annotationTexts?.length
                      ? (selection.annotationSource === "nearby" ? "自动关联 " : "已选 ") +
                        selection.annotationCount +
                        " 个标注，识别 " +
                        selection.annotationTexts.length +
                        " 条文字"
                      : (selection.annotationSource === "nearby" ? "自动关联 " : "同时包含 ") +
                        selection.annotationCount +
                        " 个标注"
                    : "未检测到邻近标注，仅使用干净原图"
                  : selection.imageCount > 1
                    ? "一次只能选择一张原图"
                    : "选中原图后会自动关联图内及附近标注。"}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="canvas-ai-prompt" className="text-xs font-medium text-text-muted">
            {isFrameWorkflow ? "生成提示词" : "修改要求"}
          </label>
          <textarea
            id="canvas-ai-prompt"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={5}
            maxLength={6000}
            placeholder={isFrameWorkflow ? "描述需要生成的完整画面" : "描述需要修改的区域与最终效果"}
            className="mt-2 w-full resize-y rounded-md border border-border-default bg-bg-primary px-3 py-3 text-base leading-6 text-text-primary placeholder:text-text-muted focus:border-accent/65"
          />
          <p className="mt-1 text-right text-xs tabular-nums text-text-muted">{prompt.length}/6000</p>
          {!isFrameWorkflow && selection.annotationTexts?.length > 0 && (
            <div className="mt-2 border-t border-border-subtle pt-2">
              <p className="text-xs font-medium text-mint">已识别的标注要求</p>
              <ol className="mt-1 space-y-1 text-xs leading-5 text-text-secondary">
                {selection.annotationTexts.map((text, index) => (
                  <li key={index}>
                    {index + 1}. {text}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {!isFrameWorkflow && (
          <fieldset className="mt-4">
            <legend className="flex w-full items-center justify-between text-xs font-medium text-text-muted">
              <span className="flex items-center gap-2">
                <Gauge size={15} />
                重绘幅度
              </span>
              <span className="font-semibold tabular-nums text-accent">{Math.round((1 - strength) * 100)}%</span>
            </legend>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round((1 - strength) * 100)}
              onChange={(event) => onStrengthChange(1 - Number(event.target.value) / 100)}
              className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full"
              style={{
                background: `linear-gradient(to right, #4f8cff 0%, #4f8cff ${(1 - strength) * 100}%, #243142 ${(1 - strength) * 100}%, #243142 100%)`,
              }}
              aria-label="重绘幅度"
            />
            <div className="mt-2 flex justify-between text-xs text-text-muted">
              <span>轻微调整</span>
              <span>大幅重绘</span>
            </div>
          </fieldset>
        )}

        <fieldset className="mt-4">
          <legend className="text-xs font-medium text-text-muted">画质</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {QUALITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onQualityChange(option.value)}
                aria-pressed={quality === option.value}
                className={`min-h-11 rounded-md border px-2 text-sm transition ${
                  quality === option.value
                    ? "border-mint/40 bg-mint/10 text-mint"
                    : "border-border-subtle bg-bg-primary text-text-secondary hover:border-border-default hover:bg-bg-elevated"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        {error && (
          <div className="mt-4 rounded-md border border-error/30 bg-error/10 px-3 py-3" role="alert">
            <p className="text-sm font-medium text-error">{error.message}</p>
            {error.detail && <p className="mt-1 text-xs leading-5 text-text-muted">{error.detail}</p>}
          </div>
        )}

        {!isFrameWorkflow && (
          <button
            type="button"
            onClick={onPreviewReferences}
            disabled={busy || previewBusy || !hasTarget}
            className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border-default bg-bg-primary px-4 text-sm font-medium text-text-secondary transition hover:border-accent/45 hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {previewBusy ? <Loader2 size={17} className="animate-spin-soft" /> : <Eye size={17} />}
            {previewBusy ? "正在准备参考图" : "检查参考图"}
          </button>
        )}

        {!providerConfigured ? (
          <button
            type="button"
            onClick={onOpenProvider}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-4 text-sm font-medium text-gold transition hover:bg-gold/15"
          >
            <ServerCog size={17} />
            配置图片服务
          </button>
        ) : (
          <button
            type="button"
            onClick={onGenerate}
            disabled={busy || previewBusy || !hasTarget || !hasInstruction}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? <Loader2 size={17} className="animate-spin-soft" /> : <Sparkles size={17} />}
            {busy ? "正在生成" : generateLabel}
          </button>
        )}
      </div>
    </aside>
  );
}
