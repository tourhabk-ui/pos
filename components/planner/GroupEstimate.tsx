'use client';

/**
 * Смета плана на группу (#2304) — строки «кол-во × цена» и итог.
 *
 * Считается не здесь: lib/planner/estimate.ts, та же формула, что у движка и
 * Кузьмича. Экран только показывает и подписывает: цена тура оператора и цена
 * выбранного жилья или перевозчика на платформе — это цены, всё остальное —
 * ориентир по средним ценам, и это сказано у каждой строки и под итогом.
 * Строка без цены в итог не входит и названа.
 */
import type { GroupEstimate } from '@/lib/planner/estimate';

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const range = ([a, b]: [number, number]) => (a === b ? `${fmt(a)} ₽` : `${fmt(a)} — ${fmt(b)} ₽`);

/** Откуда суммы итога — одной фразой, по тем источникам, что в итоге есть. */
function sourcesLine(fromTours: [number, number], fromOffers: [number, number], fromEstimates: [number, number]): string {
  const parts = [
    fromTours[1] > 0 ? `цены туров — от операторов (${range(fromTours)})` : null,
    fromOffers[1] > 0 ? `выбранные жильё и трансфер — по ценам на платформе (${range(fromOffers)})` : null,
  ].filter((x): x is string => x !== null);
  if (parts.length === 0) return 'Все суммы — ориентир по средним ценам, не предложения.';
  if (fromEstimates[1] === 0 && parts.length === 1) {
    return fromTours[1] > 0 ? 'Все суммы — цены туров от операторов.' : 'Все суммы — цены выбранных предложений на платформе.';
  }
  const text = [...parts, fromEstimates[1] > 0 ? `остальное — ориентир по средним ценам (${range(fromEstimates)}), не предложения` : null]
    .filter(Boolean).join(', ');
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

export function GroupEstimateBlock({ estimate }: { estimate: GroupEstimate }) {
  const { people, lines, total, perPerson, unpriced, assumptions, fromTours, fromOffers, fromEstimates } = estimate;
  const unpricedOffers = lines.some((l) => !l.total && l.source === 'offer');
  return (
    <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1" data-testid="price-estimate">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] px-1">
        Смета на группу · {people} чел.
      </p>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={`${l.kind}-${i}`} className="flex items-start justify-between gap-2 px-1">
            <span className="min-w-0">
              <span className="block text-[10px] text-[var(--text-secondary)]">{l.label}</span>
              <span className="block text-[9px] text-[var(--text-muted)]">
                {l.basis}{l.source === 'estimate' ? ' · ориентир' : l.source === 'offer' ? ' · выбрано' : ''}
              </span>
              {l.source !== 'estimate' && l.note && (
                <span className="block text-[9px] text-[var(--warning)]">{l.note}</span>
              )}
            </span>
            <span className="text-[10px] text-[var(--text-secondary)] shrink-0 text-right">
              {l.total ? range(l.total) : 'цена не указана'}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between px-1 pt-1 border-t border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Итого на группу</span>
        <span className="text-sm font-semibold text-[var(--accent)]">{range(total)}</span>
      </div>
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-[var(--text-muted)]">На человека</span>
        <span className="text-[10px] text-[var(--text-secondary)]">{range(perPerson)}</span>
      </div>
      {unpriced.length > 0 && (
        <p className="text-[9px] text-[var(--warning)] px-1">
          Не вошло в итог: {unpriced.join('; ')} — {unpricedOffers
            ? 'цену назовут оператор, хозяин жилья или перевозчик.'
            : 'сумму смотрите в карточке тура.'}
        </p>
      )}
      {assumptions.map((a) => (
        <p key={a} className="text-[9px] text-[var(--text-muted)] px-1">{a}</p>
      ))}
      <p className="text-[9px] text-[var(--text-muted)] px-1">
        {sourcesLine(fromTours, fromOffers, fromEstimates)}
        {' '}Без авиабилетов Москва — Камчатка (25 000-60 000 ₽). Смета пересчитывается после каждой правки плана.
      </p>
    </div>
  );
}
