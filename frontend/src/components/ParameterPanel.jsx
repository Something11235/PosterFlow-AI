import React from "react";
import { Gauge, ImageDown, LayoutTemplate, Scaling, SlidersHorizontal } from "lucide-react";

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

const QUALITY_META = {
  auto: { label: "自动", hint: "动态平衡" },
  medium: { label: "标准", hint: "交付兼顾" },
  high: { label: "高清", hint: "细节优先" },
};

export default function ParameterPanel({
  size,
  onSizeChange,
  customSize,
  onCustomSizeChange,
  quality,
  onQualityChange,
  count,
  onCountChange,
  strength,
  onStrengthChange,
  sizes,
  mode,
}) {
  const sizeMap = Object.keys(sizes || {}).length ? sizes : FALLBACK_SIZES;
  const showStrength = mode === "image-to-image" || mode === "iterative";
  const customSizeActive = size === "custom";

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

      <fieldset className="mb-4">
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
                  {value.width} x {value.height}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onSizeChange("custom")}
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
        <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
          <ImageDown size={16} />
          画质
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(QUALITY_META).map(([key, value]) => {
            const active = quality === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onQualityChange(key)}
                className={`min-h-14 rounded-lg border px-3 py-2 text-left transition ${
                  active
                    ? "border-mint/45 bg-mint/12"
                    : "border-border-subtle bg-bg-tertiary/72 hover:border-border-default hover:bg-bg-elevated"
                }`}
                aria-pressed={active}
              >
                <span className={`block text-sm font-semibold ${active ? "text-mint" : "text-text-primary"}`}>
                  {value.label}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">{value.hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium text-text-secondary">批量生成</legend>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map((value) => (
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

      {showStrength && (
        <fieldset className="mb-4">
          <legend className="mb-2 flex items-center justify-between text-sm font-medium text-text-secondary">
            <span className="flex items-center gap-2">
              <Gauge size={16} />
              参考强度
            </span>
            <span className="font-semibold text-accent">{Math.round(strength * 100)}%</span>
          </legend>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(strength * 100)}
            onChange={(e) => onStrengthChange(Number(e.target.value) / 100)}
            className="h-2 w-full cursor-pointer appearance-none rounded-full"
            style={{
              background: `linear-gradient(to right, #4f8cff 0%, #4f8cff ${strength * 100}%, #243142 ${strength * 100}%, #243142 100%)`,
            }}
            aria-label="参考图强度"
          />
          <div className="mt-2 flex justify-between text-xs text-text-muted">
            <span>创意改动</span>
            <span>贴近原图</span>
          </div>
        </fieldset>
      )}

      <div className="rounded-lg border border-border-subtle bg-bg-primary/55 p-3">
        <p className="text-xs leading-6 text-text-muted">
          {mode === "text-to-image" && "当前会根据提示词直接生成全新视觉，适合从零创作任何类型的图片。"}
          {mode === "image-to-image" && "当前会读取参考图结构或调性，强度越高越接近原图。"}
          {mode === "iterative" && "当前会基于上一张结果继续优化，适合逐轮微调标题、留白、光效和主体结构。"}
        </p>
      </div>
    </div>
  );
}
