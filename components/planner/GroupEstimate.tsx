'use client';

/**
 * Смета плана на группу (#2304) — строки «кол-во × цена» и итог.
 *
 * Считается не здесь: lib/planner/estimate.ts, та же формула, что у движка и
 * Кузьмича. Экран только показывает и подписывает: цена тура оператора — это
 * цена, всё остальное — ориентир по средним ценам, и это сказано у каждой
 * строки и под итогом. Строка без цены в итог не входит и названа.
 */
import type { GroupEstimate } from '@/lib/planner/estimate';

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const range = ([a, b]: [number, number]) => (a === b ? `${fmt(a)} ₽` : `${fmt(a)} — ${fmt(b)} ₽`);

export function GroupEstimateBlock({ estimate }: { estimate: GroupEstimate }) {
  const { people, lines, total, perPerson, unpriced, assumptions, fromTours, fromEstimates } = estimate;
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
                {l.basis}{l.source === 'estimate' ? ' · ориентир' : ''}
              </span>
              {l.source === 'tour' && l.note && (
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
          Не вошло в итог: {unpriced.join('; ')} — сумму смотрите в карточке тура.
        </p>
      )}
      {assumptions.map((a) => (
        <p key={a} className="text-[9px] text-[var(--text-muted)] px-1">{a}</p>
      ))}
      <p className="text-[9px] text-[var(--text-muted)] px-1">
        {fromTours[1] > 0 && fromEstimates[1] > 0
          ? `Цены туров — от операторов (${range(fromTours)}), остальное — ориентир по средним ценам (${range(fromEstimates)}), не предложения.`
          : fromTours[1] > 0
            ? 'Все суммы — цены туров от операторов.'
            : 'Все суммы — ориентир по средним ценам, не предложения.'}
        {' '}Без авиабилетов Москва — Камчатка (25 000-60 000 ₽). Смета пересчитывается после каждой правки плана.
      </p>
    </div>
  );
}
