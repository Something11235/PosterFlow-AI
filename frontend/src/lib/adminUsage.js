export function adminUsageRows(images = [], music = [], kind = "all", video = []) {
  return [...images.map(row => ({ ...row, kind: "image", key: `image:${row.id}` })),
    ...music.map(row => ({ ...row, kind: "music", key: `music:${row.request_id}` })),
    ...video.map(row => ({ ...row, kind: "video", key: `video:${row.request_id}` }))]
    .filter(row => kind === "all" || row.kind === kind)
    .sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at) || b.key.localeCompare(a.key)).slice(0,100);
}

export function usageState(row) {
  if (row.billing_status === "refunded" || row.status === "refunded") return "已退回";
  if (row.billing_status === 'awaiting_balance') return '待补足积分';
  if (row.billing_status === 'awaiting_provider') return '待服务结算';
  if (["completed","succeeded"].includes(row.status)) return row.billing_status === "awaiting_balance" ? "待结算" : "成功";
  if (row.status === "failed") return "未完成";
  if (["unknown","submission_unknown"].includes(row.status)) return "待确认";
  return "进行中";
}

export function usageBillingLabel(row) {
  if (row.billing_mode !== 'platform') return '不扣网站积分';
  if (row.kind === 'music') return row.billing_unit === 'song' ? '历史按首' : '按次计费';
  if (row.kind === 'video') return row.billing_unit === 'actual_cost' || ['seedance-2.5','seedance-2-5-flash','seedance-2.0','seedance-2.0-fast','gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video'].includes(row.model) ? '实际用量结算' : '按秒计费';
  return '按张计费';
}

export function filterUsageRows(rows, state='all', query='') {
  const term=query.trim().toLowerCase();
  return rows.filter(row => (state==='all' || (state==='failed' ? ['failed','refunded'].includes(row.status) : state==='attention' ? ['待确认','待补足积分','待服务结算'].includes(usageState(row)) : state==='success' ? usageState(row)==='成功' : state==='pending' ? usageState(row)==='进行中' : false)) && (!term || [row.request_id,row.id,row.model,row.username,row.email,row.failure_label,row.failure_reason].some(value=>String(value || '').toLowerCase().includes(term))));
}
