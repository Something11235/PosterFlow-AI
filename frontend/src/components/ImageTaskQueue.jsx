import React, { useState } from "react";
import { AlertTriangle, Check, ImagePlus, Loader2 } from "lucide-react";

const labels = { running: "生成中", completed: "已完成", failed: "未完成", pending: "等待结果" };
export default function ImageTaskQueue({ tasks, onView, onQuery, expanded=false }) {
  const [querying, setQuerying] = useState("");
  if (!tasks.length) return null;
  const active = tasks.filter(task => task.active).length;
  return <details open={expanded || tasks.some(task=>task.status==='pending')} className="surface shrink-0 rounded-lg border border-accent/20" aria-label="生图任务记录">
    <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-4 py-2 text-sm text-text-secondary">
      <ImagePlus size={16} className="text-accent" />生图任务记录
      <span className="text-xs text-text-muted">{active ? `${active} 个进行中 / 最多 3 个并行` : `${tasks.length} 个任务 · 点击查看结果`}</span>
    </summary>
    <p className="px-4 pb-2 text-xs leading-6 text-text-muted">刷新后仍可找回任务。登录后会自动跟进近期平台任务，也可手动查询原任务；不会重新生图。图片保留 12 小时，请及时下载。</p>
    <ul className={`${expanded?'':'max-h-48 overflow-y-auto '}divide-y divide-border-subtle px-4`}>{tasks.map(task => <li key={task.id} className="flex flex-wrap items-center gap-2 py-3">
      {task.active || task.status==='pending' && ['IMAGE_TASK_PENDING','IMAGE_SAVE_PENDING'].includes(task.error?.code) ? <Loader2 size={15} className="shrink-0 animate-spin text-accent" /> : task.status==='completed' ? <Check size={15} className="shrink-0 text-mint" /> : <AlertTriangle size={15} className="shrink-0 text-gold" />}
      <div className="min-w-[140px] flex-1"><p className="truncate text-sm text-text-primary" title={task.prompt}>{task.prompt || '生图任务'}</p><p className="mt-1 break-words text-xs leading-5 text-text-muted">{task.model} · {task.error?.refunded===true?'已退回积分':task.error?.code==='IMAGE_SUBMISSION_UNKNOWN'?'结果待确认':task.error?.code==='IMAGE_SAVE_PENDING'?'图片保存中':task.error?.code==='IMAGE_TASK_PENDING'?'生成处理中':labels[task.status]}{task.images.length ? ` · ${task.images.length} 张` : ''} · {task.billingMode==='own_key'?'自带 Key':'平台积分'}</p><p className="mt-1 text-xs leading-5 text-text-muted">{new Date(task.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>{expanded && <p className="mt-1 select-text break-all font-mono text-xs leading-5 text-text-muted">{task.id}</p>}</div>
      <button type="button" disabled={task.active} onClick={() => onView(task)} className="min-h-11 shrink-0 whitespace-nowrap rounded-md border border-border-subtle px-3 text-xs text-accent disabled:opacity-40">{task.images.length ? "查看结果" : task.active ? "生成中" : "查看状态"}</button>
      {task.status === "pending" && <button type="button" disabled={!!querying} onClick={async () => { setQuerying(task.id); try { await onQuery(task); } finally { setQuerying(""); } }} className="min-h-11 shrink-0 whitespace-nowrap rounded-md bg-accent px-3 text-xs font-medium text-white disabled:opacity-50">{querying === task.id ? "查询中…" : "查询原任务"}</button>}
    </li>)}</ul>
  </details>;
}
