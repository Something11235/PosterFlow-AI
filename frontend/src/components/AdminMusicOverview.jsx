import React, { useState } from 'react';
import { Film, Image, MessagesSquare, Music2, TriangleAlert } from 'lucide-react';
import { creditText } from '../lib/credits';
import AdminTavernOverview from './AdminTavernOverview';

function valueText(metrics,key,loading) {
  if (loading || !metrics || metrics[key] == null) return '—';
  if (['credits','reserved','credits_consumed'].includes(key)) return creditText(metrics[key]);
  return Number(metrics[key]).toLocaleString('zh-CN')+(key==='success_rate'?'%':'');
}

export default function AdminMusicOverview({ imageMetrics,data,error,loading,authHeaders,refreshKey }) {
  const [kind,setKind]=useState('image');
  const tavern=kind==='tavern',image=kind==='image',video=kind==='video', metrics=image?imageMetrics:video?data?.video_metrics:data?.metrics;
  const models=image?[]:video?data?.video_models:data?.models;
  const labels=image?[['generated_images','生成图片'],['credits_consumed','生图消耗积分'],['success_rate','生图成功率'],['platform_jobs','平台生图任务'],['own_key_jobs','自定义 Key 生图任务']]:[['requests',video?'视频生成次数':'音乐生成次数'],[video?'completed':'completed_requests','完成任务'],['failed','失败任务'],['credits','实际消耗积分'],['success_rate','终态成功率'],['reserved','尚未结算预留']];
  const max=Math.max(1,...(models || []).map(row=>Number(row.requests)||0));
  const diagnostics=data?.failure_counts;
  return <section aria-label="创作运营概览" className="mb-5 min-w-0 rounded-lg border border-accent/25 bg-accent/5 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-text-primary">创作运营概览</h3><div className="flex flex-wrap gap-2" aria-label="运营类型">{[['image','图像',Image],['music','音乐',Music2],['video','视频',Film],['tavern','AI 酒馆',MessagesSquare]].map(([value,label,Icon])=><button key={value} type="button" aria-pressed={kind===value} onClick={()=>setKind(value)} className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-xs ${kind===value?'border-accent/40 bg-accent/15 text-accent':'border-border-subtle text-text-muted'}`}><Icon size={15}/>{label}</button>)}</div></div>
    {tavern?<AdminTavernOverview authHeaders={authHeaders} refreshKey={refreshKey}/>:<>
    <p className="mt-2 text-xs leading-5 text-text-muted">按所选日期内创建的全部任务统计，用户搜索仅筛选使用记录。{image?'生图指标沿用现有统计口径，消耗积分按实际扣分显示。':<>成功率 = 完成 ÷（完成 + 失败），进行中任务不计入。{video?'素材审核不计生成次数；Mini 按秒计费，2.0、Fast 与 2.5 按实际用量结算。':'平台音乐每次 2 积分，返回两首仍只扣 2 积分。'}</>}自带 Key 不扣网站积分。</p>
    {error&&<p role="alert" className="mt-3 text-xs text-gold">{error}</p>}
    <dl className={`mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 ${image?'xl:grid-cols-5':'xl:grid-cols-6'}`}>{labels.map(([key,label])=><div key={key} className="rounded-md border border-border-subtle bg-bg-primary/60 p-3"><dt className="text-xs text-text-muted">{label}</dt><dd className="mt-2 text-xl font-semibold tabular-nums text-text-primary">{valueText(metrics,key,loading)}</dd></div>)}</dl>
    {!image&&<><div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 rounded-md border border-border-subtle bg-bg-primary/40 p-3 text-xs text-text-secondary"><span>待处理 {valueText(metrics,'pending',loading)}</span><span>提交 / 状态待确认 {valueText(metrics,'unknown',loading)}</span><span>待补足积分 {valueText(metrics,'awaiting_balance',loading)}</span>{video&&<span>等待服务结算 {valueText(metrics,'awaiting_provider',loading)}</span>}{!video&&<span>返回音轨 {valueText(metrics,'tracks',loading)} 首</span>}</div>
    <p className="mt-2 text-xs leading-5 text-text-muted">待确认任务先核对原任务，避免重复提交；预留积分不计入实际消耗。完成但待补足积分的任务仍列为待处理。</p></>}
    {(models || []).length>0&&<div className="mt-4 grid gap-3 sm:grid-cols-2">{models.map(row=><div key={row.model} className="min-w-0 rounded-md border border-border-subtle bg-bg-primary/40 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs"><span className="break-all font-medium text-text-secondary">{row.model}</span><span className="text-text-muted">{row.requests} 次 · {video?`${row.clips} 条`:`${row.tracks} 首`} · {creditText(row.credits || 0)} 积分</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elevated"><div className="h-full rounded-full bg-accent/75" style={{width:`${row.requests/max*100}%`}} /></div></div>)}</div>}
    <details className="mt-4 rounded-md border border-border-subtle bg-bg-primary/40 p-3"><summary className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-medium text-text-secondary"><TriangleAlert size={15} className="text-gold"/>失败原因分布 · 图像、音乐与视频</summary><p className="mt-2 text-xs leading-5 text-text-muted">按日期区间的全部失败任务分组；历史未保存原因的任务显示“原因未记录”。</p>{loading?<p className="mt-3 text-xs text-text-muted">正在加载…</p>:!diagnostics?<p className="mt-3 text-xs text-text-muted">详细分类暂不可用，请在使用记录中核对具体任务。</p>:!diagnostics.length?<p className="mt-3 text-xs text-text-muted">此日期区间没有失败任务</p>:<ul className="mt-3 grid gap-2 sm:grid-cols-2">{diagnostics.map((row,index)=><li key={`${row.kind}:${index}`} className="rounded-md border border-border-subtle p-3"><p className="flex justify-between gap-3 text-xs"><span className="text-text-secondary">{({image:'图像',music:'音乐',video:'视频'})[row.kind] || '任务'} · {row.label}</span><strong className="shrink-0 tabular-nums text-gold">{row.count} 次</strong></p><p className="mt-2 text-xs leading-5 text-text-muted">{row.reason}</p></li>)}</ul>}</details>
    </>}
  </section>;
}
