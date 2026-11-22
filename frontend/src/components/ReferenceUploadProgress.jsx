export default function ReferenceUploadProgress({ progress }) {
  if (!progress) return null;
  const { current, total, filename, label, fraction, advice, failed } = progress;
  const numeric = Number.isFinite(fraction) && !failed;
  const percent = numeric ? Math.floor(100 * Math.max(0, Math.min(1, fraction))) : null;
  const fileNumber = total > 0 ? `第 ${current} / ${total} 张` : "";
  return <div className="mt-2 min-w-0 rounded-md border border-border-default bg-bg-primary/65 px-3 py-2">
    <div role="status" aria-live="polite" className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs leading-5">
      <strong className={failed ? "text-gold" : "text-text-secondary"}>{label}</strong>
      <span className="tabular-nums text-text-muted">{fileNumber}</span>
    </div>
    {filename && <p className="break-all text-xs leading-5 text-text-muted">{filename}</p>}
    {!failed && <div className="flex items-center gap-2">
      <progress className="my-1 h-1.5 w-full min-w-0 accent-accent" max={1} value={numeric ? percent / 100 : undefined}
        aria-label={[`参考图上传`, fileNumber, label].filter(Boolean).join("，")} />
      {numeric && <span className="text-xs tabular-nums text-text-muted">{percent}%</span>}
    </div>}
    {failed && <p className="text-xs leading-5 text-text-secondary">{advice} 本次生图请求尚未提交。</p>}
  </div>;
}
