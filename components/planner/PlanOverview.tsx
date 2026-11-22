'use client';

/**
 * Шапка готового плана: сколько дней, даты, состав и смета «посчитано X из Y»
 * на видном месте (раньше смета стояла под всеми днями). Сумма — только из
 * цен с источником (lib/planner/estimate); ни одной — так и сказано.
 */
import { countedLine, NO_PRICES_YET, type GroupEstimate } from '@/lib/planner/estimate';

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const rub = ([a, b]: [number, number]) => (a === b ? `${fmt(a)} ₽` : `${fmt(a)} — ${fmt(b)} ₽`);

export function PlanOverview({ title, sub, estimate, estimateAnchor }: {
  title: string;
  sub: string;
  estimate: GroupEstimate | null;
  estimateAnchor?: string;
}) {
  const priced = estimate ? estimate.lines.some((l) => l.total) : false;
  return (
    <section data-plan-overview className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
      <div className="px-4 pt-4 pb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">Ваш план</p>
        <h2 className="mt-1 text-xl font-semibold leading-tight text-[var(--text-primary)]">{title}</h2>
        {sub && <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{sub}</p>}
      </div>
      {estimate && (
        <a href={estimateAnchor ? `#${estimateAnchor}` : undefined} data-overview-estimate
          className="flex items-end justify-between gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-hover)] hover:bg-[var(--bg-primary)] transition-colors">
          <span className="min-w-0">
            <span className="block text-[11px] text-[var(--text-muted)]">Смета на группу · {estimate.people} чел.</span>
            <span className="block text-[13px] font-medium text-[var(--text-primary)]">{countedLine(estimate.lines)}</span>
          </span>
          <span className="text-right shrink-0">
            <span className="block text-lg font-semibold text-[var(--text-primary)]">{priced ? rub(estimate.total) : 'не посчитано'}</span>
            <span className="block text-[11px] text-[var(--text-muted)]">{priced ? `на человека ${rub(estimate.perPerson)}` : NO_PRICES_YET}</span>
          </span>
        </a>
      )}
      <p className="px-4 py-2 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)]">
        Заявка — не бронь: места, даты и цены подтверждает оператор.
      </p>
    </section>
  );
}
