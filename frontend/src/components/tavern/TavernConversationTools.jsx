import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './tavern-conversation-tools.css';

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
