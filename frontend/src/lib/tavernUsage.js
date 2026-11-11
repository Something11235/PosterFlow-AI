import { creditUnits } from './credits.js';
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'cache_miss_tokens', 'reasoning_tokens'];
const SUMMARY_FIELDS = {
  confirmedTotalTokens: 'total_tokens', inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_tokens', cacheMissTokens: 'cache_miss_tokens', reasoningTokens: 'reasoning_tokens',
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const emptyUsage = status => ({ status, ...Object.fromEntries(USAGE_FIELDS.map(field => [field, null])) });

export function normalizeTavernBilling(value) {
  if (!plain(value) || typeof value.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.request_id)
      || !['held', 'settled', 'refunded', 'awaiting_review'].includes(value.status)) return null;
  try {
    const reserve = creditUnits(value.reserved_credits);
    const charge = value.charged_credits === null ? null : creditUnits(value.charged_credits);
    if (reserve < 0 || reserve > 1000000000 || charge !== null && (charge < 0 || charge > reserve)) return null;
    if (['held', 'awaiting_review'].includes(value.status) ? charge !== null : charge === null) return null;
    if (value.status === 'refunded' && charge !== 0) return null;
    const amount = units => `${Math.floor(units / 10000)}.${String(units % 10000).padStart(4, '0')}`;
    return { request_id: value.request_id.toLowerCase(), status: value.status,
      reserved_credits: amount(reserve), charged_credits: charge === null ? null : amount(charge) };
  } catch { return null; }
}

// Only accept the backend's normalized fields. Missing values are never estimated.
export function normalizeTavernUsage(value) {
  if (value === undefined || value === null) return emptyUsage('missing');
  if (!plain(value)) return emptyUsage('invalid');
  if (value.status === 'invalid') return emptyUsage('invalid');
  let invalid = value.status !== undefined && !['confirmed', 'partial', 'missing'].includes(value.status);
  const usage = emptyUsage('missing');
  for (const field of USAGE_FIELDS) {
    if (value[field] === undefined || value[field] === null) continue;
    if (count(value[field])) usage[field] = value[field];
    else invalid = true;
  }
  const clear = (...fields) => { invalid = true; for (const field of fields) usage[field] = null; };
  const input = usage.input_tokens, output = usage.output_tokens, total = usage.total_tokens;
  if (total !== null && ((input !== null && total < input) || (output !== null && total < output)
      || (input !== null && output !== null && (!count(input + output) || total !== input + output)))) clear('total_tokens');
  if (input !== null) {
    for (const field of ['cache_read_tokens', 'cache_miss_tokens']) {
      if (usage[field] !== null && usage[field] > input) clear(field);
    }
    if (usage.cache_read_tokens !== null && usage.cache_miss_tokens !== null
        && usage.cache_read_tokens + usage.cache_miss_tokens !== input) clear('cache_read_tokens', 'cache_miss_tokens');
  }
  if (output !== null && usage.reasoning_tokens !== null && usage.reasoning_tokens > output) clear('reasoning_tokens');
  const hasValues = USAGE_FIELDS.some(field => usage[field] !== null);
  if (!hasValues) {
    usage.status = invalid || ['confirmed', 'partial'].includes(value.status) ? 'invalid' : 'missing';
  } else {
    const coreComplete = ['input_tokens', 'output_tokens', 'total_tokens'].every(field => usage[field] !== null);
    usage.status = !invalid && value.status === 'confirmed' && coreComplete ? 'confirmed' : 'partial';
  }
  return usage;
}

function identifier(value, nullable = false) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('用量记录编号无效。');
  return value;
}

export function normalizeTavernUsageRecords(value = []) {
  if (!Array.isArray(value)) throw new Error('对话用量记录格式无效。');
  if (value.length > 1000) throw new Error('每个对话最多保存 1000 条用量记录，请开启新对话。');
  const records = value.map(record => {
    if (!plain(record) || !count(record.createdAt)) throw new Error('用量记录时间格式无效。');
    if (typeof record.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(record.model)) throw new Error('用量记录模型格式无效。');
    if (!['own_key', 'platform'].includes(record.billingMode)) throw new Error('用量记录计费方式无效。');
    if (!['completed', 'unknown', 'rejected'].includes(record.outcome)) throw new Error('用量记录结果状态无效。');
    const kind = record.kind === undefined ? 'chat' : record.kind;
    if (!['chat', 'summary', 'assist'].includes(kind)) throw new Error('用量记录调用类型无效。');
    return {
      id: identifier(record.id), messageId: identifier(record.messageId, true), createdAt: record.createdAt,
      model: record.model, billingMode: record.billingMode, outcome: record.outcome, kind,
      usage: normalizeTavernUsage(record.usage),
      ...(record.billingMode === 'platform' && normalizeTavernBilling(record.billing)?.request_id === record.id.toLowerCase() ? { billing: normalizeTavernBilling(record.billing) } : {}),
    };
  });
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('对话用量记录编号重复。');
  return records;
}

export function summarizeTavernUsage(session = {}) {
  const records = normalizeTavernUsageRecords(session?.usageRecords);
  const legacy = session?.legacyReplyCount === undefined ? (session?.usageRecords === undefined && Array.isArray(session?.messages)
    ? session.messages.filter((message, index) => index !== 0 && message?.role === 'assistant').length : 0) : session.legacyReplyCount;
  if (!count(legacy)) throw new Error('历史未统计回复数量无效。');
  const summary = {
    requests: records.length, completed: 0, unknown: 0, rejected: 0, unreported: 0, legacy,
    partial: 0, missing: 0, invalid: 0,
    ...Object.fromEntries(Object.keys(SUMMARY_FIELDS).map(field => [field, null])),
    reportedCounts: Object.fromEntries(Object.keys(SUMMARY_FIELDS).map(field => [field, 0])),
    isComplete: false, overflowFields: [],
  };
  const totals = Object.fromEntries(Object.keys(SUMMARY_FIELDS).map(field => [field, 0n]));
  for (const record of records) {
    if (record.outcome === 'unknown') { summary.unknown++; continue; }
    if (record.outcome === 'rejected') { summary.rejected++; continue; }
    summary.completed++;
    if (record.usage.total_tokens === null) summary.unreported++;
    if (record.usage.status !== 'confirmed') summary[record.usage.status]++;
    for (const [field, source] of Object.entries(SUMMARY_FIELDS)) {
      const amount = record.usage[source];
      if (amount === null) continue;
      totals[field] += BigInt(amount);
      summary.reportedCounts[field]++;
    }
  }
  for (const field of Object.keys(SUMMARY_FIELDS)) {
    if (totals[field] > BigInt(Number.MAX_SAFE_INTEGER)) summary.overflowFields.push(field);
    else if (summary.reportedCounts[field] > 0) summary[field] = Number(totals[field]);
  }
  summary.isComplete = summary.unknown === 0 && summary.unreported === 0 && summary.legacy === 0
    && !summary.overflowFields.includes('confirmedTotalTokens');
  return summary;
}
