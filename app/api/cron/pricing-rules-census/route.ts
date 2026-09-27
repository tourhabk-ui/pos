/**
 * GET /api/cron/pricing-rules-census — есть ли у скидок производитель.
 * Authorization: Bearer <CRON_SECRET>. READ-ONLY: ни UPDATE, ни INSERT.
 *
 * ЗАЧЕМ. Владелец 27.09: «есть же туристы, живущие на Камчатке, им не нужна
 * привязка к рейсу, им главное скидки». Разбор того же дня показал странное
 * состояние: машинка скидок в платформе ЕСТЬ и она богатая —
 * `tour_pricing_rules` умеет `last_minute`, `early_bird`, `season_low`,
 * `season_peak`, `weekend`, `group_discount`, `occupancy_high`, и
 * `calculateDynamicPrice` (`lib/services/tours/dynamic-pricing.ts`) их
 * применяет. А турист на нашем сайте её не видит НИКОГДА:
 * `/api/tours/[id]/price` не зовётся ни с одной страницы, карточка тура
 * рисует `base_price` и рукописную зачёркнутую `price_old`. При этом
 * `bulkDynamicPrices` зовётся из `/api/octo/availability` — динамическую цену
 * мы отдаём ЧУЖОМУ каналу, а своему туристу нет.
 *
 * Прежде чем чинить показ, нужно знать ЧИСЛО: если активных правил на проде
 * ноль, то «подключил скидки» ничего не изменит на экране, и говорить о
 * сделанной скидке было бы обещанием без источника (§10.09). Правила при этом
 * заводит только администратор (`/hub/admin/pricing`) — у оператора такого
 * экрана нет вовсе, и это отдельная находка, а не следствие пустой таблицы.
 *
 * ОПРЕДЕЛЕНИЯ — в ответе, не в голове читателя:
 *   rules_active      — `tour_pricing_rules` с `is_active = TRUE`;
 *   rules_by_type     — те же, разбитые по `rule_type` (разбивка без порога:
 *                       редкий тип здесь как раз интересен);
 *   tours_with_rules  — живых туров, у которых есть хотя бы одно активное
 *                       правило;
 *   tours_living      — живых туров всего (`is_active`, не удалённые);
 *   discount_rules    — активных правил с множителем МЕНЬШЕ единицы, то есть
 *                       скидок. Надбавка (`> 1`) — тоже правило цены, но
 *                       туристу она не скидка, и складывать их в одно число
 *                       значило бы выдать сурдж за выгоду;
 *   surcharge_rules   — активных правил с множителем больше единицы;
 *   neutral_rules     — множитель ровно 1: правило есть, цену не меняет
 *                       (заведено и забыто — состояние, которое стоит видеть);
 *   price_overrides   — строк `tour_availability` с непустым
 *                       `base_price_override` на будущие даты: второй,
 *                       независимый от правил способ поменять цену дня;
 *   price_old_filled  — живых туров с заполненным `price_old` больше цены:
 *                       единственная «скидка», которую сегодня видит турист,
 *                       и она рукописная.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0). Каждое число — `number | null`, каждая разбивка —
 * объект или `null`. Упавший запрос даёт `null`, строку в `errors` и строку в
 * лог: «не смог посчитать» не равно «ноль правил». Разница здесь решающая —
 * по нулю делают вывод «скидок в платформе нет», и этот вывод не должен
 * опираться на молча упавший запрос.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface PricingRulesCensus {
  ok: true;
  probe: 'pricing_rules_census_v1';
  measured_at: string;
  rules_active: number | null;
  rules_by_type: Record<string, number> | null;
  tours_with_rules: number | null;
  tours_living: number | null;
  discount_rules: number | null;
  surcharge_rules: number | null;
  neutral_rules: number | null;
  price_overrides: number | null;
  price_old_filled: number | null;
  definitions: Record<string, string>;
  errors: string[];
}

export const DEFINITIONS: PricingRulesCensus['definitions'] = {
  rules_active: 'tour_pricing_rules: is_active = TRUE',
  rules_by_type: 'те же правила, разбитые по rule_type, без порога частоты',
  tours_with_rules: 'живых operator_tours, у которых есть хотя бы одно активное правило',
  tours_living: 'operator_tours: is_active = true и deleted_at IS NULL',
  discount_rules: 'активных правил с multiplier < 1 (скидка туристу)',
  surcharge_rules: 'активных правил с multiplier > 1 (надбавка, не скидка)',
  neutral_rules: 'активных правил с multiplier = 1 (заведено и цену не меняет)',
  price_overrides: 'tour_availability с base_price_override IS NOT NULL на дату от сегодня',
  price_old_filled: 'живых туров, где price_old заполнен и больше base_price (рукописная «скидка»)',
};

async function countOrNull(name: string, sql: string, errors: string[]): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: number }>(sql);
    const n = rows[0]?.n;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pricing-rules-census] ${name} не посчитан (SQLSTATE ${code}): ${message}`);
    errors.push(`${name}: ${message.slice(0, 120)}`);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const errors: string[] = [];

  const [
    rulesActive, toursWithRules, toursLiving,
    discountRules, surchargeRules, neutralRules,
    priceOverrides, priceOldFilled,
  ] = await Promise.all([
    countOrNull(
      'rules_active',
      `SELECT COUNT(*)::int AS n FROM tour_pricing_rules WHERE is_active = TRUE`,
      errors,
    ),
    countOrNull(
      'tours_with_rules',
      `SELECT COUNT(DISTINCT ot.id)::int AS n
         FROM operator_tours ot
         JOIN tour_pricing_rules r ON r.operator_tour_id = ot.id AND r.is_active = TRUE
        WHERE ot.is_active = true AND ot.deleted_at IS NULL`,
      errors,
    ),
    countOrNull(
      'tours_living',
      `SELECT COUNT(*)::int AS n FROM operator_tours WHERE is_active = true AND deleted_at IS NULL`,
      errors,
    ),
    countOrNull(
      'discount_rules',
      `SELECT COUNT(*)::int AS n FROM tour_pricing_rules WHERE is_active = TRUE AND multiplier < 1`,
      errors,
    ),
    countOrNull(
      'surcharge_rules',
      `SELECT COUNT(*)::int AS n FROM tour_pricing_rules WHERE is_active = TRUE AND multiplier > 1`,
      errors,
    ),
    countOrNull(
      'neutral_rules',
      `SELECT COUNT(*)::int AS n FROM tour_pricing_rules WHERE is_active = TRUE AND multiplier = 1`,
      errors,
    ),
    countOrNull(
      'price_overrides',
      `SELECT COUNT(*)::int AS n
         FROM tour_availability
        WHERE base_price_override IS NOT NULL
          AND date >= CURRENT_DATE
          AND deleted_at IS NULL`,
      errors,
    ),
    countOrNull(
      'price_old_filled',
      `SELECT COUNT(*)::int AS n
         FROM operator_tours
        WHERE is_active = true AND deleted_at IS NULL
          AND price_old IS NOT NULL AND price_old > base_price`,
      errors,
    ),
  ]);

  // Разбивка по роду правила. Отдельным запросом, а не подсчётом на месте:
  // род — это то, ЧТО именно оператор пообещал туристу, и складывать
  // «последние места» с «пиком сезона» в одно число нельзя.
  let rulesByType: Record<string, number> | null = null;
  try {
    const { rows } = await pool.query<{ rule_type: string; n: number }>(
      `SELECT rule_type, COUNT(*)::int AS n
         FROM tour_pricing_rules
        WHERE is_active = TRUE
        GROUP BY 1 ORDER BY 2 DESC`,
    );
    rulesByType = Object.fromEntries(rows.map((r) => [r.rule_type, r.n]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pricing-rules-census] rules_by_type не посчитан: ${message}`);
    errors.push(`rules_by_type: ${message.slice(0, 120)}`);
  }

  const body: PricingRulesCensus = {
    ok: true,
    probe: 'pricing_rules_census_v1',
    measured_at: new Date().toISOString(),
    rules_active: rulesActive,
    rules_by_type: rulesByType,
    tours_with_rules: toursWithRules,
    tours_living: toursLiving,
    discount_rules: discountRules,
    surcharge_rules: surchargeRules,
    neutral_rules: neutralRules,
    price_overrides: priceOverrides,
    price_old_filled: priceOldFilled,
    definitions: DEFINITIONS,
    errors,
  };
  return NextResponse.json(body);
}
