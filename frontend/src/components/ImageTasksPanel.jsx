import React, {useEffect, useRef} from 'react';
import {ImagePlus, RefreshCw, X} from 'lucide-react';
import ImageTaskQueue from './ImageTaskQueue';

export default function ImageTasksPanel({open,tasks,loading,warning,onClose,onRefresh,onView,onQuery}) {
  const panel=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement;
    panel.current?.querySelector('button')?.focus();
    const key=e=>{
      if(e.key==='Escape'){e.preventDefault();onClose();}
      if(e.key!=='Tab')return;
      const items=[...panel.current.querySelectorAll('button:not([disabled]),a[href],summary')];
      const first=items[0],last=items.at(-1);
      if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);previous?.focus();};
  },[open,onClose]);
  if(!open)return null;
  return <div className="fixed inset-0 z-[115] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="image-tasks-title">
    <section ref={panel} className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
      <header className="flex items-start justify-between gap-3 border-b border-border-subtle p-5"><div><p className="mb-2 text-xs tracking-widest text-accent">IMAGE TASKS</p><h2 id="image-tasks-title" className="flex items-center gap-2 text-lg font-semibold"><ImagePlus size={20}/>生图任务</h2><p className="mt-2 text-xs leading-6 text-text-muted">找回原任务和已有图片 · 不会重新生图</p></div><button type="button" aria-label="关闭生图任务" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated"><X size={19}/></button></header>
      <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-lg text-xs leading-6 text-text-secondary">保留近 7 天最多 50 笔任务。登录后同步本人平台任务；自带 Key 的任务需重新配置原 Key 才能查询。原图为临时存储，请及时下载。</p><button type="button" disabled={loading} onClick={onRefresh} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/40 px-3 text-sm text-accent disabled:opacity-50"><RefreshCw size={15} className={loading?'animate-spin':''}/>{loading?'同步中…':'刷新任务'}</button></div>
        {warning && <p role="status" className="rounded-md border border-gold/30 bg-gold/10 p-3 text-sm leading-6 text-gold">{warning}</p>}
        {!tasks.length && <p className="py-12 text-center text-sm text-text-muted">{loading?'正在找回原任务…':'暂无生图任务记录'}</p>}
        <ImageTaskQueue tasks={tasks} onView={onView} onQuery={onQuery} expanded/>
      </div>
    </section>
  </div>;
}
