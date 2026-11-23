/**
 * Скидки и наценки тура: очередь администратора и решение.
 *
 * Слово владельца 23.11: «Наценки тоже показываются в модерации: цена тура
 * меняется только через одну дверь». Правило `tour_pricing_rules` меняет
 * цену, которую видит турист, поэтому действует оно только после проверки
 * (миграция 1512). В очереди два рода строк:
 *
 *   - `new` — новое правило ждёт проверки; до одобрения цену не меняет, а
 *     прежнее правило того же рода (если было) продолжает действовать;
 *   - `removal` — владелец просит снять действующее правило; до решения оно
 *     действует. Снятие скидки поднимает цену — это тоже перемена цены.
 *
 * Одобряется ровно показанное: отпечаток карточки едет вместе с решением.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { livePricingRuleSql } from '@/lib/tours/pricing-rule-live';
import {
  ruleExamplePrice, ruleWords,
  type PendingPricingRule, type PricingRuleReviewKind, type RuleFacts,
} from '@/lib/tours/pricing-rule-words';

export type { PendingPricingRule, PricingRuleReviewKind } from '@/lib/tours/pricing-rule-words';

function sqlState(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет';
}

interface RuleRow extends RuleFacts {
  id: string;
  tour_id: string;
  rule_type: string;
  multiplier: string;
  moderation_status: string;
  removal_requested_at: Date | string | null;
  created_at: Date | string;
  title: string;
  base_price: string | null;
  price_unit: string | null;
  is_published: boolean | null;
  partner_id: string;
  partner_name: string;
  partner_category: string | null;
  cur_multiplier: string | null;
  cur_date_from: string | null;
  cur_date_to: string | null;
  cur_days_before_min: number | null;
  cur_days_before_max: number | null;
  cur_occupancy_min: number | null;
  cur_guests_min: number | null;
}

const iso = (v: Date | string | null): string => (v === null ? '' : v instanceof Date ? v.toISOString() : String(v));

function kindOf(row: { moderation_status: string; removal_requested_at: unknown }): PricingRuleReviewKind | null {
  if (row.moderation_status === 'pending') return 'new';
  if (row.moderation_status === 'approved' && row.removal_requested_at !== null) return 'removal';
  return null;
}

/** Отпечаток того, что администратор видел в карточке. */
export function pricingRuleSeenToken(row: RuleFacts & { id: string }, kind: PricingRuleReviewKind): string {
  const body = JSON.stringify([
    row.id, kind, row.rule_type, String(Number(row.multiplier)),
    row.date_from ? String(row.date_from).slice(0, 10) : null, row.date_to ? String(row.date_to).slice(0, 10) : null,
    row.days_before_min ?? null, row.days_before_max ?? null, row.occupancy_min ?? null, row.guests_min ?? null,
  ]);
  return createHash('sha256').update(body).digest('hex');
}

/** Колонки правила — одни у списка и у решения. Даты читаются текстом «ГГГГ-ММ-ДД». */
const RULE_COLUMNS = `pr.id::text AS id, pr.operator_tour_id::text AS tour_id, pr.rule_type, pr.multiplier::text AS multiplier,
       pr.date_from::text AS date_from, pr.date_to::text AS date_to,
       pr.days_before_min, pr.days_before_max, pr.occupancy_min, pr.guests_min,
       pr.moderation_status, pr.removal_requested_at, pr.created_at`;

/** В очереди: правило ждёт проверки либо его просят снять. */
const IN_QUEUE_SQL = `pr.is_active = TRUE
   AND (pr.moderation_status = 'pending' OR (pr.moderation_status = 'approved' AND pr.removal_requested_at IS NOT NULL))`;

