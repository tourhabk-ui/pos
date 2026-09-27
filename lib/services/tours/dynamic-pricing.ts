/**
 * Dynamic Pricing Service
 *
 * Сопоставление правил вынесено 27.09 в `lib/tours/pricing-rule-match` — оно
 * было написано здесь ДВАЖДЫ, по пятьдесят строк в каждой функции, и уже
 * разошлось: занятость одиночный расчёт брал из `v_tour_daily_occupancy`
 * (реальные брони), а bulk — из счётчика `booked_slots`, который видит только
 * оплаченных. На один и тот же тур и день два места платформы отвечали разной
 * ценой, причём bulk зовёт `/api/octo/availability`, то есть чужой канал.
 * Теперь источник занятости один у обеих функций.
 *
 * Рассчитывает итоговую цену тура с учётом:
 *   - season_peak / season_low (дата в диапазоне)
 *   - early_bird             (бронирование за N+ дней)
 *   - last_minute            (бронирование за N- дней)
 *   - occupancy_high         (загрузка слота >= X%)
 *   - group_discount         (гостей >= N)
 *   - weekend                (пятница–воскресенье)
 *
 * Множители применяются все подходящие правила (перемножаются).
 * Итоговая цена округляется до 100 руб.
 */

import { pool } from '@/lib/db-pool';
import { matchPricingRules, finalUnitPrice, type PricingRule } from '@/lib/tours/pricing-rule-match';

interface PriceCalcInput {
  tourId:    number | string;
  tourDate:  string;          // YYYY-MM-DD
  guests:    number;
  basePrice: number;
}

interface PriceCalcResult {
  basePrice:      number;
  finalPrice:     number;
  discount:       number;   // < 0 = скидка, > 0 = надбавка (в рублях)
  multiplier:     number;   // итоговый множитель (1.15 = +15%)
  appliedRules:   string[]; // список сработавших правил
}

export async function calculateDynamicPrice(input: PriceCalcInput): Promise<PriceCalcResult> {
  const { tourId, tourDate, guests, basePrice } = input;

  // Загружаем активные правила для тура
  const { rows: rules } = await pool.query<PricingRule>(
    `SELECT rule_type, date_from, date_to, days_before_min, days_before_max,
            occupancy_min, guests_min, multiplier
     FROM tour_pricing_rules
     WHERE operator_tour_id = $1 AND is_active = TRUE`,
    [tourId]
  );

  if (rules.length === 0) {
    return { basePrice, finalPrice: basePrice, discount: 0, multiplier: 1, appliedRules: [] };
  }

  // Загружаем текущую загрузку слота (если есть). Занятость — из реальных
  // броней (v_tour_daily_occupancy), не из счётчика booked_slots: счётчик
  // видит только оплаченных, и occupancy-сюрдж недо-срабатывал, пока
  // неоплаченные заявки заполняли даты.
  const { rows: slotRows } = await pool.query<{ available_slots: number | null; booked_slots: number }>(
    `SELECT ta.available_slots, COALESCE(occ.occupied, 0)::int AS booked_slots
     FROM tour_availability ta
     LEFT JOIN v_tour_daily_occupancy occ
       ON occ.operator_tour_id = ta.operator_tour_id AND occ.date = ta.date
     WHERE ta.operator_tour_id = $1 AND ta.date = $2 AND ta.is_cancelled = FALSE`,
    [tourId, tourDate]
  );

  let occupancyPct = 0;
  if (slotRows.length > 0 && slotRows[0].available_slots) {
    const total = slotRows[0].available_slots;
    const booked = slotRows[0].booked_slots;
    occupancyPct = total > 0 ? Math.round((booked / total) * 100) : 0;
  }

  const { multiplier, appliedRules } = matchPricingRules(rules, { tourDate, guests, occupancyPct });
  const finalPrice = finalUnitPrice(basePrice, multiplier);

  return {
    basePrice,
    finalPrice,
    discount: finalPrice - basePrice,
    multiplier,
    appliedRules,
  };
}

/**
 * Bulk расчёт для списка дат (для календаря доступности).
 * Делает ровно 2 запроса к БД независимо от количества дат:
 *   1. Загрузка правил тура (один раз)
 *   2. Загрузка занятости слотов для всех дат (батч)
 */
export async function bulkDynamicPrices(
  tourId: number | string,
  dates: string[],
  guests: number,
  basePrice: number
): Promise<Record<string, PriceCalcResult>> {
  if (dates.length === 0) return {};

  // 1. Загружаем правила один раз
  const { rows: rules } = await pool.query<PricingRule>(
    `SELECT rule_type, date_from, date_to, days_before_min, days_before_max,
            occupancy_min, guests_min, multiplier
     FROM tour_pricing_rules
     WHERE operator_tour_id = $1 AND is_active = TRUE`,
    [tourId]
  );

  // 2. Занятость всех запрошенных слотов одним запросом.
  //
  // Источник — v_tour_daily_occupancy (реальные брони), тот же, что у
  // одиночного расчёта. До 27.09 здесь стоял COALESCE(booked_slots, 0): счётчик
  // видит только ОПЛАЧЕННЫХ, и надбавка occupancy_high по нему не срабатывала,
  // пока дату занимали неоплаченные заявки. Расхождение доставалось чужому
  // каналу: bulk зовёт /api/octo/availability.
  const { rows: slotRows } = await pool.query<{ date: string; available_slots: number | null; booked_slots: number }>(
    `SELECT ta.date::text AS date, ta.available_slots,
            COALESCE(occ.occupied, 0)::int AS booked_slots
       FROM tour_availability ta
       LEFT JOIN v_tour_daily_occupancy occ
         ON occ.operator_tour_id = ta.operator_tour_id AND occ.date = ta.date
      WHERE ta.operator_tour_id = $1
        AND ta.date = ANY($2::date[])
        AND ta.is_cancelled = FALSE`,
    [tourId, dates]
  );

  const slotMap: Record<string, { available: number | null; booked: number }> = {};
  for (const row of slotRows) {
    slotMap[row.date] = { available: row.available_slots, booked: row.booked_slots };
  }

  const results: Record<string, PriceCalcResult> = {};

  // 3. Цена каждой даты — тем же правилом, что у одиночного расчёта.
  for (const date of dates) {
    const slot = slotMap[date];
    const total = slot?.available ?? 0;
    const occupancyPct = total > 0 ? Math.round(((slot?.booked ?? 0) / total) * 100) : 0;
    const { multiplier, appliedRules } = matchPricingRules(rules, { tourDate: date, guests, occupancyPct });
    const finalPrice = finalUnitPrice(basePrice, multiplier);
    results[date] = {
      basePrice,
      finalPrice,
      discount: finalPrice - basePrice,
      multiplier,
      appliedRules,
    };
  }

  return results;
}
