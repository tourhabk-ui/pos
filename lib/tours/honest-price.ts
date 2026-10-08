/**
 * lib/tours/honest-price.ts — ЦЕНА, КОТОРУЮ ВИДИТ ТУРИСТ, И ЦЕНА В СЧЁТЕ — ОДНА.
 *
 * ── Что нашлось 27.09 (владелец: «им главное скидки») ─────────────────────
 *
 * Движок скидок в платформе был, применялся и туристу не показывался:
 *
 *   - `tour_pricing_rules` умеет `last_minute`, `early_bird`, `season_low`,
 *     `season_peak`, `weekend`, `group_discount`, `occupancy_high`;
 *   - `calculateDynamicPrice` их применяет, `GET /api/tours/[id]/price` отдаёт;
 *   - и этот эндпоинт НЕ ЗОВЁТСЯ ни с одной страницы сайта. Карточка тура
 *     рисует `base_price` и рукописную зачёркнутую `price_old`;
 *   - зато `bulkDynamicPrices` зовётся из `/api/octo/availability` — то есть
 *     динамическую цену получал ЧУЖОЙ канал, а наш турист нет.
 *
 * ── Почему нельзя было начать с показа ────────────────────────────────────
 *
 * `lib/bookings/reserve.ts` считал итог как `bookingTotal(base_price × …)`,
 * мимо правил. Подключи правила к карточке и не к брони — человек увидел бы
 * «−15%, последние места», а в заявке и в письме получил полную сумму. Это
 * хуже, чем не показывать скидку вовсе: обещание цены, которое платформа не
 * держит. Поэтому правило одно и на показ, и на счёт, и живёт оно здесь.
 *
 * Это тот же довод, по которому заведён `lib/tours/booking-total.ts`: там
 * шесть дверей считали сумму сами и одинаково неверно для двух единиц цены
 * из трёх. Здесь дверей будет столько же, и считать они обязаны одинаково.
 *
 * ── Что это НЕ делает ─────────────────────────────────────────────────────
 *
 * Скидку не выдумывает. Нет активных правил — `finalUnitPrice` равен
 * базовому, `label` равен `null`, и на экране всё как было. Сколько правил на
 * проде, говорит перепись `GET /api/cron/pricing-rules-census`, а не эта
 * шапка.
 */
import { pool } from '@/lib/db-pool';
import type { QueryResult, QueryResultRow } from 'pg';
import { bookingTotal, type BookingTotalInput } from '@/lib/tours/booking-total';
import { pickPriceTier, PriceTierMissError, type PriceTier } from '@/lib/tours/price-tiers';
import {
  matchPricingRules, finalUnitPrice, type PricingRule, type RuleContext,
} from '@/lib/tours/pricing-rule-match';

/** Подписи родов правил — для человека, не для лога. */
export const RULE_LABEL: Record<string, string> = {
  last_minute: 'последние места',
  early_bird: 'раннее бронирование',
  season_low: 'низкий сезон',
  season_peak: 'высокий сезон',
  weekend: 'выходной день',
  group_discount: 'групповая скидка',
  occupancy_high: 'дата почти заполнена',
};

export interface HonestPrice {
  /** Цена за единицу, как записал оператор. */
  baseUnitPrice: number;
  /** Цена за единицу после правил. Равна базовой, если правил нет. */
  finalUnitPrice: number;
  /** Итог брони по базовой цене — то, что зачёркивают. */
  baseTotal: number;
  /** Итог брони по цене после правил. Именно он идёт в счёт. */
  total: number;
  /** Рода сработавших правил. */
  appliedRules: string[];
  /** Произведение множителей. 1 — цена не изменилась. */
  multiplier: number;
  /**
   * На сколько процентов цена отличается от базовой: отрицательное — скидка,
   * положительное — надбавка, `null` — не изменилась.
   *
   * `null`, а не 0: «скидки нет» и «скидка ноль процентов» человеку читаются
   * по-разному, и рисовать «−0%» нельзя.
   */
  changePercent: number | null;
  /**
   * Строка для экрана: «−15%, последние места». `null` — показывать нечего.
   *
   * Цена без объяснения хуже базовой: человек сверяет её с каталогом и не
   * понимает, почему числа разные.
   */
  label: string | null;
}

/** Подпись к изменённой цене. `null` — цена не менялась. */
export function priceLabel(multiplier: number, appliedRules: string[]): string | null {
  if (multiplier === 1 || appliedRules.length === 0) return null;
  const pct = Math.round((multiplier - 1) * 100);
  if (pct === 0) return null;
  const reasons = appliedRules
    .map((r) => RULE_LABEL[r])
    .filter((r): r is string => Boolean(r));
  const sign = pct < 0 ? '−' : '+';
  const head = `${sign}${Math.abs(pct)}%`;
  return reasons.length > 0 ? `${head}, ${reasons.join(', ')}` : head;
}

/** Процент отличия от базовой цены; `null` — не отличается. */
export function changePercentOf(multiplier: number): number | null {
  if (multiplier === 1) return null;
  const pct = Math.round((multiplier - 1) * 100);
  return pct === 0 ? null : pct;
}

export interface HonestPriceInput {
  baseUnitPrice: number;
  priceUnit: string | null | undefined;
  participants: number;
  duration?: BookingTotalInput['duration'];
  rules: PricingRule[];
  ctx: RuleContext;
  /**
   * Ступени цены по размеру группы (миграция 1173). Не переданы или пусты —
   * цена тура одна, `baseUnitPrice`. Группа вне ступеней — `PriceTierMissError`:
   * суммы нет, и подставлять базовую цену нельзя.
   */
  tiers?: PriceTier[];
}

