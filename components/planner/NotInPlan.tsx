'use client';

/**
 * «Этого в плане нет» — что из просьбы не вошло и почему, спокойным списком
 * (слово владельца 22.11: план — не стопка предупреждений). Строки — от
 * движка или факт «дня с этим нет», причин не придумываем.
 */
import { MinusCircle } from 'lucide-react';

export const NOT_IN_PLAN_TITLE = 'Этого в плане нет';

export function NotInPlan({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <section aria-label={NOT_IN_PLAN_TITLE} data-not-in-plan
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <MinusCircle className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-hidden="true" />
        {NOT_IN_PLAN_TITLE}
      </p>
      <ul className="mt-2 space-y-1.5">
        {lines.map((l) => (
          <li key={l} className="text-[13px] leading-snug text-[var(--text-secondary)] pl-6">{l}</li>
        ))}
      </ul>
    </section>
  );
}
