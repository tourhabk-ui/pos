'use client';

import Link from 'next/link';
import {
  AlertTriangle, CloudRain, Construction, Mountain, PawPrint, Snowflake, TreePine, Waves,
  type LucideIcon,
} from 'lucide-react';
import type { ChangeKind, PlanChange } from '@/lib/home/plan-change';
import { useNewAlerts } from '@/hooks/use-new-alerts';

/**
 * Строки «Что меняет план» (десктоп). Клиентские ради одного: строку, которой
 * этот браузер ещё не показывал, один раз подсветить тинтом (12.11, «Перед
 * выходом» и на десктопе). Первый визит не подсвечивает ничего; при «уменьшить
 * движение» тинт появляется и уходит без перехода.
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

export function DeskChangeRows({ changes }: { changes: PlanChange[] }) {
  const fresh = useNewAlerts(changes.map((c) => c.key));
  return (
    <>
      {changes.map((c, i) => {
        const Icon = ICON[c.kind];
        return (
          <Link
            key={`${c.place ?? ''}${c.what}${i}`}
            href="/safety/incidents"
            data-new={fresh.has(c.key) ? 'true' : undefined}
            style={fresh.has(c.key) ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}
            className="group grid grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-4 border-t border-[var(--border)] py-5 no-underline transition-colors duration-1000 motion-reduce:transition-none hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)]"
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
              {c.term && <span className="text-[var(--text-secondary)]">{c.term}</span>}
            </span>
          </Link>
        );
      })}
    </>
  );
}
