/**
 * lib/planner/tour-price.ts — цена тура в плане по правилу брони (#2304).
 *
 * ── Что нашлось 09.10 ──────────────────────────────────────────────────────
 *
 * План брал `base_price` тура как есть, а бронь считает цену через
 * `honestTourPrice` (lib/tours/honest-price): ступени по размеру группы
 * (`tour_price_tiers`, миграция 1173) и правила цены на дату. У одиннадцати
 * туров «Края Вулканов» ступени есть (миграция 1176), и у большинства нижняя
 * начинается с шести человек. Паре туристов бронь отвечает «цену называет
 * оператор», а смета плана показывала базовую цену, умноженную на двоих, —
 * сумму, которую не назовёт никто. Группе от девяти бронь даёт цену ступени,
 * а план — заголовочную, на четверть выше.
 *
 * Здесь та же функция, что у брони и у `get_tour_availability`, на дату дня
 * плана: дата есть — правила на эту дату и заполненность; даты нет — только
 * ступени (они от даты не зависят).
 *
 * Исходов два, и третий спрятан во втором намеренно: группа вне ступеней и
 * «не смогли прочитать» оба значат «цены для этой группы у плана нет». Текст у
 * них разный, а отказ чтения ещё и пишется в лог (§4.0) — молча подставить
 * базовую цену значило бы выдать незнание за цену.
 */
import { honestTourPrice, composeHonestPrice, loadPriceTiers } from '@/lib/tours/honest-price';
import { PriceTierMissError, PRICE_TIER_MISS_TEXT } from '@/lib/tours/price-tiers';

export type PlanTourPrice =
  | { kind: 'priced'; unitPrice: number; label: string | null }
  | { kind: 'missing'; text: string };

/** Текст, когда цену не удалось проверить: базовую подставлять нельзя. */
export const PRICE_UNREAD_TEXT = 'Цену тура для вашей группы проверить не удалось — она в карточке тура.';

export async function planTourPrice(input: {
  tourId: string;
  basePrice: number;
  priceUnit: string;
  participants: number;
  multiDayCount: number | null;
  durationHours: number | null;
  /** Дата дня плана, `YYYY-MM-DD`; null — план без дат. */
  tourDate: string | null;
}): Promise<PlanTourPrice> {
  const duration = { multi_day_count: input.multiDayCount, duration_hours: input.durationHours };
  try {
    const honest = input.tourDate
      ? await honestTourPrice({
        tourId: input.tourId, tourDate: input.tourDate,
        baseUnitPrice: input.basePrice, priceUnit: input.priceUnit,
        participants: input.participants, duration,
      })
      : composeHonestPrice({
        baseUnitPrice: input.basePrice, priceUnit: input.priceUnit,
        participants: input.participants, duration,
        // Без даты правила (сезон, раннее бронирование) применять не к чему.
        rules: [], ctx: { tourDate: '', guests: input.participants, occupancyPct: 0 },
        tiers: await loadPriceTiers(input.tourId),
      });
    return { kind: 'priced', unitPrice: honest.finalUnitPrice, label: honest.label };
  } catch (err) {
    if (err instanceof PriceTierMissError) return { kind: 'missing', text: PRICE_TIER_MISS_TEXT(input.participants) };
    const e = err as { code?: string; message?: string };
    console.error('[planner] цена тура не посчитана', { tourId: input.tourId, sqlstate: e?.code ?? null, message: e?.message ?? null });
    return { kind: 'missing', text: PRICE_UNREAD_TEXT };
  }
}
