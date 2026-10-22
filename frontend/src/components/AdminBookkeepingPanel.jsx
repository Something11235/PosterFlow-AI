import React, { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, BookOpen, CalendarDays, Check, Loader2, Save } from "lucide-react";
import { ADMIN_STATS_START, amountInCents, beijingDate, formatLedgerAmount, money, summarizeDays } from "../lib/adminBookkeeping";

const INPUT = "mt-2 min-h-11 w-full min-w-0 rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-50";
const BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50";

function TrendChart({ days, financial = false, onSelect }) {
  const [active, setActive] = useState(null);
  const series = financial
    ? [{ key: "recharge_text", name: "充值金额", color: "#20c997" }, { key: "cost_text", name: "已消耗成本", color: "#d6a84f" }]
    : [{ key: "new_users", name: "新增用户", color: "#4f8cff" }];
  const value = (day, key) => financial ? amountInCents(day[key]) : Number(day[key] || 0);
  const values = days.flatMap(day => series.map(s => value(day, s.key))).filter(v => v !== null);
  const maximum = Math.max(1, ...values), minimum = Math.min(0, ...values);
  const x = i => 44 + (days.length <= 1 ? 277 : i * 554 / (days.length - 1));
  const y = v => 168 - ((v - minimum) / (maximum - minimum)) * 142;
  const selected = days[active];
  return <div className="min-w-0 rounded-lg border border-border-subtle bg-bg-primary/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-text-primary">{financial ? "每日充值与成本" : "每日新增用户"}</h4><div className="flex gap-3 text-xs text-text-muted">{series.map(s => <span key={s.key} className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span>)}</div></div>
    <svg viewBox="0 0 632 204" className="mt-3 w-full" role="img" aria-label={financial ? "每日充值金额与成本趋势图，空白和文字记录不绘制为零" : "每日新增用户趋势图"}>
      {[0, 0.5, 1].map(t => { const v = minimum + (maximum - minimum) * t; return <g key={t}><line x1="44" x2="598" y1={y(v)} y2={y(v)} stroke="#243142" strokeDasharray="3 5" /><text x="37" y={y(v) + 4} textAnchor="end" fill="#8796aa" fontSize="10">{financial ? (v / 100).toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : Math.round(v)}</text></g>; })}
      {series.map(s => {
        const paths = []; let segment = [];
        days.forEach((day, i) => { const v = value(day, s.key); if (v === null) { if (segment.length) paths.push(segment.join(" ")); segment = []; } else segment.push(`${segment.length ? "L" : "M"}${x(i)},${y(v)}`); });
        if (segment.length) paths.push(segment.join(" "));
        return <g key={s.key}>{financial ? paths.map((d, i) => <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="2.5" />) : days.map((day, i) => <rect key={day.stat_date} x={x(i) - Math.min(7, 220 / days.length)} y={y(value(day, s.key))} width={Math.min(14, 440 / days.length)} height={Math.max(1, y(0) - y(value(day, s.key)))} rx="2" fill={s.color} opacity={active === i ? 1 : 0.7} />)}{financial && days.map((day, i) => { const v = value(day, s.key); return v === null ? null : <circle key={day.stat_date} cx={x(i)} cy={y(v)} r="3" fill={s.color} />; })}</g>;
      })}
      {days.map((day, i) => <rect key={day.stat_date} x={x(i) - Math.min(12, 277 / Math.max(1, days.length - 1))} y="20" width={Math.min(24, 554 / Math.max(1, days.length - 1))} height="156" fill="transparent" tabIndex="0" role="button" aria-label={`${day.stat_date}，新增 ${day.new_users} 人，充值 ${day.recharge_text || "未填写"}，成本 ${day.cost_text || "未填写"}，点击编辑`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onClick={() => onSelect(day)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(day); } }}><title>{`${day.stat_date} · 新增 ${day.new_users} 人 · 充值 ${day.recharge_text || "未填写"} · 成本 ${day.cost_text || "未填写"}`}</title></rect>)}
      {[0, Math.floor((days.length - 1) / 2), days.length - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i).map(i => <text key={i} x={x(i)} y="196" textAnchor="middle" fill="#8796aa" fontSize="11">{days[i]?.stat_date.slice(5)}</text>)}
    </svg>
    <p className="min-h-5 break-words text-xs text-text-muted">{selected ? `${selected.stat_date} · 新增 ${selected.new_users} 人 · 充值 ${selected.recharge_text || "未填写"} · 成本 ${selected.cost_text || "未填写"}` : financial ? "仅绘制纯数字金额；未填写或文字记录留空。" : "点击图表或下方明细，可以编辑当天记录。"}</p>
  </div>;
}

