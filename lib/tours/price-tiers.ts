/**
 * Цена тура по размеру группы — чистое правило, без БД.
 *
 * У «Края Вулканов» одна и та же поездка стоит по-разному: облёт Ключевской —
 * 520 000 ₽ с человека при группе от 6 и 410 000 ₽ от 9. Одним `base_price`
 * это не записать, а запись «от 410 000» выдавала бы туристу из шести цену
 * девяти. Ступени живут в `tour_price_tiers` (миграция 1173).
 *
 * У ответа ТРИ исхода (§4.0), и третий не равен первому:
 *   none — у тура нет ступеней, действует `base_price`, как до 07.10;
 *   hit  — группа попала в ступень, цена за человека известна;
 *   miss — ступени есть, но размер группы ни в одну не входит (или единица
 *          цены не «за человека»). Суммы НЕТ: «цена уточняется у оператора».
 *          Подставить ближайшую ступень значило бы назвать цену, которой
 *          оператор не обещал.
 *
 * Перекрытие диапазонов берётся по самой конкретной ступени — с большим
 * `min_people`: база перекрытие не запрещает.
 */
import { normalizePriceUnit } from '@/lib/tours/booking-total';

export interface PriceTier {
  min_people: number;
  /** null — верхней границы нет («от 9 и больше»). */
  max_people: number | null;
  price_per_person: number;
}

export type TierPick =
  | { kind: 'none' }
  | { kind: 'hit'; pricePerPerson: number; tier: PriceTier }
  | { kind: 'miss'; reason: 'out_of_range' | 'unit_not_per_person' };

export function pickPriceTier(
  tiers: readonly PriceTier[],
  people: number,
  priceUnit: string | null | undefined,
): TierPick {
  if (tiers.length === 0) return { kind: 'none' };
  // Ступени задают цену ЗА ЧЕЛОВЕКА. У тура «за группу» или «за день» они
  // означали бы другое: сумма, названная по такой смеси, была бы выдумкой.
  if (normalizePriceUnit(priceUnit) !== 'per_person') return { kind: 'miss', reason: 'unit_not_per_person' };
  const n = Number.isFinite(people) && people > 0 ? Math.floor(people) : 1;
  const fitting = tiers
    .filter((t) => n >= t.min_people && (t.max_people === null || n <= t.max_people))
    .sort((a, b) => b.min_people - a.min_people);
  const best = fitting[0];
  return best
    ? { kind: 'hit', pricePerPerson: best.price_per_person, tier: best }
    : { kind: 'miss', reason: 'out_of_range' };
}

/** Размер группы вне ступеней: суммы нет, это не «ноль» и не «базовая цена». */
export class PriceTierMissError extends Error {
  constructor(
    public readonly people: number,
    public readonly reason: 'out_of_range' | 'unit_not_per_person',
  ) {
    super(PRICE_TIER_MISS_TEXT(people));
    this.name = 'PriceTierMissError';
  }
}

/** Текст человеку — один на все двери (форма, чат, MCP, заявка на места). */
export const PRICE_TIER_MISS_TEXT = (people: number): string =>
  `Для группы из ${people} чел. цену называет оператор отдельно: оставьте заявку, и он пришлёт её.`;
