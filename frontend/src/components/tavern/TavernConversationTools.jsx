import React from 'react';
import { ChevronLeft, ChevronRight, Gauge } from 'lucide-react';
import './tavern-conversation-tools.css';

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const count = value => isCount(value) ? value.toLocaleString('zh-CN') : '待计算';

export function TavernContextMeter({ status }) {
  if (!status) return null;
  const measurable = isCount(status.usedChars) && isCount(status.budgetChars) && status.budgetChars > 0;
  const overBudget = measurable && status.usedChars > status.budgetChars;
  return <section className={`tavern-context-meter${status.error || overBudget ? ' has-error' : ''}`} aria-label="上下文字符用量">
    <div className="tavern-context-meter-heading"><span><Gauge size={14} aria-hidden="true" />上下文</span><strong>{count(status.usedChars)} / {count(status.budgetChars)} 字符</strong></div>
    {measurable && <progress max={status.budgetChars} value={Math.min(status.usedChars, status.budgetChars)} aria-label="已使用上下文字符" aria-valuetext={`${count(status.usedChars)} / ${count(status.budgetChars)} 字符，不是 Token`} />}
    <p className="tavern-context-meter-counts"><span>纳入 {count(status.includedHistoryCount)} 条</span><span>略过 {count(status.omittedHistoryCount)} 条</span><span>摘要覆盖 {count(status.summarizedCount)} 条</span></p>
    <p className="tavern-context-meter-note">角色设定与记忆 {count(status.settingsChars)} 字符；纳入的历史对话 {count(isCount(status.usedChars) && isCount(status.settingsChars) && isCount(status.inputChars) ? status.usedChars - status.settingsChars - status.inputChars : null)} 字符。角色卡、开场白和世界书也占用上下文，字符容量不等于模型 Token 上限。</p>
    {status.error && <p className="tavern-context-meter-error" role="alert">{status.error}</p>}
    {!status.error && overBudget && <p className="tavern-context-meter-error" role="alert">当前内容超过字符容量，请精简设定或调整上下文容量。</p>}
  </section>;
}

export function TavernReplyVariants({ message, onSelect, disabled = false }) {
  const alternatives = message?.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length < 2) return null;
  const index = alternatives.findIndex(variant => variant.id === message.id);
  if (index < 0) return null;
  const select = next => {
    if (disabled || next < 0 || next >= alternatives.length || typeof onSelect !== 'function') return;
    onSelect(alternatives[next].id);
  };
  return <div className="tavern-reply-variants" role="group" aria-label="回复版本" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); select(index + (event.key === 'ArrowLeft' ? -1 : 1));
  }}><span>回复版本</span><button type="button" aria-label="上一版回复" title="上一版回复" disabled={disabled || index === 0 || typeof onSelect !== 'function'} onClick={() => select(index - 1)}><ChevronLeft size={16} /></button><output aria-live="polite" aria-atomic="true" aria-label={`第 ${index + 1} 版，共 ${alternatives.length} 版`}>{index + 1} / {alternatives.length}</output><button type="button" aria-label="下一版回复" title="下一版回复" disabled={disabled || index === alternatives.length - 1 || typeof onSelect !== 'function'} onClick={() => select(index + 1)}><ChevronRight size={16} /></button></div>;
}
