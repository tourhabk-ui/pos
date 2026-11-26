/**
 * Наценка оператора на выходные (сб, вс) — запись и чтение (K.ai B1).
 *
 * Одна функция записи на все пути: экран «Скидки и наценки» на сайте и
 * подтверждение изменения из чата (B3). Владение туром — в самом запросе.
 * Наценка — правило `tour_pricing_rules` (`weekend_sat_sun`), а не правка
 * base_price: будни не меняются, уже оформленные брони — тоже (цена брони
 * записана в ней).
 *
 * С 23.11 наценка идёт на проверку (слово владельца: «Наценки тоже
 * показываются в модерации: цена тура меняется только через одну дверь»):
 * запись — дверью `lib/tours/pricing-rule-door`, на сайте наценка появляется
 * после одобрения администратором; снять действующую — тоже просьба.
 */
import type { PoolClient } from 'pg';
import { markupToMultiplier, multiplierToMarkup } from '@/lib/tours/operator-discount';
import { proposePricingRule, removeRulesOfType, requestRuleRemoval, type RuleRemoval } from '@/lib/tours/pricing-rule-door';

interface Db { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }

const RULE_TYPE = 'weekend_sat_sun';

export interface TourMarkup {
  tourId: number;
  title: string;
  basePrice: number;
  priceUnit: string;
  /** Наценка, которая действует на сайте. `null` — не действует. */
  percent: number | null;
  ruleId: string | null;
  /** Действующую наценку просят снять: до решения она действует. */
  removalAsked: boolean;
  /** В снятии действующей наценки отказано: причина администратора. Не отказывали — `null`. */
  removalRefused: string | null;
  /** Просьба о новой наценке: ждёт проверки либо отклонена. Нет — `null`. */
  request: { ruleId: string; percent: number | null; status: 'pending' | 'rejected'; reason: string | null } | null;
}

export async function listWeekendMarkups(db: Db, operatorId: string): Promise<TourMarkup[]> {
  // Действующее правило и просьба — отдельными чтениями: одним соединением
  // тур с обоими попал бы в список дважды.
  const { rows } = await db.query(
    `SELECT ot.id::int AS tour_id, ot.title, ot.base_price, ot.price_unit,
            live.id::text AS rule_id, live.multiplier, live.removal_requested_at IS NOT NULL AS removal_asked,
            live.moderation_reason AS live_reason,
            ask.id::text AS ask_id, ask.multiplier AS ask_multiplier, ask.moderation_status AS ask_status,
            ask.moderation_reason AS ask_reason
       FROM operator_tours ot
       LEFT JOIN LATERAL (
         SELECT pr.id, pr.multiplier, pr.removal_requested_at, pr.moderation_reason FROM tour_pricing_rules pr
          WHERE pr.operator_tour_id = ot.id AND pr.rule_type = $2 AND pr.is_active = TRUE AND pr.moderation_status = 'approved'
          ORDER BY pr.id DESC LIMIT 1
       ) live ON TRUE
       LEFT JOIN LATERAL (
         SELECT pr.id, pr.multiplier, pr.moderation_status, pr.moderation_reason FROM tour_pricing_rules pr
          WHERE pr.operator_tour_id = ot.id AND pr.rule_type = $2 AND pr.is_active = TRUE
            AND pr.moderation_status IN ('pending', 'rejected')
          ORDER BY pr.id DESC LIMIT 1
       ) ask ON TRUE
      WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL
      ORDER BY ot.title`,
    [operatorId, RULE_TYPE],
  );
  return rows.map((r) => ({
    tourId: Number(r.tour_id), title: r.title, basePrice: Number(r.base_price), priceUnit: r.price_unit,
    percent: r.multiplier != null ? multiplierToMarkup(r.multiplier) : null, ruleId: r.rule_id ?? null,
    removalAsked: r.removal_asked === true,
    // У действующего правила причина записана только отказом в снятии.
    removalRefused: r.rule_id != null ? r.live_reason ?? null : null,
    request: r.ask_id == null ? null : {
      ruleId: r.ask_id,
      percent: r.ask_multiplier != null ? multiplierToMarkup(r.ask_multiplier) : null,
      status: r.ask_status === 'rejected' ? 'rejected' : 'pending',
      reason: r.ask_reason ?? null,
    },
  }));
}

export interface MarkupWrite {
  /** Туры владельца, которых коснулась просьба (чужие и удалённые — нет). */
  tours: number[];
  /** Из них — где наценка или её снятие ушли на проверку: цена на сайте пока прежняя. */
  pending: number[];
}

/**
 * Попросить (или заменить) наценку на туры оператора. percent=null — снять.
 * Вызывать в транзакции: дверь берёт строку тура под замок.
 */
export async function setWeekendMarkup(
  db: Pick<PoolClient, 'query'>,
  operatorId: string,
  tourIds: readonly number[],
  percent: number | null,
  requestedBy: string | null = null,
): Promise<MarkupWrite> {
  const multiplier = percent === null ? null : markupToMultiplier(percent);
  if (percent !== null && multiplier === null) throw new RangeError('Наценка — целое число от 1 до 30%');
  const out: MarkupWrite = { tours: [], pending: [] };
  // По одному туру и в порядке id: два прогона не возьмут замки навстречу друг другу.
  for (const tourId of [...new Set(tourIds)].sort((a, b) => a - b)) {
    if (multiplier === null) {
      const removed = await removeRulesOfType(db, { operatorId, tourId, ruleType: RULE_TYPE });
      if (removed === 'not_found') continue;
      out.tours.push(tourId);
      if (removed === 'removal_pending') out.pending.push(tourId);
      continue;
    }
    const asked = await proposePricingRule(db, { operatorId, requestedBy, tourId, ruleType: RULE_TYPE, multiplier });
    if (asked.outcome === 'not_found') continue;
    out.tours.push(tourId);
    if (asked.outcome === 'pending' || asked.outcome === 'already_pending') out.pending.push(tourId);
  }
  return out;
}

/** Убрать одну наценку по её id: неодобренную — сразу, действующую — просьбой администратору. */
export function removeWeekendMarkupRule(
  db: Pick<PoolClient, 'query'>,
  operatorId: string,
  ruleId: string,
): Promise<RuleRemoval> {
  return requestRuleRemoval(db, { operatorId, ruleId, ruleType: RULE_TYPE });
}
