import React from 'react';
import { ChevronDown, Clock3, Gauge } from 'lucide-react';
import { normalizeTavernUsage, summarizeTavernUsage } from '../../lib/tavernUsage.js';
import { TavernBillingSummary } from './TavernBillingPanel';
import './tavern-usage.css';

const numberFormat = new Intl.NumberFormat('zh-CN');
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const tokens = value => validCount(value) ? numberFormat.format(value) : '未返回';
const recentLimit = 8;

function UsageField({ label, value, note }) {
  return <div><dt>{label}{note && <small>（{note}）</small>}</dt><dd>{tokens(value)}</dd></div>;
}

export function TavernMessageUsage({ record }) {
  if (!record) return null;
  if (record.outcome === 'rejected') return <div className="tavern-usage-message"><p className="tavern-usage-note">请求未完成 · 未产生已确认 Token 用量</p><TavernBillingSummary billing={record.billing} /></div>;
  const usage = normalizeTavernUsage(record.usage);
  const known = record.outcome === 'completed' && ['confirmed', 'partial'].includes(usage.status);
  const reasoning = known && validCount(usage.reasoning_tokens);
  const cacheMiss = known && validCount(usage.cache_miss_tokens);
  return <div className="tavern-usage-message" aria-label="本次调用 Token 用量">
    <span className="tavern-usage-caption">{record.kind === 'summary' ? '剧情摘要 Token' : '本次 Token'}</span>
    {!known && <span className="tavern-usage-badge">用量待确认</span>}
    {known && usage.status === 'partial' && <span className="tavern-usage-badge">部分字段</span>}
    <dl className="tavern-usage-inline">
      <UsageField label="输入" value={known ? usage.input_tokens : null} />
      <UsageField label="输出" value={known ? usage.output_tokens : null} />
      <UsageField label="缓存读取" note="含在输入内" value={known ? usage.cache_read_tokens : null} />
    </dl>
    {(reasoning || cacheMiss) && <details className="tavern-usage-extra"><summary>更多用量明细<ChevronDown size={13} aria-hidden="true" /></summary><dl className="tavern-usage-inline">
      {reasoning && <UsageField label="推理" note="含在输出内" value={usage.reasoning_tokens} />}
      {cacheMiss && <UsageField label="未命中缓存的输入" note="含在输入内" value={usage.cache_miss_tokens} />}
    </dl></details>}
    {record.outcome === 'unknown' && <p className="tavern-usage-note">调用结果待确认，请核对服务商记录。</p>}
    {record.outcome !== 'unknown' && usage.status === 'invalid' && <p className="tavern-usage-note">服务商返回的用量无效，未计入已知用量。</p>}
    {known && usage.cache_read_tokens === null && record.billingMode === 'platform' && record.billing?.status === 'settled' && <p className="tavern-usage-note">缓存明细未返回，输入按标准价计费。</p>}
    <TavernBillingSummary billing={record.billing} />
  </div>;
}

const totalFields = [
  { key: 'confirmedTotalTokens', label: '已知总量' },
  { key: 'inputTokens', label: '输入' },
  { key: 'outputTokens', label: '输出' },
  { key: 'cacheReadTokens', label: '缓存读取', note: '含在输入内' },
];

