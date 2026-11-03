/**
 * Наценка оператора на выходные (сб, вс) — запись и чтение (K.ai B1).
 *
 * Одна функция записи на все пути: экран «Скидки и наценки» на сайте и
 * подтверждение изменения из чата (B3). Владение туром — в самом запросе.
 * Наценка — правило `tour_pricing_rules` (`weekend_sat_sun`), а не правка
 * base_price: будни не меняются, уже оформленные брони — тоже (цена брони
 * записана в ней).
 */
import { markupToMultiplier, multiplierToMarkup } from '@/lib/tours/operator-discount';

interface Db { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }

export interface TourMarkup { tourId: number; title: string; basePrice: number; priceUnit: string; percent: number | null; ruleId: string | null }

export async function listWeekendMarkups(db: Db, operatorId: string): Promise<TourMarkup[]> {
  const { rows } = await db.query(
    `SELECT ot.id::int AS tour_id, ot.title, ot.base_price, ot.price_unit, pr.id::text AS rule_id, pr.multiplier
       FROM operator_tours ot
       LEFT JOIN tour_pricing_rules pr
         ON pr.operator_tour_id = ot.id AND pr.is_active = TRUE AND pr.rule_type = 'weekend_sat_sun'
      WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL
      ORDER BY ot.title`,
    [operatorId],
  );
  return rows.map((r) => ({
    tourId: Number(r.tour_id), title: r.title, basePrice: Number(r.base_price), priceUnit: r.price_unit,
    percent: r.multiplier != null ? multiplierToMarkup(r.multiplier) : null, ruleId: r.rule_id ?? null,
  }));
}

/**
 * Поставить (или заменить) наценку на туры оператора. percent=null — снять.
 * Возвращает id туров, которые реально изменены (чужие и удалённые — нет).
 */
export async function setWeekendMarkup(db: Db, operatorId: string, tourIds: readonly number[], percent: number | null): Promise<number[]> {
  const multiplier = percent === null ? null : markupToMultiplier(percent);
  if (percent !== null && multiplier === null) throw new RangeError('Наценка — целое число от 1 до 30%');
  const { rows: own } = await db.query(
    `SELECT id::int AS id FROM operator_tours WHERE id = ANY($1::int[]) AND operator_id = $2 AND deleted_at IS NULL`,
    [[...tourIds], operatorId],
  );
  const ids = own.map((r) => Number(r.id));
  if (ids.length === 0) return [];
  await db.query(
    `UPDATE tour_pricing_rules SET is_active = FALSE
      WHERE operator_tour_id = ANY($1::int[]) AND rule_type = 'weekend_sat_sun' AND is_active = TRUE`,
    [ids],
  );
  if (multiplier !== null) {
    await db.query(
      `INSERT INTO tour_pricing_rules (operator_tour_id, rule_type, multiplier, is_active)
       SELECT unnest($1::int[]), 'weekend_sat_sun', $2, TRUE`,
      [ids, multiplier],
    );
  }
  return ids;
}
