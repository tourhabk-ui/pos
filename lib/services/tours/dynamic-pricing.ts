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

interface PriceCalcResult {
  basePrice:      number;
  finalPrice:     number;
  discount:       number;
  multiplier:     number;
  appliedRules:   string[];
}

/**
 * `calculateDynamicPrice` УДАЛЁН 27.09 — его заменил `honestTourPrice`
 * (`lib/tours/honest-price.ts`).
 *
 * Разница не в имени. Старая функция отдавала цену ЗА ЕДИНИЦУ, и вызывающий
 * дальше сам решал, умножать её на людей или нет; новая композирует правила с
 * `bookingTotal` — тем же правилом единицы цены, которым считают все двери
 * брони, — и потому её ответ годится и для экрана, и для счёта. Оставлять
 * рядом обе значило бы завести второй способ получить цену: ровно то, из-за
 * чего цикл сопоставления правил в этом файле разошёлся сам с собой.
 *
 * Нашёл смерть функции не человек, а перепись экспортов
 * (`tests/unit/export-census-frozen.test.ts`): после переезда эндпоинта на
 * новое правило она осталась экспортированной и никому не нужной.
 */

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
