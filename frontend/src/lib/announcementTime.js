// datetime-local contains no offset. This admin form explicitly uses Beijing
// time, independently of the administrator's device/browser timezone.
export function toInputDate(value) {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 16) : "";
}

export function toApiDate(value) {
  if (!value) return null;
  const parsed = new Date(`${value}:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || toInputDate(parsed) !== value) {
    throw new Error("请填写有效的北京时间。");
  }
  return parsed.toISOString();
}