/**
 * Чистая часть: правила уже прочитаны, занятость уже посчитана.
 *
 * Отдельно от запросов намеренно — так её судит юнит-тест напрямую, без мока
 * базы, который ответил бы что угодно.
 */
export function composeHonestPrice(rawInput: HonestPriceInput): HonestPrice {
  // Ступень задаёт БАЗУ: правила (сезон, раннее бронирование, заполненность,
  // скидка за группу) применяются поверх неё, как поверх обычной цены тура.
  const pick = pickPriceTier(rawInput.tiers ?? [], rawInput.participants, rawInput.priceUnit);
  if (pick.kind === 'miss') throw new PriceTierMissError(rawInput.participants, pick.reason);
  const input: HonestPriceInput = pick.kind === 'hit'
    ? { ...rawInput, baseUnitPrice: pick.pricePerPerson }
    : rawInput;
  const { multiplier, appliedRules } = matchPricingRules(input.rules, input.ctx);
  const unitPrice = finalUnitPrice(input.baseUnitPrice, multiplier);
  const common = {
    priceUnit: input.priceUnit,
    participants: input.participants,
    duration: input.duration,
  };
  return {
    baseUnitPrice: input.baseUnitPrice,
    finalUnitPrice: unitPrice,
    baseTotal: bookingTotal({ ...common, basePrice: input.baseUnitPrice }),
    total: bookingTotal({ ...common, basePrice: unitPrice }),
    appliedRules,
    multiplier,
    changePercent: changePercentOf(multiplier),
    label: priceLabel(multiplier, appliedRules),
  };
}

/**
 * Активные правила тура и занятость даты — одним источником для всех дверей.
 *
 * Занятость берётся из `v_tour_daily_occupancy` (реальные брони), а не из
 * счётчика `booked_slots`: счётчик видит только оплаченных, и надбавка за
 * заполненность по нему недо-срабатывает, пока дату занимают неоплаченные
 * заявки. До 27.09 bulk-расчёт читал именно счётчик — отсюда разная цена на
 * один и тот же день у нашего эндпоинта и у чужого канала.
 */
/**
 * Кто выполняет запросы: пул или КЛИЕНТ ОТКРЫТОЙ ТРАНЗАКЦИИ.
 *
 * Для брони это обязательно клиент: `reserveBooking` держит `FOR UPDATE` на
 * строке тура, и занятость, прочитанная мимо транзакции, вторым соединением,
 * не увидела бы ни лока, ни только что вставленных строк — цена считалась бы
 * по устаревшей заполненности даты.
 */
export interface PricingExecutor {
  query<R extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * Ступени цены тура (миграция 1173). Пустой массив — «ступеней нет, цена одна».
 * Отказ запроса НЕ превращается в пустой массив: тур со ступенями, прочитанный
 * как «без ступеней», получил бы базовую цену вместо ступенчатой (§4.0).
 */
export async function loadPriceTiers(
  tourId: number | string,
  exec: PricingExecutor = pool,
): Promise<PriceTier[]> {
  const res = await exec.query<{ min_people: number; max_people: number | null; price_per_person: string }>(
    `SELECT min_people, max_people, price_per_person
       FROM tour_price_tiers
      WHERE operator_tour_id = $1
      ORDER BY min_people`,
    [tourId],
  );
  return res.rows.map((r) => ({
    min_people: Number(r.min_people),
    max_people: r.max_people === null ? null : Number(r.max_people),
    price_per_person: Number(r.price_per_person),
  }));
}

export async function loadPricingContext(
  tourId: number | string,
  tourDate: string,
  exec: PricingExecutor = pool,
): Promise<{ rules: PricingRule[]; occupancyPct: number; tiers: PriceTier[] }> {
  const [ruleRes, slotRes, tierRes] = await Promise.all([
    exec.query<PricingRule>(
      `SELECT rule_type, date_from, date_to, days_before_min, days_before_max,
              occupancy_min, guests_min, multiplier
         FROM tour_pricing_rules
        WHERE operator_tour_id = $1 AND is_active = TRUE`,
      [tourId],
    ),
    exec.query<{ available_slots: number | null; occupied: number }>(
      `SELECT ta.available_slots, COALESCE(occ.occupied, 0)::int AS occupied
         FROM tour_availability ta
         LEFT JOIN v_tour_daily_occupancy occ
           ON occ.operator_tour_id = ta.operator_tour_id AND occ.date = ta.date
        WHERE ta.operator_tour_id = $1 AND ta.date = $2::date AND ta.is_cancelled = FALSE`,
      [tourId, tourDate],
    ),
    loadPriceTiers(tourId, exec),
  ]);
  const tiers = tierRes;
  const slot = slotRes.rows[0];
  const total = slot?.available_slots ?? 0;
  const occupancyPct = total > 0 ? Math.round((slot.occupied / total) * 100) : 0;
  return { rules: ruleRes.rows, occupancyPct, tiers };
}

/** Честная цена тура на дату: правила читаются из базы и применяются. */
export async function honestTourPrice(input: {
  tourId: number | string;
  tourDate: string;
  baseUnitPrice: number;
  priceUnit: string | null | undefined;
  participants: number;
  duration?: BookingTotalInput['duration'];
  /** Клиент открытой транзакции — обязателен на пути брони. */
  exec?: PricingExecutor;
}): Promise<HonestPrice> {
  const { rules, occupancyPct, tiers } = await loadPricingContext(input.tourId, input.tourDate, input.exec);
  return composeHonestPrice({
    baseUnitPrice: input.baseUnitPrice,
    priceUnit: input.priceUnit,
    participants: input.participants,
    duration: input.duration,
    rules,
    tiers,
    ctx: { tourDate: input.tourDate, guests: input.participants, occupancyPct },
  });
}
