import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, RefreshCw } from 'lucide-react';
import { fetchImageBlob, fetchImageUrl } from '../lib/client';
import { createGalleryPreview } from '../lib/galleryPreview';

export default function GalleryImagePreview({ filename, index, authenticated, authHeaders }) {
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(null);
  const reader = useRef(null);
  useEffect(() => {
    const instance = createGalleryPreview({ filename, authenticated, headers: authHeaders, forceRefresh: attempt > 0,
      loadUrl: fetchImageUrl, loadBlob: fetchImageBlob,
      onChange: value => setPreview({ ...value, filename, authenticated, authHeaders, attempt }),
    });
    reader.current = instance;
    return () => { instance.dispose(); if (reader.current === instance) reader.current = null; };
  }, [filename, authenticated, authHeaders, attempt]);

  // Do not flash the previous account's cached image before effect cleanup.
  const current = preview?.filename === filename && preview?.authenticated === authenticated
    && preview?.authHeaders === authHeaders && preview?.attempt === attempt ? preview : { state: 'loading', url: '' };
  return <>
    {current.url && <img src={current.url} alt={`AI生成图片 ${index + 1}`}
      className={`h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]${current.state === 'ready' ? '' : ' opacity-0'}`}
      decoding="async" referrerPolicy="no-referrer"
      onLoad={() => reader.current?.loaded(current.url)} onError={() => reader.current?.failed(current.url)} />}
    {current.state !== 'ready' && <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-bg-primary px-4 text-center">
      {current.state === 'error' ? <>
        <ImagePlus size={21} className="text-text-muted" aria-hidden="true" />
        <p role="status" className="text-xs leading-5 text-text-secondary">图片已生成，预览加载失败</p>
        <button type="button" onClick={() => setAttempt(value => value + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 text-xs text-accent hover:bg-accent/20">
          <RefreshCw size={14} />重新加载图片
        </button>
        <p className="text-[11px] text-text-muted">只读取已有图片，不会再次扣积分</p>
      </> : <p role="status" className="flex items-center gap-2 text-xs text-text-secondary"><Loader2 size={16} className="animate-spin" />{current.state === 'recovering' ? '图片已生成，正在重新读取…' : '正在加载图片…'}</p>}
    </div>}
  </>;
}
