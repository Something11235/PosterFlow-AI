// Monetary text stays untouched. Only plain decimals participate in charts;
// blanks and notes are missing observations, never silently converted to zero.
export const ADMIN_STATS_START = "2026-10-11";

export function initialStatsFrom(now = new Date()) {
  // The existing API bounds each query to 90 days.
  return [ADMIN_STATS_START, beijingDate(-89, now)].sort().at(-1);
}

export function formatLedgerAmount(value) {
  if (typeof value !== "string" || !/^-?\d+\.\d{2}$/.test(value)) return "—";
  const [whole, fraction] = value.split(".");
  const negative = whole.startsWith("-");
  return `${negative ? "-" : ""}${BigInt(whole.replace(/^-/, "")).toLocaleString("zh-CN")}.${fraction}`;
}

export function amountInCents(text) {
  const value = String(text ?? "").trim();
  if (!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return value.startsWith("-") ? -cents : cents;
}

export function beijingDate(offset = 0, now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

export function summarizeDays(days) {
  const result = { newUsers: 0, rechargeCents: 0, costCents: 0, rechargeDays: 0, costDays: 0, textDays: 0 };
  for (const day of days) {
    result.newUsers += Number(day.new_users || 0);
    const recharge = amountInCents(day.recharge_text), cost = amountInCents(day.cost_text);
    if (recharge !== null) { result.rechargeCents += recharge; result.rechargeDays++; }
    if (cost !== null) { result.costCents += cost; result.costDays++; }
    if ((day.recharge_text && recharge === null) || (day.cost_text && cost === null)) result.textDays++;
  }
  return result;
}

export function money(cents) {
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
