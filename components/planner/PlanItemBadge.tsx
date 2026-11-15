/**
 * Метка пункта дня в карточке планировщика (#3399, п. 7): что за пункт и
 * проверено ли, что он состоится. Слова — из `PLAN_ITEM_STATUS`, общего с
 * печатью, Кузьмичом и MCP; у дня не про занятие метки нет.
 */
import { Compass, UserCheck } from 'lucide-react';
import { activityIcon } from '@/lib/tours/activity-icons';
import { planItemStatus, PLAN_ITEM_STATUS, type PlanItemDay, type PlanItemStatus } from '@/lib/planner/item-status';

const HikingIcon = activityIcon('hiking');

function statusColor(s: PlanItemStatus): string {
  if (s === 'seats' || s === 'self') return 'var(--success)';
  if (s === 'idea') return 'var(--text-muted)';
  if (s === 'continues') return 'var(--accent)';
  return 'var(--warning)';
}

export function PlanItemBadge({ day }: { day: PlanItemDay }) {
  const status = planItemStatus(day);
  if (!status) return null;
  const Icon = status === 'self' ? HikingIcon : status === 'idea' ? Compass : UserCheck;
  const color = statusColor(status);
  return (
    <span
      title={PLAN_ITEM_STATUS[status].hint}
      data-status={status}
      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
    >
      <Icon className="w-2.5 h-2.5" aria-hidden />
      {PLAN_ITEM_STATUS[status].label}
    </span>
  );
}
