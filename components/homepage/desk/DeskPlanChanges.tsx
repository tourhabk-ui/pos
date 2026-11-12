import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { PlanChange } from '@/lib/home/plan-change';
import { DeskChangeRows } from './DeskChangeRows';
import { plural } from '@/lib/home/data-freshness';
import { SAFETY_FEEDS_TEXT } from '@/lib/safety/current-status';

/**
 * «Что меняет план» — лента предупреждений строками с местом, сутью, родом и
 * сроком (доска «Десктоп — сводка дня», 30.09). Та же лента, что на сайте и в
 * MCP; здесь только первые строки, остальные — по ссылке.
 *
 * Три исхода: список, «предупреждений нет» с перечнем лент, по которым это
 * известно, и «не смогли прочитать» — последнее не рисует пустоту.
 */

export function DeskPlanChanges({ changes: rows, feedCount, trusted }: {
  changes: PlanChange[] | null;
  feedCount: number | null;
  /** Лента свежая (DeskBrief.safetyTrusted): только тогда пустота значит «нет». */
  trusted: boolean;
}) {
  // Пустой список у молчащей ленты — не «нет предупреждений», а «не знаем».
  const changes = rows !== null && rows.length === 0 && !trusted ? null : rows;
  return (
    <div className="flex flex-col">
      <h2 className="mb-4 font-playfair text-4xl font-bold tracking-[-0.01em] text-[var(--text-primary)]">Что меняет план</h2>

      {changes === null && (
        <p className="border-t border-[var(--border)] py-5 text-[15px] leading-relaxed text-[var(--text-secondary)]">
          Ленту предупреждений сейчас прочитать не удалось. Это не значит, что их нет — проверьте обстановку перед выходом.
        </p>
      )}

      {changes !== null && changes.length === 0 && (
        <div className="border-t border-[var(--border)] py-5">
          <p className="text-lg font-semibold text-[var(--text-primary)]">Предупреждений, меняющих планы, сейчас нет</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">Проверено по лентам: {SAFETY_FEEDS_TEXT}</p>
        </div>
      )}

      {changes && changes.length > 0 && <DeskChangeRows changes={changes} />}

      <Link
        href="/safety/incidents"
        className="group flex min-h-[56px] items-center justify-between border-t border-[var(--border)] text-base font-semibold text-[var(--ocean)] no-underline hover:no-underline"
      >
        {feedCount != null && feedCount > 0
          ? `${feedCount === 1 ? 'Предупреждение' : `Все ${feedCount} ${plural(feedCount, 'предупреждение', 'предупреждения', 'предупреждений')}`} с источниками`
          : 'Вся обстановка в крае'}
        <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
      </Link>
    </div>
  );
}
