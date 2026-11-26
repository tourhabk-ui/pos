/**
 * Скидка или наценка владельца тура — одна дверь, и ведёт она на проверку.
 *
 * Слово владельца 23.11: «Наценки тоже показываются в модерации: цена тура
 * меняется только через одну дверь». До этого дня правило
 * `tour_pricing_rules` из кабинета начинало менять цену на сайте в ту же
 * секунду. Теперь:
 *
 *   - новое правило ложится со статусом «на проверке» и цену не меняет;
 *     действующее правило того же рода (если было) продолжает действовать,
 *     пока администратор не одобрил новое;
 *   - снять действующее правило — тоже просьба: до решения оно действует
 *     (снятие скидки поднимает цену);
 *   - правило, которое ещё не одобрено или отклонено, владелец убирает сам
 *     и сразу: на цену оно не влияло.
 *
 * Правило идёт на проверку и у тура, которого на сайте нет: иначе наценка,
 * заведённая до публикации, вышла бы на сайт вместе с туром никем не
 * виденной — карточка публикации показывает содержание, а не правила цены.
 *
 * Транзакцию даёт вызывающий: дверь берёт строку тура под замок.
 */
import type { PoolClient } from 'pg';

type Db = Pick<PoolClient, 'query'>;

export interface RuleRequest {
  /** `partners.id` владельца тура: владение проверяется в самом запросе. */
  operatorId: string;
  /** Кто просит (`users.id`); у чата может не быть. */
  requestedBy: string | null;
  tourId: number | string;
  ruleType: string;
  multiplier: number;
  daysBeforeMin?: number | null;
  daysBeforeMax?: number | null;
  guestsMin?: number | null;
}

export type RuleProposal =
  /** Правило ждёт проверки администратора; цену пока не меняет. */
  | { outcome: 'pending'; ruleId: string }
  /** Такое же правило уже действует: проверять нечего. */
  | { outcome: 'already_live'; ruleId: string }
  /** Такое же правило уже ждёт проверки. */
  | { outcome: 'already_pending'; ruleId: string }
  /** Тура нет, он удалён или не этой карточки. */
  | { outcome: 'not_found' };

interface ActiveRule {
  id: string;
  multiplier: string;
  days_before_min: number | null;
  days_before_max: number | null;
  guests_min: number | null;
  moderation_status: string;
  removal_asked: boolean;
}

const LOCK_OWN_TOUR_SQL = `SELECT id FROM operator_tours
    WHERE id = $1::bigint AND operator_id = $2::uuid AND deleted_at IS NULL
    FOR UPDATE`;

const ACTIVE_RULES_SQL = `SELECT id::text AS id, multiplier::text AS multiplier, days_before_min, days_before_max, guests_min,
          moderation_status, removal_requested_at IS NOT NULL AS removal_asked
     FROM tour_pricing_rules pr
    WHERE pr.operator_tour_id = $1::bigint AND pr.rule_type = $2 AND pr.is_active = TRUE
    ORDER BY pr.id
    FOR UPDATE`;

/** Правила одного рода, которые цену не меняют: ждущие проверки и отклонённые. */
const WITHDRAW_NOT_LIVE_SQL = `UPDATE tour_pricing_rules SET is_active = FALSE
    WHERE operator_tour_id = $1::bigint AND rule_type = $2 AND is_active = TRUE
      AND moderation_status IN ('pending', 'rejected')`;

function sameRule(rule: ActiveRule, want: RuleRequest): boolean {
  return Math.abs(Number(rule.multiplier) - want.multiplier) < 0.0005
    && (rule.days_before_min ?? null) === (want.daysBeforeMin ?? null)
    && (rule.days_before_max ?? null) === (want.daysBeforeMax ?? null)
    && (rule.guests_min ?? null) === (want.guestsMin ?? null);
}

