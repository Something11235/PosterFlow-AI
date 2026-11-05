import {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Check, ChevronDown} from 'lucide-react';
import ModelBadge from './ModelBadge';

export default function ModelPicker({id, options, value, onChange, disabled = false, className = ''}) {
  const generated = useId();
  const listId = generated + '-options';
  const trigger = useRef(null), popup = useRef(null), search = useRef({text: '', time: 0});
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [position, setPosition] = useState(null);
  const selected = options.find(option => option.value === value);
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const close = () => setOpen(false);
  const choose = index => {
    const option = options[index];
    if (option && !option.disabled) { onChange?.(option.value); close(); trigger.current?.focus(); }
  };
  const start = index => {
    const current = options.findIndex(option => option.value === value && !option.disabled);
    setActive(index ?? (current >= 0 ? current : enabledIndices[0] ?? 0));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current.getBoundingClientRect(), space = window.innerHeight - box.bottom - 8;
      const above = space < 180 && box.top > space;
      const height = Math.min(320, Math.max(100, (above ? box.top : space) - 12));
      setPosition({left: Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8)), width: Math.min(box.width, window.innerWidth - 16), maxHeight: height, ...(above ? {bottom: window.innerHeight - box.top + 4} : {top: box.bottom + 4})});
    };
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (open) document.getElementById(listId + '-' + active)?.scrollIntoView({block: 'nearest'});
  }, [open, active, listId]);

  const keyboard = event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const end = event.key === 'End', home = event.key === 'Home';
      if (!open) { start(home ? enabledIndices[0] : end ? enabledIndices.at(-1) : undefined); return; }
      setActive(index => home ? enabledIndices[0] : end ? enabledIndices.at(-1) : enabledIndices[(enabledIndices.indexOf(index) + (event.key === 'ArrowDown' ? 1 : -1) + enabledIndices.length) % enabledIndices.length] ?? 0);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active); else start();
    } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close();
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      search.current = {text: (Date.now() - search.current.time < 700 ? search.current.text : '') + event.key.toLowerCase(), time: Date.now()};
      const index = options.findIndex(option => !option.disabled && option.label.toLowerCase().includes(search.current.text));
      if (index >= 0) { event.preventDefault(); if (!open) setOpen(true); setActive(index); }
    }
  };
  return <>
    <button ref={trigger} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-expanded={open} aria-activedescendant={open ? listId + '-' + active : undefined} disabled={disabled} onClick={() => open ? close() : start()} onKeyDown={keyboard}
      className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-border-default bg-bg-primary px-3 text-left text-base text-text-primary focus:border-accent/65 disabled:opacity-50 ${className}`}>
      <span className="min-w-0 flex-1 break-words">{selected?.label || '请选择模型'}<ModelBadge model={value}/></span><ChevronDown size={16} className="shrink-0 text-text-muted"/>
    </button>
    {open && position && createPortal(<div ref={popup} id={listId} role="listbox" aria-label="可选图片模型" style={{position: 'fixed', zIndex: 10000, ...position}} className="overflow-y-auto rounded-lg border border-border-default bg-bg-secondary p-1 shadow-2xl">
      {options.map((option, index) => <div key={option.value} id={listId + '-' + index} data-model={option.value} role="option" aria-selected={value === option.value} aria-disabled={Boolean(option.disabled)} onPointerDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(index)} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-text-primary ${active === index ? 'bg-accent/15' : ''} ${option.disabled ? 'opacity-40' : ''}`}>
        <span className="min-w-0 flex-1 break-words">{option.label}<ModelBadge model={option.value}/></span>{value === option.value && <Check size={16} className="shrink-0 text-accent"/>}
      </div>)}
    </div>, document.body)}
  </>;
}
