import React from "react";
import { LayoutTemplate, Scaling, SlidersHorizontal } from "lucide-react";
import { imageCreditCost, imageSelectedPricingLabel } from "../lib/provider";

const FALLBACK_SIZES = {
  square_1_1: { label: "正方形 1:1", width: 1024, height: 1024 },
  landscape_16_9: { label: "横版 16:9", width: 1792, height: 1008 },
  portrait_9_16: { label: "竖版 9:16", width: 1008, height: 1792 },
  landscape_4_3: { label: "横版 4:3", width: 1360, height: 1024 },
  portrait_3_4: { label: "竖版 3:4", width: 1024, height: 1360 },
  wide_21_9: { label: "超宽 21:9", width: 2016, height: 864 },
};

const SIZE_META = {
  square_1_1: { ratio: "1:1", use: "社媒封面" },
  landscape_16_9: { ratio: "16:9", use: "官网/横幅" },
  portrait_9_16: { ratio: "9:16", use: "竖版海报" },
  landscape_4_3: { ratio: "4:3", use: "演示配图" },
  portrait_3_4: { ratio: "3:4", use: "信息单页" },
  wide_21_9: { ratio: "21:9", use: "大屏横幅" },
};

export default function ParameterPanel({
  size,
  onSizeChange,
  customSize,
  onCustomSizeChange,
  count,
  onCountChange,
  sizes,
  mode,
  billingMode = "platform",
  apimartSpec,
  resolution,
  onResolutionChange,
  outputFormat = "png",
  referenceCount = 0,
  onOutputFormatChange,
}) {
  const sizeMap = Object.keys(sizes || {}).length ? sizes : FALLBACK_SIZES;
  const customSizeActive = size === "custom";
  const priceResolution = customSizeActive && ["seedream-5-5", "seedream-5-0-pro"].includes(apimartSpec?.value)
    ? Number(customSize.width) * Number(customSize.height) > 2601124 ? "2K" : "1K" : resolution;
  const gifMode = apimartSpec?.outputFormats?.includes("gif") && outputFormat === "gif";

  const updateCustomDimension = (dimension, value) => {
    onCustomSizeChange({ ...customSize, [dimension]: value });
    if (!customSizeActive) onSizeChange("custom");
  };

  return (
    <div className="surface rounded-lg p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <SlidersHorizontal size={17} className="text-mint" />
          生成参数
        </div>
        <span className="rounded-md border border-mint/20 bg-mint/10 px-2 py-1 text-[11px] font-medium text-mint">
          实时联动
        </span>
      </div>

      {apimartSpec?.outputFormats?.length > 1 && <label className="mb-4 block text-xs text-text-secondary">输出格式<select aria-label="图片输出格式" value={outputFormat} onChange={event => onOutputFormatChange?.(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary"><option value="png">PNG 静态图</option><option value="gif" disabled={mode === "iterative"}>GIF 动图</option></select>{gifMode && <span className="mt-2 block leading-5 text-text-muted">GIF 支持文字及参考图生成，不支持蒙版局部重绘；尺寸自动决定，可选 1–4 个。请在提示词中描述动作和循环方式。</span>}</label>}
      <fieldset className="mb-4 disabled:opacity-50" disabled={gifMode}>
        <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
          <LayoutTemplate size={16} />
          画面尺寸
        </legend>
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {Object.entries(sizeMap).map(([key, value]) => {
            const meta = SIZE_META[key] || { ratio: value.label, use: "自定义" };
            const active = size === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSizeChange(key)}
                className={`min-h-16 rounded-lg border p-3 text-left transition ${
                  active
                    ? "border-accent/45 bg-accent/12"
                    : "border-border-subtle bg-bg-tertiary/72 hover:border-border-default hover:bg-bg-elevated"
                }`}
                aria-pressed={active}
              >
                <span className={`block text-sm font-semibold ${active ? "text-accent" : "text-text-primary"}`}>
                  {meta.ratio}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">{meta.use}</span>
                <span className="mt-1 block text-[11px] text-text-muted">
                  {apimartSpec ? "按所选分辨率生成" : `${value.width} x ${value.height}`}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onSizeChange("")}
            className={`min-h-16 rounded-lg border p-3 text-left transition ${
              !size
                ? "border-accent/45 bg-accent/12"
                : "border-border-subtle bg-bg-tertiary/72 hover:border-border-default hover:bg-bg-elevated"
            }`}
            aria-pressed={!size}
          >
            <span className={`block text-sm font-semibold ${!size ? "text-accent" : "text-text-primary"}`}>由提示词决定</span>
            <span className="mt-0.5 block text-xs text-text-muted">不指定画面尺寸</span>
            <span className="mt-1 block text-[11px] text-text-muted">默认选项</span>
          </button>
          <button
            type="button"
            onClick={() => onSizeChange("custom")}
            disabled={(apimartSpec?.value === "seedream-5-0-lite" || apimartSpec?.customSize === false)}
            title={(apimartSpec?.value === "seedream-5-0-lite" || apimartSpec?.customSize === false) ? "此模型只支持比例与清晰度档位，请选择上方画幅" : undefined}
            className={`min-h-16 rounded-lg border p-3 text-left transition ${
              customSizeActive
                ? "border-accent/45 bg-accent/12"
                : "border-border-subtle bg-bg-tertiary/72 hover:border-border-default hover:bg-bg-elevated"
            }`}
            aria-pressed={customSizeActive}
          >
            <span className={`flex items-center gap-1.5 text-sm font-semibold ${customSizeActive ? "text-accent" : "text-text-primary"}`}>
              <Scaling size={14} />自定义
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">精确宽高</span>
            <span className="mt-1 block text-[11px] text-text-muted">
              {customSize.width || "-"} x {customSize.height || "-"}
            </span>
          </button>
        </div>
        {customSizeActive && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3 border-t border-border-subtle pt-3">
            <div>
              <label htmlFor="custom-image-width" className="text-xs font-medium text-text-muted">宽度（px）</label>
              <input
                id="custom-image-width"
                type="number"
                inputMode="numeric"
                min="256"
                max="4096"
                step="8"
                value={customSize.width}
                onChange={(event) => updateCustomDimension("width", event.target.value)}
                className="mt-1.5 min-h-11 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary focus:border-accent/65"
              />
            </div>
            <span className="pb-3 text-sm text-text-muted" aria-hidden="true">x</span>
            <div>
              <label htmlFor="custom-image-height" className="text-xs font-medium text-text-muted">高度（px）</label>
              <input
                id="custom-image-height"
                type="number"
                inputMode="numeric"
                min="256"
                max="4096"
                step="8"
                value={customSize.height}
                onChange={(event) => updateCustomDimension("height", event.target.value)}
                className="mt-1.5 min-h-11 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary focus:border-accent/65"
              />
            </div>
            <p className="col-span-3 text-xs leading-5 text-text-muted">单边 256–4096 px，最终支持范围以图片服务商为准。</p>
          </div>
        )}
      </fieldset>

      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium text-text-secondary">批量生成</legend>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].filter(value => !apimartSpec || value <= apimartSpec.maxCount).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onCountChange(value)}
              className={`min-h-11 rounded-lg border text-sm font-semibold transition ${
                count === value
                  ? "border-gold/45 bg-gold/12 text-gold"
                  : "border-border-subtle bg-bg-tertiary text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
              }`}
              aria-pressed={count === value}
            >
              {value}
            </button>
          ))}
        </div>
      </fieldset>

      {apimartSpec && <div className="mb-4 space-y-3 rounded-lg border border-accent/25 bg-accent/5 p-3">
        {!apimartSpec.automaticResolution && apimartSpec.resolutions.length > 1 && <label className="block text-xs text-text-secondary">分辨率<select aria-label="图片清晰度" value={resolution} disabled={customSizeActive && ["seedream-5-5", "seedream-5-0-pro"].includes(apimartSpec.value)} onChange={event => onResolutionChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary disabled:opacity-50">{apimartSpec.resolutions.map(value => <option key={value} value={value}>{value === "quality" ? "质量模式" : value}</option>)}</select>{customSizeActive && ["seedream-5-5", "seedream-5-0-pro"].includes(apimartSpec.value) && <span className="mt-2 block leading-5 text-text-muted">自定义尺寸按总像素计档：当前按 {priceResolution} 计费。</span>}</label>}
        <p className="text-xs leading-5 text-text-muted" aria-live="polite">{billingMode === "own_key" ? "自带 API Key 不扣网站积分" : `${imageSelectedPricingLabel(apimartSpec.value, referenceCount, priceResolution)}${count > 1 ? `，${count} 张共 ${count * imageCreditCost(apimartSpec.value, referenceCount, priceResolution)} 积分` : ""}`}</p>
      </div>}

      <div className="rounded-lg border border-border-subtle bg-bg-primary/55 p-3">
        <p className="text-xs leading-6 text-text-muted">
          {mode === "create" && "输入提示词即可文生图；上传参考素材后，会按 @图1、@图2 参与构图、主体和风格控制。"}
          {mode === "iterative" && "当前会基于上一张结果继续优化，适合逐轮微调标题、留白、光效和主体结构。"}
        </p>
      </div>
    </div>
  );
}
