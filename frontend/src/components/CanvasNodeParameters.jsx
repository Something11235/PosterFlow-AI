import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";

function ParamField({ control, value, disabled, onChange }) {
  const { key, label, type, options = [], min, max, step } = control;
  if (type === "checkbox") {
    return <label className="cc-param-check"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={e => onChange(key, e.target.checked)} />{label}</label>;
  }
  return <label className="cc-param-field">
    <span>{label}</span>
    {type === "select" ? <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={e => {
      const option = options.find(o => String(o.value) === e.target.value);
      if (option) onChange(key, option.value);
    }}>{options.map(o => <option key={String(o.value)} value={o.value}>{o.label}</option>)}</select>
    : <input key={String(value ?? "")} type={type} aria-label={label} defaultValue={value ?? ""} min={min} max={max} step={step} disabled={disabled}
      onBlur={e => {
        if (!e.target.reportValidity()) return;
        const raw = e.target.value;
        if (raw !== String(value ?? "")) onChange(key, type === "number" && raw !== "" ? Number(raw) : raw);
      }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />}
  </label>;
}

export default function CanvasNodeParameters({ title, quote, disabled, onChange, onModelChange }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef(null);
  const controls = quote.controls || [];
  const primary = controls.filter(c => c.key === "resolution" || c.key === "duration");
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  const field = c => <ParamField key={c.key} control={c} value={c.effectiveValue ?? quote.params?.[c.key] ?? quote[c.key]} disabled={disabled || c.disabled} onChange={onChange} />;
  if (!controls.length && !onModelChange) return null;
  return <>
    <div className="cc-param-strip">
      {primary.map(field)}
      <button type="button" className="cc-param-more" aria-label={title + "的生成参数"} title="生成参数" onClick={() => setOpen(true)}><SlidersHorizontal size={14} />{onModelChange && <span className="cc-touch-settings">模型与参数</span>}{!primary.length && <span className={onModelChange ? "cc-desktop-settings" : ""}>参数</span>}</button>
    </div>
    {open && <dialog ref={dialog} className="cc-param-dialog cc-dialog" role="dialog" aria-label={title + "的生成参数"} onClose={() => setOpen(false)}
      onClick={e => { if (e.target === dialog.current) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } }}>
      <header><h2>{title} · 生成参数</h2><button type="button" aria-label="关闭生成参数" onClick={() => dialog.current.close()}><X size={17} /></button></header>
      {onModelChange ? <label className="cc-sheet-model">生成模型
        <select value={quote.model || ""} disabled={disabled || !quote.options.length} onChange={event => onModelChange(event.target.value)}>
          {!quote.options.some(option => option.value === quote.model) && <option value={quote.model || ""}>{quote.model || "请选择模型"}</option>}
          {quote.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label> : <p>{quote.options.find(option => option.value === quote.model)?.label || quote.model}</p>}
      <div className="cc-param-grid">{controls.map(field)}</div>
      {quote.inputHint && <p className="cc-param-support">{quote.inputHint}</p>}
      {quote.reservedCredits > quote.credits && <p>预计 {quote.credits} 积分，本次预留 {quote.reservedCredits} 积分。</p>}
      {quote.error && <p role="status">{quote.error}</p>}
    </dialog>}
  </>;
}
