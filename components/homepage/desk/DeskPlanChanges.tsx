import Link from 'next/link';
import {
  AlertTriangle, ArrowRight, CloudRain, Construction, Mountain, PawPrint, Snowflake, TreePine, Waves,
  type LucideIcon,
} from 'lucide-react';
import type { ChangeKind, PlanChange } from '@/lib/home/desk-brief';
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

const ICON: Record<ChangeKind, LucideIcon> = {
  road: Construction,
  volcano: Mountain,
  water: Waves,
  snow: Snowflake,
  weather: CloudRain,
  bear: PawPrint,
  park: TreePine,
  other: AlertTriangle,
};

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

      {changes?.map((c, i) => {
        const Icon = ICON[c.kind];
        return (
          <Link
            key={`${c.place ?? ''}${c.what}${i}`}
            href="/safety/incidents"
            className="group grid grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-4 border-t border-[var(--border)] py-5 no-underline transition-colors duration-200 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)]"
          >
            <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--bg-hover)] text-[var(--accent)] transition-transform duration-200 group-hover:scale-105">
              <Icon size={18} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              {c.place && <span className="text-lg font-semibold leading-snug text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors duration-200">{c.place}</span>}
              <span className={c.place ? 'text-[15px] leading-snug text-[var(--text-secondary)]' : 'text-lg font-semibold leading-snug text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors duration-200'}>
                {c.what}
              </span>
              <span className="text-xs text-[var(--text-secondary)]">{c.origin}</span>
            </span>
            <span className="flex min-w-[112px] flex-col items-end gap-1 pt-1 text-right text-[13px] text-[var(--text-secondary)]">
              <span>{c.kindLabel}</span>
              {c.until && <span className="text-[var(--text-secondary)]">{c.until}</span>}
            </span>
          </Link>
        );
      })}

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