export async function listPendingPricingRules(): Promise<{ outcome: 'ok'; rules: PendingPricingRule[] } | { outcome: 'db_error' }> {
  try {
    const { rows } = await pool.query<RuleRow>(
      `SELECT ${RULE_COLUMNS},
              ot.title, ot.base_price::text AS base_price, ot.price_unit, ot.is_published,
              ot.operator_id::text AS partner_id, p.name AS partner_name, p.category AS partner_category,
              cur.multiplier::text AS cur_multiplier, cur.date_from::text AS cur_date_from, cur.date_to::text AS cur_date_to,
              cur.days_before_min AS cur_days_before_min, cur.days_before_max AS cur_days_before_max,
              cur.occupancy_min AS cur_occupancy_min, cur.guests_min AS cur_guests_min
         FROM tour_pricing_rules pr
         JOIN operator_tours ot ON ot.id = pr.operator_tour_id AND ot.deleted_at IS NULL
         JOIN partners p ON p.id = ot.operator_id
         LEFT JOIN LATERAL (
           SELECT c.multiplier, c.date_from, c.date_to, c.days_before_min, c.days_before_max, c.occupancy_min, c.guests_min
             FROM tour_pricing_rules c
            WHERE c.operator_tour_id = pr.operator_tour_id AND c.rule_type = pr.rule_type AND c.id <> pr.id
              AND ${livePricingRuleSql('c')}
            ORDER BY c.created_at DESC
            LIMIT 1
         ) cur ON TRUE
        WHERE ${IN_QUEUE_SQL}
        ORDER BY COALESCE(pr.removal_requested_at, pr.created_at::timestamptz) ASC
        LIMIT 200`,
    );
    const rules: PendingPricingRule[] = [];
    for (const row of rows) {
      const kind = kindOf(row);
      if (kind === null) continue;
      const current: RuleFacts | null = row.cur_multiplier === null ? null : {
        rule_type: row.rule_type, multiplier: row.cur_multiplier, date_from: row.cur_date_from, date_to: row.cur_date_to,
        days_before_min: row.cur_days_before_min, days_before_max: row.cur_days_before_max,
        occupancy_min: row.cur_occupancy_min, guests_min: row.cur_guests_min,
      };
      const base = row.base_price === null ? null : Number(row.base_price);
      const withRule = ruleExamplePrice(base, row.multiplier);
      const withCurrent = current ? ruleExamplePrice(base, current.multiplier) : base;
      rules.push({
        id: row.id,
        kind,
        tourId: row.tour_id,
        tourTitle: row.title,
        partnerId: row.partner_id,
        partnerName: row.partner_name,
        partnerCategory: row.partner_category,
        tourOnSite: row.is_published === true,
        words: ruleWords(row),
        replaces: kind === 'new' && current ? ruleWords(current) : null,
        basePrice: base !== null && Number.isFinite(base) ? base : null,
        priceUnit: row.price_unit,
        // Новое правило: сейчас действует прежнее (или базовая цена), станет новое.
        // Снятие: сейчас действует правило, станет базовая цена.
        priceNow: kind === 'new' ? withCurrent : withRule,
        priceAfter: kind === 'new' ? withRule : (base !== null && Number.isFinite(base) ? base : null),
        seen: pricingRuleSeenToken(row, kind),
        since: iso(kind === 'removal' ? row.removal_requested_at : row.created_at),
      });
    }
    return { outcome: 'ok', rules };
  } catch (err) {
    console.error('[pricing-rule] очередь наценок не прочитана, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

// ─── Решение ──────────────────────────────────────────────────────────────────

export type DecidePricingRule =
  | {
      outcome: 'approved' | 'rejected';
      kind: PricingRuleReviewKind;
      partnerId: string;
      partnerCategory: string | null;
      tourId: string;
      tourTitle: string;
      words: string;
    }
  /** Решение уже записано либо правило отозвано владельцем. */
  | { outcome: 'already' }
  /** Правило изменилось после показа карточки: одобрять нужно то, что есть сейчас. */
  | { outcome: 'changed' }
  | { outcome: 'not_found' }
  | { outcome: 'db_error' };

const LOCK_RULE_SQL = `SELECT ${RULE_COLUMNS}, pr.is_active,
          ot.title, ot.operator_id::text AS partner_id,
          (SELECT p.category FROM partners p WHERE p.id = ot.operator_id) AS partner_category
     FROM tour_pricing_rules pr
     JOIN operator_tours ot ON ot.id = pr.operator_tour_id AND ot.deleted_at IS NULL
    WHERE pr.id = $1::bigint
    FOR UPDATE OF pr`;

/**
 * Решение по правилу. Одобрение нового правила — одно действие: прежнее
 * действующее правило того же рода выключается, новое начинает действовать.
 * Отказ цену не меняет.
 */
export async function decidePricingRule(opts: {
  id: string;
  action: 'approve' | 'reject';
  reason: string | null;
  moderatedBy: string | null;
  /** Отпечаток из списка. Одобрение без него или при расхождении не применяется. */
  seen: string | null;
}): Promise<DecidePricingRule> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[pricing-rule] соединение не взято, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
  try {
    await client.query('BEGIN');
    const row = (await client.query<RuleRow & { is_active: boolean }>(LOCK_RULE_SQL, [opts.id])).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }
    const kind = row.is_active ? kindOf(row) : null;
    if (kind === null) {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    if (opts.action === 'approve' && (opts.seen === null || opts.seen !== pricingRuleSeenToken(row, kind))) {
      await client.query('ROLLBACK');
      return { outcome: 'changed' };
    }
    const base = {
      kind, partnerId: row.partner_id, partnerCategory: row.partner_category,
      tourId: row.tour_id, tourTitle: row.title, words: ruleWords(row),
    };

    if (kind === 'new' && opts.action === 'approve') {
      // Одно действующее правило рода на тур: два перемножились бы.
      await client.query(
        `UPDATE tour_pricing_rules SET is_active = FALSE
          WHERE operator_tour_id = $1::bigint AND rule_type = $2 AND id <> $3::bigint
            AND is_active = TRUE AND moderation_status = 'approved'`,
        [row.tour_id, row.rule_type, row.id],
      );
      await client.query(
        `UPDATE tour_pricing_rules
            SET moderation_status = 'approved', moderation_reason = NULL, moderated_at = NOW(), moderated_by = $2::uuid
          WHERE id = $1::bigint`,
        [row.id, opts.moderatedBy],
      );
    } else if (kind === 'new') {
      await client.query(
        `UPDATE tour_pricing_rules
            SET moderation_status = 'rejected', moderation_reason = $2::text, moderated_at = NOW(), moderated_by = $3::uuid
          WHERE id = $1::bigint`,
        [row.id, opts.reason, opts.moderatedBy],
      );
    } else if (opts.action === 'approve') {
      // Снятие одобрено: правило выключается, цена возвращается к базовой.
      await client.query(
        `UPDATE tour_pricing_rules
            SET is_active = FALSE, moderation_reason = NULL, moderated_at = NOW(), moderated_by = $2::uuid
          WHERE id = $1::bigint`,
        [row.id, opts.moderatedBy],
      );
    } else {
      // В снятии отказано: правило остаётся действовать, просьба закрыта с причиной.
      await client.query(
        `UPDATE tour_pricing_rules
            SET removal_requested_at = NULL, moderation_reason = $2::text, moderated_at = NOW(), moderated_by = $3::uuid
          WHERE id = $1::bigint`,
        [row.id, opts.reason, opts.moderatedBy],
      );
    }
    await client.query('COMMIT');
    return { outcome: opts.action === 'approve' ? 'approved' : 'rejected', ...base };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[pricing-rule] решение по правилу не записано, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  } finally {
    client.release();
  }
}
