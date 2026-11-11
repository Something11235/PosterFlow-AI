import React, { useId } from "react";
import { IMAGE_MODEL_OPTIONS, imageSelectedPricingLabel } from "../lib/provider";
import ModelPicker from "./ModelPicker";

export default function ImageModelSelect({ model = "", billingMode = "platform", onModelChange, onOpenProvider, disabled = false, referenceCount = 0, resolution = "" }) {
  const id = useId();
  const customModel = model && !IMAGE_MODEL_OPTIONS.some(option => option.value === model);
  return <div className="mb-4 rounded-lg border border-border-subtle bg-bg-primary/40 p-3">
    <div className="mb-2 flex items-center justify-between gap-2">
      <label htmlFor={id} className="text-sm font-medium text-text-secondary">图片模型</label>
      <button type="button" onClick={onOpenProvider} className="min-h-8 rounded px-1 text-xs text-accent hover:text-accent-hover">服务设置</button>
    </div>
    <ModelPicker id={id} value={model} onChange={onModelChange} disabled={disabled} options={[
      ...(!model ? [{value: "", label: "请选择模型", disabled: true}] : []),
      ...(customModel ? [{value: model, label: model}] : []),
      ...IMAGE_MODEL_OPTIONS,
    ]}/>
    <p className="mt-2 text-xs text-text-muted">{billingMode === "platform" ? "平台积分" : "自带 API Key"}</p>
    {model && <p className="mt-2 text-xs leading-5 text-text-muted" aria-live="polite">{billingMode === "platform" ? imageSelectedPricingLabel(model, referenceCount, resolution) : "自带 API Key 不扣网站积分。"}</p>}
  </div>;
}