export function TavernSessionUsage({ session, pendingRequestId }) {
  const summary = summarizeTavernUsage(session);
  const records = session.usageRecords || [];
  const pendingRecord = pendingRequestId ? records.find(record => record.id === pendingRequestId) : null;
  const unknown = Math.max(0, summary.unknown - (pendingRecord?.outcome === 'unknown' ? 1 : 0));
  const recent = records.map((record, index) => ({ record, sequence: index + 1 }))
    .sort((a, b) => b.record.createdAt - a.record.createdAt || b.sequence - a.sequence).slice(0, recentLimit);
  const messageIds = new Set((session.messages || []).map(message => message.id));
  const fields = [
    ...totalFields,
    ...(validCount(summary.cacheMissTokens) || summary.overflowFields.includes('cacheMissTokens') ? [{ key: 'cacheMissTokens', label: '未命中缓存', note: '含在输入内' }] : []),
    ...(validCount(summary.reasoningTokens) || summary.overflowFields.includes('reasoningTokens') ? [{ key: 'reasoningTokens', label: '推理', note: '含在输出内' }] : []),
  ];
  let headline = '尚无用量记录';
  if (validCount(summary.confirmedTotalTokens)) headline = `已知 ${tokens(summary.confirmedTotalTokens)} Token`;
  else if (summary.overflowFields.includes('confirmedTotalTokens')) headline = '累计统计超限';
  else if (summary.requests) headline = summary.rejected === summary.requests ? '请求未完成 · 查看账单' : pendingRequestId && summary.completed === 0 && unknown === 0 ? '等待用量返回' : '用量待确认';
  else if (summary.legacy) headline = '历史用量未统计';
  return <details className="tavern-usage-session tavern-session-usage">
    <summary><Gauge size={15} aria-hidden="true" /><span>会话用量</span><strong aria-live="polite" aria-atomic="true">{headline}</strong>
      {pendingRequestId ? <span className="tavern-usage-badge is-pending"><Clock3 size={12} aria-hidden="true" />等待回复</span> : (unknown > 0 || summary.unreported > 0) && <span className="tavern-usage-badge">{unknown + summary.unreported} 次待确认</span>}
      <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <div className="tavern-usage-body" tabIndex={0} aria-label="会话用量明细">
      <p className="tavern-usage-note">回复完成后更新服务商返回的实际 Token；累计包含重新生成。缓存读取属于输入，推理属于输出，不重复相加。</p>
      <dl className="tavern-usage-totals">{fields.map(({ key, label, note }) => <div key={key}><dt>{label}{note && <small>{note}</small>}</dt><dd>{summary.overflowFields.includes(key) ? '统计超限' : tokens(summary[key])}{validCount(summary[key]) && <small>Token</small>}</dd></div>)}</dl>
      {summary.completed > 0 && <p className="tavern-usage-note">总量已覆盖 {summary.reportedCounts.confirmedTotalTokens} / {summary.completed} 次已完成调用；各字段仅累计已返回的数值，未返回字段不按 0 计算。</p>}
      {pendingRequestId && <p className="tavern-usage-note">当前调用正在等待回复，用量尚未确认。</p>}
      {unknown > 0 && <p className="tavern-usage-note is-warning">{unknown} 次调用结果待确认，尚未计入已知用量。</p>}
      {summary.unreported > 0 && <p className="tavern-usage-note is-warning">{summary.unreported} 次已完成调用未返回可信总量，会话累计不完整。</p>}
      {summary.rejected > 0 && <p className="tavern-usage-note">{summary.rejected} 次请求确认未完成，保留平台账单，未计为 Token 消耗。</p>}
      {(summary.partial > 0 || summary.missing > 0 || summary.invalid > 0) && <p className="tavern-usage-note">{[summary.partial > 0 && `${summary.partial} 次仅有部分字段`, summary.missing > 0 && `${summary.missing} 次未返回用量`, summary.invalid > 0 && `${summary.invalid} 次用量无效`].filter(Boolean).join('；')}。</p>}
      {summary.legacy > 0 && <p className="tavern-usage-note is-warning">{summary.legacy} 条历史回复未统计用量，无法从现有文字还原；历史重新生成调用也可能未留存。</p>}
      {summary.overflowFields.length > 0 && <p className="tavern-usage-note is-warning">部分累计数值超过可安全展示的范围，请核对服务商记录。</p>}
      {recent.length > 0 && <><div className="tavern-usage-recent-title"><h3>最近调用</h3><span>{records.length > recentLimit ? `展示最近 ${recentLimit} / ${records.length} 次` : `${records.length} 次记录`}</span></div><ol className="tavern-usage-history">{recent.map(({ record, sequence }) => {
        const pending = record.id === pendingRequestId;
        const historical = record.messageId && !messageIds.has(record.messageId);
        const date = new Date(record.createdAt);
        const hasDate = Number.isFinite(date.getTime());
        return <li key={record.id}><div className="tavern-usage-record-heading"><strong>第 {sequence} 次调用{record.kind === 'summary' ? ' · 剧情摘要' : historical ? ' · 历史回复' : ''}</strong>{pending && <span className="tavern-usage-badge is-pending">等待回复</span>}{hasDate && <time dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div>
          <p className="tavern-usage-record-model">{record.model || '模型未记录'} · {record.billingMode === 'platform' ? '平台服务' : '自带 API'}</p>
          {pending ? <p className="tavern-usage-note">回复完成后显示用量。</p> : <TavernMessageUsage record={record} />}
        </li>;
      })}</ol>{records.length > recentLimit && <p className="tavern-usage-note">上方累计包含全部已记录调用。</p>}</>}
    </div>
  </details>;
}
