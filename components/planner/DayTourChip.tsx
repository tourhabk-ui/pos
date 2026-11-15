/**
 * Ссылка «оставить заявку» на тур дня в карточке дня планировщика.
 * Правило тура и цены — lib/planner/day-tour-chip (разбор планера 14.11).
 */
import { Star } from 'lucide-react';
import { dayTourPriceText, type DayTourChip as Chip } from '@/lib/planner/day-tour-chip';

export function DayTourChip({ chip, href }: { chip: Chip; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Открыть тур и оставить заявку"
      data-testid="day-tour-chip"
      className="flex items-center justify-between gap-2 mx-3 mb-2.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-hover)] border border-[var(--border)] hover:border-[var(--ocean)] transition-colors"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Star className="w-3 h-3 text-[var(--warning)] shrink-0" />
        <span className="text-[10px] text-[var(--text-secondary)] truncate">{chip.title}</span>
        {chip.other_zone && (
          <span className="text-[10px] text-[var(--warning)] whitespace-nowrap">· в другой зоне</span>
        )}
      </div>
      <span className="text-[10px] font-semibold text-[var(--ocean)] whitespace-nowrap">
        {dayTourPriceText(chip)} · оставить заявку
      </span>
    </a>
  );
}