export default function AdminBookkeepingPanel({ initialData, authHeaders, loading, onSavingChange }) {
  const [data, setData] = useState(null);
  const [daily, setDaily] = useState(null);
  const [statDate, setStatDate] = useState(() => beijingDate());
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [conflict, setConflict] = useState("");
  const dailyDirty = useRef(false), pending = useRef(null);
  const dayCache = useRef(new Map());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    if (!initialData) return;
    setData(initialData);
    for (const day of [...(initialData.days || []), initialData.today].filter(Boolean)) dayCache.current.set(day.stat_date, day);
  }, [initialData]);
  useEffect(() => {
    if (!dailyDirty.current) setDaily(dayCache.current.get(statDate) || null);
  }, [data, statDate]);
  const overview = data?.overview?.source === "daily" ? data.overview : null;
  const days = useMemo(() => (data?.days || []).filter(day => day.stat_date >= ADMIN_STATS_START), [data]);
  const summary = useMemo(() => summarizeDays(days), [days]);
  const locked = loading || Boolean(saving) || !data;

  const chooseDay = (dayOrDate) => {
    if (pending.current || (dailyDirty.current && !window.confirm("当前日期有未保存的修改，确定切换日期吗？"))) return;
    const date = typeof dayOrDate === "string" ? dayOrDate : dayOrDate.stat_date;
    dailyDirty.current = false; setStatDate(date); setError(""); setSuccess(""); setConflict("");
    setDaily(dayCache.current.get(date) || null);
  };
  const readDay = async () => {
    if (pending.current || !statDate) return;
    if (dailyDirty.current && !window.confirm("重新加载会替换当前日期尚未保存的输入，确定继续吗？")) return;
    const controller = new AbortController(); pending.current = controller; setSaving("read"); onSavingChange(true); setError("");
    try {
      const response = await fetch(`/api/admin/bookkeeping?${new URLSearchParams({ from: statDate, to: statDate })}`, { headers: authHeaders, credentials: "include", signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.detail || result.error || "读取记录失败");
      if (!alive.current || controller.signal.aborted) return;
      const record = result.bookkeeping.days[0];
      dailyDirty.current = false; dayCache.current.set(statDate, record); setDaily(record);
      setData(d => ({ ...d, overview: result.bookkeeping.overview, days: d.days.map(day => day.stat_date === record.stat_date ? record : day) }));
      setConflict(""); setSuccess("已读取最新记录。");
    } catch (e) { if (!controller.signal.aborted && alive.current) setError(e.message || "读取记录失败"); }
    finally { if (alive.current) { setSaving(""); onSavingChange(false); } if (pending.current === controller) pending.current = null; }
  };
  const save = async (event) => {
    event.preventDefault(); if (pending.current || locked || !daily) return;
    const fields = daily;
    const controller = new AbortController(); pending.current = controller; setSaving("daily"); onSavingChange(true); setError(""); setSuccess("");
    try {
      const response = await fetch("/api/admin/bookkeeping", { method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, credentials: "include", signal: controller.signal, body: JSON.stringify({ scope: "daily", stat_date: statDate, recharge_text: fields.recharge_text, cost_text: fields.cost_text, note: fields.note || "", revision: fields.revision }) });
      const result = await response.json();
      if (!alive.current || controller.signal.aborted) return;
      if (!response.ok) { if (result.code === "BOOKKEEPING_CONFLICT") setConflict("daily"); throw new Error(result.detail || result.error || "记账保存失败"); }
      dailyDirty.current = false; setDaily(result.record);
      dayCache.current.set(result.record.stat_date, result.record);
      setData(d => ({ ...d, overview: result.overview, today: result.record.stat_date === d.today_date ? result.record : d.today, days: d.days.map(day => day.stat_date === result.record.stat_date ? result.record : day) }));
      setConflict(""); setSuccess(`${statDate} 的每日记录已保存${result.overview?.source === "daily" ? "，总账已更新" : ""}。`);
    } catch (e) { if (!controller.signal.aborted && alive.current) setError(e.message || "记账保存失败，当前输入已保留。"); }
    finally { if (alive.current) { setSaving(""); onSavingChange(false); } if (pending.current === controller) pending.current = null; }
  };
  const changeDaily = (key, value) => { dailyDirty.current = true; setDaily(d => ({ ...d, [key]: value })); setSuccess(""); };

  return <section className="mb-5 min-w-0 space-y-4" aria-label="经营记账与每日统计">
    <section aria-label="经营总账" className="rounded-lg border border-accent/25 bg-accent/5 p-4" aria-busy={locked}>
      <div className="flex items-center gap-2"><BookOpen size={17} className="text-accent" /><h3 className="text-sm font-semibold text-text-primary">经营总账</h3><span className="ml-auto rounded-full border border-mint/25 bg-mint/10 px-2 py-1 text-xs text-mint">自动汇总</span></div>
      <p className="mt-2 text-xs leading-5 text-text-muted">自动累加截至今日的全部每日记录，不受日期筛选或用户搜索影响。保存或修改每日记录后自动更新。</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">{[["充值金额（元）", "ledger-recharge", overview?.recharge_text, "text-mint"], ["已消耗成本（元）", "ledger-cost", overview?.cost_text, "text-gold"]].map(([title, id, value, color]) => <div key={id} className="rounded-md border border-border-subtle bg-bg-primary/70 p-4"><dt className="text-xs text-text-secondary">{title}</dt><dd id={id} className={`mt-2 break-all text-2xl font-semibold tabular-nums ${color}`} aria-live="polite">{loading ? "—" : formatLedgerAmount(value)}</dd></div>)}</dl>
      <p className="mt-3 text-xs leading-5 text-text-muted">{overview ? `共 ${overview.recorded_days} 天已保存记录；充值 ${overview.recharge_days} 天、成本 ${overview.cost_days} 天填写数字。` : loading || !data ? "正在加载累计记录…" : "累计数据暂不可用，请刷新后重试。"} 仅汇总纯数字金额，空白和文字说明不计入。{overview?.text_days > 0 && `其中 ${overview.text_days} 天包含文字金额，请在每日明细中核对。`}</p>
      {overview?.updated_at && <p className="mt-2 text-xs text-text-muted">最近记账：{new Date(overview.updated_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</p>}
    </section>

    <div className="rounded-lg border border-border-subtle bg-bg-tertiary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><CalendarDays size={17} className="text-mint" /><h3 className="text-sm font-semibold text-text-primary">每日统计</h3></div><span className="text-xs text-text-muted">北京时间 · 可补记历史日期</span></div>
      <form onSubmit={save} className="mt-4">
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><label className="min-w-0 text-xs text-text-secondary" htmlFor="daily-date">记录日期<input id="daily-date" className={INPUT} type="date" max={data?.today_date || beijingDate()} value={statDate} disabled={locked} onChange={e => chooseDay(e.target.value)} /></label><div className="min-w-0 rounded-md border border-border-subtle bg-bg-primary/70 px-3 py-2"><p className="text-xs text-text-muted">当日新增用户 · 自动统计</p><p className="mt-1 text-xl font-semibold tabular-nums text-text-primary" data-testid="daily-new-users">{daily?.new_users ?? "—"}<span className="ml-2 text-xs font-normal text-text-muted">人</span></p></div><button type="button" className="min-h-11 rounded-md border border-border-default px-3 text-sm text-text-secondary disabled:opacity-50" disabled={locked || !statDate} onClick={() => readDay()}>读取该日记录</button></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><label htmlFor="daily-recharge" className="text-xs text-text-secondary">当日充值金额（元，手动）<input id="daily-recharge" className={INPUT} type="text" maxLength={500} value={daily?.recharge_text || ""} disabled={locked || !daily} onChange={e => changeDaily("recharge_text", e.target.value)} placeholder="例如：128.50，也可记录文字" /></label><label htmlFor="daily-cost" className="text-xs text-text-secondary">当日已消耗成本（元，手动）<input id="daily-cost" className={INPUT} type="text" maxLength={500} value={daily?.cost_text || ""} disabled={locked || !daily} onChange={e => changeDaily("cost_text", e.target.value)} placeholder="例如：36.80，也可记录文字" /></label></div>
        <label className="mt-3 block text-xs text-text-secondary" htmlFor="daily-note">当日备注<textarea id="daily-note" className={`${INPUT} min-h-20 py-3`} maxLength={1000} value={daily?.note || ""} disabled={locked || !daily} onChange={e => changeDaily("note", e.target.value)} placeholder="补充收款、支出或运营情况" /></label>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="max-w-xl text-xs leading-5 text-text-muted">新增用户按现存账号的注册时间统计，包含未验证邮箱的账号；打开或查询时更新。{!daily && " 请先读取所选日期的记录。"}</p><button type="submit" className={BUTTON} disabled={locked || !daily}>{saving === "daily" ? <Loader2 size={15} className="animate-spin-soft" /> : <Save size={15} />}保存每日记录</button></div>
      </form>
    </div>
    {error && <p className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert">{error}</p>}
    {conflict && <button type="button" className="min-h-11 rounded-md border border-border-default px-3 text-sm text-text-primary" disabled={locked} onClick={() => readDay()}>重新加载该日最新记录</button>}
    {success && <p role="status" className="flex items-center gap-2 text-sm text-mint"><Check size={16} />{success}</p>}

    <div className="rounded-lg border border-border-subtle bg-bg-tertiary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><BarChart3 size={17} className="text-accent" />经营趋势看板</h3><span className="text-xs text-text-muted">{days.length ? `${days[0].stat_date} — ${days.at(-1).stat_date}` : "暂无区间数据"}</span></div>
      <p className="mt-2 text-xs leading-5 text-text-muted">统计起始日为 2026-10-11。使用控制台上方的日期筛选查询，最多 90 天；不展示起始日之前的数据。用户搜索不影响经营统计。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">{[
        ["区间新增用户", data ? summary.newUsers.toLocaleString("zh-CN") : "—", `${days.length} 天 · 自动统计`, "text-accent"],
        ["已记录充值（元）", summary.rechargeDays ? money(summary.rechargeCents) : "—", `${summary.rechargeDays} / ${days.length} 天填写数字`, "text-mint"],
        ["已记录成本（元）", summary.costDays ? money(summary.costCents) : "—", `${summary.costDays} / ${days.length} 天填写数字`, "text-gold"],
      ].map(([title, number, detail, color]) => <div key={title} className="rounded-md border border-border-subtle bg-bg-primary/60 p-3"><p className="text-xs text-text-muted">{title}</p><p className={`mt-2 break-all text-2xl font-semibold tabular-nums ${color}`}>{number}</p><p className="mt-2 text-xs text-text-muted">{detail}</p></div>)}</div>
      <p className="my-3 text-xs leading-5 text-text-muted">金额汇总只包含纯数字（最多两位小数）。空白表示未记录，填写 0 才表示当日为零。{summary.textDays > 0 && `有 ${summary.textDays} 天包含文字金额，文字部分保留在明细中，不计入金额合计。`}</p>
      {days.length > 0 ? <div className="grid gap-3 lg:grid-cols-2"><TrendChart days={days} onSelect={chooseDay} /><TrendChart days={days} financial onSelect={chooseDay} /></div> : <p className="py-6 text-center text-sm text-text-muted">加载后显示每日趋势。</p>}
      <div className="mt-4 max-h-72 overflow-auto rounded-md border border-border-subtle"><table className="w-full min-w-[670px] text-left text-xs"><caption className="sr-only">每日经营明细，点击编辑可以补记或修改当天记录</caption><thead className="sticky top-0 bg-bg-secondary text-text-muted"><tr>{["日期", "新增用户", "充值金额（元）", "已消耗成本（元）", "备注", "操作"].map(title => <th key={title} className="px-3 py-3 font-medium">{title}</th>)}</tr></thead><tbody className="divide-y divide-border-subtle">{[...days].reverse().map(day => <tr key={day.stat_date} className={day.stat_date === statDate ? "bg-accent/8" : ""}><td className="whitespace-nowrap px-3 py-2 text-text-secondary">{day.stat_date}</td><td className="px-3 py-2 tabular-nums text-text-secondary">{day.new_users}</td><td className="max-w-48 break-words px-3 py-2 text-mint">{day.recharge_text || <span className="text-text-muted">未填写</span>}</td><td className="max-w-48 break-words px-3 py-2 text-gold">{day.cost_text || <span className="text-text-muted">未填写</span>}</td><td className="max-w-60 break-words px-3 py-2 text-text-muted">{day.note || "—"}</td><td className="px-3 py-1"><button type="button" disabled={locked} className="min-h-11 px-2 text-accent disabled:opacity-50" aria-label={`编辑 ${day.stat_date} 的每日记录`} onClick={() => chooseDay(day)}>编辑</button></td></tr>)}</tbody></table></div>
    </div>
  </section>;
}
