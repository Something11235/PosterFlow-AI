import {BADGE_LABELS, useModelBadges} from '../lib/modelBadges';

export default function ModelBadge({model, value}) {
  const {badges} = useModelBadges();
  const tag = value ?? badges[model];
  if (!tag || !BADGE_LABELS[tag]) return null;
  return <span className="ml-2 inline-flex shrink-0 items-center rounded border border-red-400/25 bg-red-400/10 px-1.5 py-0.5 text-[11px] font-bold leading-none text-red-400" aria-label={`${BADGE_LABELS[tag]}模型`}>{BADGE_LABELS[tag]}</span>;
}