/** Попросить правило цены. Одно правило рода на тур: новая просьба заменяет прежнюю неодобренную. */
export async function proposePricingRule(client: Db, want: RuleRequest): Promise<RuleProposal> {
  const tour = await client.query(LOCK_OWN_TOUR_SQL, [String(want.tourId), want.operatorId]);
  if (tour.rows.length === 0) return { outcome: 'not_found' };

  const { rows: active } = await client.query<ActiveRule>(ACTIVE_RULES_SQL, [String(want.tourId), want.ruleType]);
  const live = active.find((r) => r.moderation_status === 'approved');
  if (live && sameRule(live, want)) {
    // То же правило уже действует: прежние просьбы того же рода теряют смысл,
    // и просьба снять его — тоже (владелец передумал).
    await client.query(WITHDRAW_NOT_LIVE_SQL, [String(want.tourId), want.ruleType]);
    if (live.removal_asked) {
      await client.query(`UPDATE tour_pricing_rules SET removal_requested_at = NULL WHERE id = $1::bigint`, [live.id]);
    }
    return { outcome: 'already_live', ruleId: live.id };
  }
  const waiting = active.find((r) => r.moderation_status === 'pending');
  if (waiting && sameRule(waiting, want)) return { outcome: 'already_pending', ruleId: waiting.id };

  await client.query(WITHDRAW_NOT_LIVE_SQL, [String(want.tourId), want.ruleType]);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tour_pricing_rules
       (operator_tour_id, rule_type, multiplier, days_before_min, days_before_max, guests_min,
        is_active, moderation_status, requested_by)
     VALUES ($1::bigint, $2, $3, $4, $5, $6, TRUE, 'pending', $7::uuid)
     RETURNING id::text AS id`,
    [String(want.tourId), want.ruleType, want.multiplier, want.daysBeforeMin ?? null, want.daysBeforeMax ?? null,
      want.guestsMin ?? null, want.requestedBy],
  );
  return { outcome: 'pending', ruleId: inserted.rows[0].id };
}

export type RuleRemoval =
  /** Правило цену не меняло (ждало проверки или отклонено): убрано сразу. */
  | { outcome: 'withdrawn' }
  /** Действующее правило: просьба снять ждёт проверки, до решения оно действует. */
  | { outcome: 'removal_pending' }
  /** Правила нет, оно уже выключено или не этой карточки. */
  | { outcome: 'not_found' };

/**
 * Убрать правило. Владение — в самом запросе: id правила не говорит, чей это
 * тур. `ruleType` — для экрана одного рода (наценка на выходные): правило
 * другого рода через него не убирается.
 */
export async function requestRuleRemoval(
  client: Db,
  opts: { operatorId: string; ruleId: string; ruleType?: string },
): Promise<RuleRemoval> {
  const { rows } = await client.query<{ moderation_status: string }>(
    `SELECT pr.moderation_status
       FROM tour_pricing_rules pr
       JOIN operator_tours ot ON ot.id = pr.operator_tour_id
      WHERE pr.id = $1::bigint AND pr.is_active = TRUE AND ot.operator_id = $2::uuid AND ot.deleted_at IS NULL
        AND ($3::text IS NULL OR pr.rule_type = $3::text)
      FOR UPDATE OF pr`,
    [opts.ruleId, opts.operatorId, opts.ruleType ?? null],
  );
  const rule = rows[0];
  if (!rule) return { outcome: 'not_found' };
  if (rule.moderation_status !== 'approved') {
    await client.query(`UPDATE tour_pricing_rules SET is_active = FALSE WHERE id = $1::bigint`, [opts.ruleId]);
    return { outcome: 'withdrawn' };
  }
  // Повторная просьба время первой не сдвигает: очередь идёт по времени просьбы.
  await client.query(
    `UPDATE tour_pricing_rules SET removal_requested_at = COALESCE(removal_requested_at, NOW()) WHERE id = $1::bigint`,
    [opts.ruleId],
  );
  return { outcome: 'removal_pending' };
}

/**
 * Снять все правила рода у тура — для экранов, где правило одно на тур
 * (наценка на выходные): действующее — просьбой, неодобренные — сразу.
 * Возвращает, что стало с действующим правилом; `none` — его не было.
 */
export async function removeRulesOfType(
  client: Db,
  opts: { operatorId: string; tourId: number | string; ruleType: string },
): Promise<'removal_pending' | 'withdrawn' | 'none' | 'not_found'> {
  const tour = await client.query(LOCK_OWN_TOUR_SQL, [String(opts.tourId), opts.operatorId]);
  if (tour.rows.length === 0) return 'not_found';
  const { rows: active } = await client.query<ActiveRule>(ACTIVE_RULES_SQL, [String(opts.tourId), opts.ruleType]);
  const withdrawn = await client.query(WITHDRAW_NOT_LIVE_SQL, [String(opts.tourId), opts.ruleType]);
  const live = active.find((r) => r.moderation_status === 'approved');
  if (live) {
    await client.query(
      `UPDATE tour_pricing_rules SET removal_requested_at = COALESCE(removal_requested_at, NOW()) WHERE id = $1::bigint`,
      [live.id],
    );
    return 'removal_pending';
  }
  return (withdrawn.rowCount ?? 0) > 0 ? 'withdrawn' : 'none';
}
