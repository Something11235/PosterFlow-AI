import React from 'react';
import { displayCredits } from '../lib/credits';
import { PPT_MODEL_NAMES } from '../lib/pptProject';

const KINDS = { generate: '生成演示稿', edit: '局部修改', chat: 'AI 对话' };
const STATUS = { succeeded: '已完成', failed: '失败', processing: '进行中' };
const METRICS = { requests: '总请求', users: '使用用户', input_tokens: '输入 Token', output_tokens: '输出 Token', credits: '实际扣分' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const cell = 'px-3 py-2.5';

function count(value) {
  return /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('zh-CN') : '—';
}

function Records({ jobs }) {
  return <section className="mt-5" aria-label="PPT 使用记录">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-text-primary">使用记录</h4>
      <span className="text-xs text-text-muted">最近 100 条 · 北京时间</span>
    </div>
    {!jobs.length ? <p className="py-4 text-sm text-text-muted">所选条件下暂无 PPT 使用记录。</p> :
      <div className="max-h-[420px] overflow-auto rounded-md border border-border-subtle bg-bg-primary/40">
        <table className="w-full min-w-[950px] text-left text-xs">
          <caption className="sr-only">一键 PPT 请求与结算记录</caption>
          <thead className="sticky top-0 bg-bg-tertiary text-text-muted"><tr>
            {['时间', '用户', '任务与模型', '状态', '输入 Token', '输出 Token', '预留积分', '实扣积分'].map(title =>
              <th key={title} scope="col" className={cell + ' whitespace-nowrap font-medium'}>{title}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border-subtle text-text-secondary">{jobs.map(job => {
            const timestamp = Date.parse(job.created_at);
            return <tr key={job.user_id + ':' + job.request_id}>
              <td className={cell + ' whitespace-nowrap tabular-nums'}>{Number.isFinite(timestamp) ? dateFormat.format(timestamp) : '—'}</td>
              <td className={cell}><strong className="font-medium text-text-primary">{job.username || '未命名用户'}</strong><p className="mt-1 break-all text-text-muted">{job.email || job.user_id}</p></td>
              <td className={cell}>
                <strong className="font-medium">{KINDS[job.kind] || job.kind}</strong>
                <p className="mt-1 whitespace-nowrap">{PPT_MODEL_NAMES[job.model] || job.model}</p>
                <details className="mt-1 text-text-muted"><summary className="cursor-pointer">请求编号</summary><p className="mt-1 break-all">{job.request_id}</p></details>
              </td>
              <td className={cell}>
                <span className={job.status === 'succeeded' ? 'text-mint' : job.status === 'failed' ? 'text-gold' : 'text-accent'}>{STATUS[job.status] || '待确认'}</span>
                {job.error_code && <p className="mt-1 break-all text-text-muted">{job.error_code}</p>}
              </td>
              <td className={cell + ' tabular-nums'}>{count(job.input_tokens)}</td>
              <td className={cell + ' tabular-nums'}>{count(job.output_tokens)}</td>
              <td className={cell + ' tabular-nums'}>{displayCredits(job.reserved_credits)}</td>
              <td className={cell + ' font-medium tabular-nums text-text-primary'}>{displayCredits(job.charged_credits, job.status === 'processing' ? '待结算' : '—')}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </section>;
}

export default function AdminPptOverview({ data, error, loading }) {
  if (loading) return <p role="status" className="mt-3 text-xs text-text-muted">正在读取 PPT 运营数据…</p>;
  if (error || !data?.metrics) return <p role="alert" className="mt-3 text-xs text-gold">{error || 'PPT 数据暂未加载，请点击上方「查询」重试。'}</p>;
  const { metrics, models = [], jobs = [] } = data;
  return <div aria-label="一键 PPT 运营">
    <p className="mt-2 text-xs leading-5 text-text-muted">按上方日期和用户筛选，Token 汇总仅计已确认用量。</p>
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {Object.entries(METRICS).map(([key, label]) => <div key={key} className="rounded-md border border-border-subtle bg-bg-primary/60 p-3">
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd className="mt-2 break-all text-xl font-semibold tabular-nums text-text-primary">{key === 'credits' ? displayCredits(metrics[key]) : count(metrics[key])}</dd>
      </div>)}
    </dl>
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 rounded-md border border-border-subtle bg-bg-primary/40 p-3 text-xs">
      {Object.entries({ ...KINDS, completed: '已完成', failed: '失败', pending: '进行中' }).map(([key, label]) =>
        <div key={key} className="flex gap-1.5"><dt className="text-text-muted">{label}</dt><dd className="tabular-nums text-text-secondary">{count(metrics[key])}</dd></div>)}
    </dl>
    {models.length > 0 && <section className="mt-5" aria-label="PPT 模型用量">
      <h4 className="mb-2 text-sm font-medium text-text-primary">模型用量</h4>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{models.map(model => <div key={model.model} className="rounded-md border border-border-subtle bg-bg-primary/40 p-3 text-xs">
        <p className="flex flex-wrap items-baseline justify-between gap-2"><strong className="font-medium text-text-primary">{PPT_MODEL_NAMES[model.model] || model.model}</strong><span className="text-text-muted">{count(model.requests)} 次</span></p>
        <p className="mt-2 text-text-secondary">输入 {count(model.input_tokens)} · 输出 {count(model.output_tokens)} Token</p>
        <p className="mt-1 text-text-muted">实扣 {displayCredits(model.credits)} 积分</p>
      </div>)}</div>
    </section>}
    <Records jobs={jobs}/>
  </div>;
}
