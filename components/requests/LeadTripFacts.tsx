import { tripFactsOf, tripRequestLines } from '@/lib/planner/trip-request-lines';

/**
 * «Из заявки» в карточке оператора (проверка сценариев 07.11): даты, состав,
 * пожелания из анкеты и план поездки — те же строки, что видел человек в
 * сводке формы и что получил менеджер. До этого карточка рисовала только
 * комментарий, и оператор переспрашивал то, что турист уже выбрал.
 * Нечего показать — блока нет.
 */
export function LeadTripFacts({ sourceData }: { sourceData: unknown }) {
  const lines = tripRequestLines(tripFactsOf(sourceData));
  if (lines.length === 0) return null;
  return (
    <section aria-label="Из заявки" className="rounded-lg border border-[var(--border)] p-3 space-y-0.5">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Из заявки</p>
      <ul className="space-y-0.5">
        {lines.map((line) => (
          <li key={line} className="text-sm text-[var(--text-secondary)]">{line}</li>
        ))}
      </ul>
    </section>
  );
}
