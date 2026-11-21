'use client';

/**
 * Смета плана на группу (#2304) — строки «кол-во × цена» и итог.
 *
 * Считается не здесь: lib/planner/estimate.ts, та же формула, что у движка и
 * Кузьмича. Экран только показывает и подписывает. Сумма — только из цен с
 * источником: цена тура оператора и цена выбранного жилья на платформе (слово
 * владельца 14.11 «5 -1»). Строки без суммы — занятия без тура, проживание,
 * переезды, трансфер — говорят, кто называет цену, и в итог не входят.
 */
// Кто назовёт цену строк без суммы — правило сметы, общее с ответом Кузьмича.
import { countedLine, NO_PRICES_YET, unpricedTail, type GroupEstimate } from '@/lib/planner/estimate';

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const range = ([a, b]: [number, number]) => (a === b ? `${fmt(a)} ₽` : `${fmt(a)} — ${fmt(b)} ₽`);

/** Откуда суммы итога — одной фразой, по тем источникам, что в итоге есть. */
function sourcesLine(fromTours: [number, number], fromOffers: [number, number]): string {
  const parts = [
    fromTours[1] > 0 ? `цены туров — от операторов (${range(fromTours)})` : null,
    fromOffers[1] > 0 ? `выбранное жильё — по ценам на платформе (${range(fromOffers)})` : null,
  ].filter((x): x is string => x !== null);
  if (parts.length === 1) {
    return fromTours[1] > 0 ? 'Итог — цены туров от операторов.' : 'Итог — цены выбранного жилья на платформе.';
  }
  const text = parts.join(', ');
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

export function GroupEstimateBlock({ estimate }: { estimate: GroupEstimate }) {
  const { people, lines, total, perPerson, unpriced, assumptions, fromTours, fromOffers } = estimate;
  // Ни у одной строки нет суммы — итога нет, а не «0 ₽» (разбор планера 14.11,
  // смета-2): ноль читался как «бесплатно».
  const priced = lines.some((l) => l.total);
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
                {l.basis}{l.source === 'offer' ? ' · выбрано' : ''}
              </span>
              {l.note && (
                <span className="block text-[9px] text-[var(--warning)]">{l.note}</span>
              )}
            </span>
            <span className="text-[10px] text-[var(--text-secondary)] shrink-0 text-right">
              {l.total ? range(l.total) : 'цены нет'}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between px-1 pt-1 border-t border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Итого на группу</span>
        <span className="text-sm font-semibold text-[var(--accent)]">{priced ? range(total) : 'не посчитано'}</span>
      </div>
      {/* Сколько строк вошло в итог (кейс владельца 21.11). */}
      <p className="text-[10px] text-[var(--text-muted)] px-1" data-estimate-counted>{countedLine(lines)}</p>
      {priced ? (
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] text-[var(--text-muted)]">На человека</span>
          <span className="text-[10px] text-[var(--text-secondary)]">{range(perPerson)}</span>
        </div>
      ) : (
        <p className="text-[10px] text-[var(--text-secondary)] px-1">{NO_PRICES_YET}</p>
      )}
      {priced && unpriced.length > 0 && (
        <p className="text-[9px] text-[var(--warning)] px-1">
          Не вошло в итог: {unpriced.join('; ')} — {unpricedTail(lines)}
        </p>
      )}
      {assumptions.map((a) => (
        <p key={a} className="text-[9px] text-[var(--text-muted)] px-1">{a}</p>
      ))}
      <p className="text-[9px] text-[var(--text-muted)] px-1">
        {priced ? `${sourcesLine(fromTours, fromOffers)} ` : ''}Без авиабилетов до Камчатки. Смета пересчитывается после каждой правки плана.
      </p>
    </div>
  );
}
