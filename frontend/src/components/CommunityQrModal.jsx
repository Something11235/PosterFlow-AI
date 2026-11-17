import React,{useEffect,useRef} from 'react';
import {X} from 'lucide-react';

export default function CommunityQrModal({open,onClose}){
  const close=useRef(onClose),button=useRef(null);close.current=onClose;
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement;button.current?.focus();
    const escape=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close.current();}};
    document.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('keydown',escape,true);previous?.focus?.();};
  },[open]);
  if(!open)return null;
  return <div role="dialog" aria-modal="true" aria-labelledby="qq-community-title" className="fixed inset-0 z-[165] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section className="max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto rounded-lg border border-border-default bg-bg-secondary p-5 shadow-2xl"><header className="mb-4 flex items-center justify-between gap-3"><div><h2 id="qq-community-title" className="font-semibold text-text-primary">QQ交流群</h2><p className="mt-1 text-xs text-text-muted">PosterFlow-AI交流群</p></div><button type="button" ref={button} onClick={onClose} aria-label="关闭QQ交流群" className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated"><X size={19}/></button></header><p className="mb-4 text-sm leading-6 text-text-secondary">这里有着一群热爱AI且乐于助人的小伙伴，欢迎入群交流分享~</p><img src="/posterflow-community-qr.png" alt="PosterFlow-AI交流群二维码" className="mx-auto max-h-[70dvh] w-full rounded-md bg-white object-contain"/><p className="mt-3 text-center text-xs leading-5 text-text-muted">使用手机 QQ 扫描二维码加入交流群。</p></section>
  </div>;
}
