import React, { useId } from "react";
import { IMAGE_MODEL_OPTIONS, imageCreditCost, imagePricingLabel } from "../lib/provider";
import ModelPicker from "./ModelPicker";

export default function ImageModelSelect({ model = "", billingMode = "platform", onModelChange, onOpenProvider, disabled = false, referenceCount = 0 }) {
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
    {model.startsWith("gpt-image-2.6-") && <p className="mt-2 text-xs leading-5 text-text-muted">当前使用 Ext，支持 1K 单张生成与参考图编辑{billingMode === "platform" ? "，每张 1 积分" : "，不扣网站积分"}。暂不支持标注局部编辑，已禁用局部重绘与无限画布 AI。</p>}
    {model === "gemini-nano-banana-2.1" && billingMode === "platform" && <p className="mt-2 text-xs leading-5 text-text-muted">{imagePricingLabel(model)}。</p>}
    {model.startsWith("seedream-") && <p className="mt-2 text-xs leading-5 text-text-muted">{billingMode === "platform" ? `${imagePricingLabel(model)}。` : "自带 API Key 不扣网站积分。"}{model.endsWith("lite") ? "支持参考图创作，暂未开放局部重绘与无限画布。" : "支持参考图与标注编辑；单次生成 1 张。"}</p>}
    {model === "grok-imagine-image-2.0" && <p className="mt-2 text-xs leading-5 text-text-muted" aria-live="polite">{billingMode === "platform" ? `${referenceCount > 0 ? "参考图编辑" : "纯文生图"} · ${imageCreditCost(model, referenceCount)} 积分 / 张。` : "支持文字生成与参考图编辑。"}最多 3 张参考图。</p>}
  </div>;
}
