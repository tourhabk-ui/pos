/**
 * Деньги агента — ЕДИНСТВЕННЫЙ источник (решение владельца 26.09).
 *
 * Все экраны кабинета агента (обзор, комиссии, статистика, рефералы) и обе
 * руки выплаты (заявка агента, отметка администратора) считают вознаграждение
 * здесь. До этого дня каждый экран считал своё: рефералы — все оплаченные
 * брони × ставку ссылки, включая отменённые; обзор и статистика — по таблице
 * agent_bookings/agent_commissions с зашитыми 10%; заявка на выплату не
 * выполнялась ни разу (текстовый id в uuid и статус вне CHECK).
 *
 * ── Правило ────────────────────────────────────────────────────────────────
 *
 * Продажа агента — бронь оператора с `operator_bookings.agent_user_id` = агент
 * (миграция 1022; пишет её только бронирование, lib/bookings/reserve.ts).
 *
 *   ставка        — partners.agent_commission_rate записи агента (1025). Её
 *                   назначает владелец в админке; NULL — «не назначена», и
 *                   тогда суммы нет вовсе (null), а не 0 и не умолчание;
 *   начисляется   — только с ОПЛАЧЕННОЙ и НЕ отменённой брони;
 *   к выплате     — после конца тура + 36 часов: `tour_payments.release_after`,
 *                   а у брони без строки платежа — тот же RELEASE_AFTER_SQL,
 *                   что у выплаты оператору;
 *   сумма         — final_price × ставка / 100, снимок в момент заявки
 *                   (agent_payout_items, 1026): смена ставки не переписывает
 *                   запрошенное и выплаченное;
 *   дважды нельзя — уникальный индекс по брони среди живых позиций.
 *
 * Отмена ПОСЛЕ выплаты не уводит агента в минус молча: позиция остаётся
 * выплаченной и получает флаг `cancelled_after_payout` — это вопрос
 * администратору, а не автомату.
 *
 * ── agent_commissions больше не читается как деньги ───────────────────────
 *
 * Таблицу писал только прежний POST брони агента (зашитые 10%, ссылка на
 * agent_bookings, которую оператор не видел). Её строки на проде, если есть,
 * НЕ являются начислением: за ними нет оплаченной брони оператора. Ни один
 * экран денег агента их не суммирует.
 */
import type { PoolClient } from 'pg';
import { RELEASE_AFTER_SQL } from '@/lib/payments/hold-tour-payment';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';

type Queryable = Pick<PoolClient, 'query'>;

/** Верхняя граница ставки — та же, что в CHECK миграции 1025. */
export const AGENT_RATE_MAX = 30;

/** Статусы заявки, которые пишет этот код. Прочие (legacy) не показываются. */
export const PAYOUT_STATUSES = ['pending', 'paid', 'rejected'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const AGENT_MONEY_SQL = {
  /** Запись агента и его ставка. $1 — users.id агента. */
  agentProfile: `
    SELECT p.id::text AS partner_id, p.profile_status,
           p.agent_commission_rate::text AS rate, p.agent_rate_set_at::text AS rate_set_at
      FROM partners p
     WHERE p.user_id = $1::uuid AND p.category = 'agent'
     LIMIT 1`,

  /** То же под замком: заявки одного агента выстраиваются в очередь. */
  lockAgentProfile: `
    SELECT p.id::text AS partner_id, p.profile_status,
           p.agent_commission_rate::text AS rate, p.agent_rate_set_at::text AS rate_set_at
      FROM partners p
     WHERE p.user_id = $1::uuid AND p.category = 'agent'
     LIMIT 1
       FOR UPDATE`,

  /**
   * Все продажи агента с состоянием денег. $1 — агент, $2 — статусы отмены.
   * Строка платежа — последняя из HELD/RELEASED/REFUNDED: PENDING означает
   * «ещё не оплачено» и срока выплаты не задаёт.
   */
  sales: `
    SELECT ob.id::text                 AS booking_id,
           ob.booking_date::text       AS booking_date,
           ot.title                    AS tour_title,
           ob.final_price::text        AS final_price,
           ob.booking_status,
           ob.referral_link_id::text   AS referral_link_id,
           (ob.booking_status = ANY($2::text[])
             OR ob.payment_status = 'refunded'
             OR tp.status = 'REFUNDED') AS voided,
           (ob.paid_at IS NOT NULL
             OR ob.payment_status = 'paid'
             OR tp.status IN ('HELD', 'RELEASED')) AS paid,
           COALESCE(tp.release_after, ${RELEASE_AFTER_SQL})::text AS release_after,
           (COALESCE(tp.release_after, ${RELEASE_AFTER_SQL}) <= NOW()) AS released,
           it.payout_id::text          AS payout_id,
           cp.status                   AS payout_status,
           it.rate::text               AS item_rate,
           it.amount::text             AS item_amount
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      LEFT JOIN LATERAL (
        SELECT t.status, t.release_after
          FROM tour_payments t
         WHERE t.booking_id = ob.id AND t.status IN ('HELD', 'RELEASED', 'REFUNDED')
         ORDER BY t.created_at DESC
         LIMIT 1
      ) tp ON TRUE
      LEFT JOIN agent_payout_items it ON it.booking_id = ob.id AND it.released_at IS NULL
      LEFT JOIN commission_payouts cp ON cp.id = it.payout_id
     WHERE ob.agent_user_id = $1::uuid
       AND ob.deleted_at IS NULL
     ORDER BY ob.booking_date DESC, ob.id DESC`,

  /** Открытая заявка агента. */
  openPayout: `
    SELECT id::text AS id FROM commission_payouts
     WHERE agent_id = $1::uuid AND status = 'pending' AND from_sales
     LIMIT 1`,

  insertPayout: `
    INSERT INTO commission_payouts (agent_id, total_amount, status, payment_method, notes, from_sales, created_at, updated_at)
    VALUES ($1::uuid, $2::numeric, 'pending', $3, $4, TRUE, NOW(), NOW())
    RETURNING id::text AS id, created_at::text AS created_at`,

  /** Позиции заявки одним запросом: $1 заявка, $2 агент, $3..$6 массивы. */
  insertItems: `
    INSERT INTO agent_payout_items (payout_id, agent_user_id, booking_id, sale_amount, rate, amount)
    SELECT $1::uuid, $2::uuid, b, s, r, a
      FROM UNNEST($3::bigint[], $4::numeric[], $5::numeric[], $6::numeric[]) AS x(b, s, r, a)
    RETURNING id`,

  /** Заявки агента (только из продаж). $1 агент, $2 лимит. */
  agentPayouts: `
    SELECT cp.id::text AS id, cp.total_amount::text AS total_amount, cp.status,
           cp.payment_method, cp.created_at::text AS created_at,
           cp.paid_at::text AS paid_at, cp.rejected_at::text AS rejected_at,
           cp.reject_reason,
           (SELECT COUNT(*) FROM agent_payout_items i WHERE i.payout_id = cp.id)::int AS items
      FROM commission_payouts cp
     WHERE cp.agent_id = $1::uuid AND cp.from_sales
     ORDER BY cp.created_at DESC
     LIMIT $2`,

  /**
   * Заявки для администратора. $1 — статус или NULL (все), $2 — статусы отмены.
   * У каждой позиции — текущее состояние брони: отменённая после заявки или
   * после выплаты видна глазами.
   */
  adminPayouts: `
    SELECT cp.id::text AS id, cp.agent_id::text AS agent_user_id,
           u.name AS agent_name, u.email AS agent_email,
           cp.total_amount::text AS total_amount, cp.status, cp.payment_method, cp.notes,
           cp.created_at::text AS created_at,
           cp.paid_at::text AS paid_at, cp.paid_reason, cp.rejected_at::text AS rejected_at, cp.reject_reason,
           COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
             'booking_id', i.booking_id::text,
             'tour_title', ot.title,
             'booking_date', ob.booking_date::text,
             'sale_amount', i.sale_amount::text,
             'rate', i.rate::text,
             'amount', i.amount::text,
             'voided', (ob.booking_status = ANY($2::text[]) OR ob.payment_status = 'refunded')
           ) ORDER BY ob.booking_date) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
      FROM commission_payouts cp
      JOIN users u ON u.id = cp.agent_id
      LEFT JOIN agent_payout_items i ON i.payout_id = cp.id
      LEFT JOIN operator_bookings ob ON ob.id = i.booking_id
      LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
     WHERE cp.from_sales
       AND ($1::text IS NULL OR cp.status = $1::text)
     GROUP BY cp.id, u.name, u.email
     ORDER BY (cp.status = 'pending') DESC, cp.created_at DESC
     LIMIT 200`,

  lockPayout: `
    SELECT id::text AS id, agent_id::text AS agent_user_id, status
      FROM commission_payouts
     WHERE id = $1::uuid AND from_sales
       FOR UPDATE`,

  /**
   * Позиции заявки, которые к выплате больше НЕ годятся: бронь отменена или
   * возвращена, либо срок выплаты отодвинулся (перенос тура). $1 заявка,
   * $2 статусы отмены.
   */
  payoutBlockers: `
    SELECT i.booking_id::text AS booking_id,
           (ob.booking_status = ANY($2::text[]) OR ob.payment_status = 'refunded' OR tp.status = 'REFUNDED') AS voided,
           (COALESCE(tp.release_after, ${RELEASE_AFTER_SQL}) > NOW()) AS not_released
      FROM agent_payout_items i
      JOIN operator_bookings ob ON ob.id = i.booking_id
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      LEFT JOIN LATERAL (
        SELECT t.status, t.release_after
          FROM tour_payments t
         WHERE t.booking_id = ob.id AND t.status IN ('HELD', 'RELEASED', 'REFUNDED')
         ORDER BY t.created_at DESC
         LIMIT 1
      ) tp ON TRUE
     WHERE i.payout_id = $1::uuid
       AND i.released_at IS NULL
       AND (ob.booking_status = ANY($2::text[]) OR ob.payment_status = 'refunded' OR tp.status = 'REFUNDED'
            OR COALESCE(tp.release_after, ${RELEASE_AFTER_SQL}) > NOW())`,

  markPaid: `
    UPDATE commission_payouts
       SET status = 'paid', paid_at = NOW(), payout_date = NOW(),
           paid_by = $2::uuid, paid_reason = $3, updated_at = NOW()
     WHERE id = $1::uuid AND status = 'pending' AND from_sales
     RETURNING id`,

  reject: `
    UPDATE commission_payouts
       SET status = 'rejected', rejected_at = NOW(),
           rejected_by = $2::uuid, reject_reason = $3, updated_at = NOW()
     WHERE id = $1::uuid AND status = 'pending' AND from_sales
     RETURNING id`,

  /** Отклонённая заявка освобождает позиции — их можно запросить снова. */
  releaseItems: `
    UPDATE agent_payout_items SET released_at = NOW()
     WHERE payout_id = $1::uuid AND released_at IS NULL`,

  /** Выплачено, а бронь потом отменена: флаг администратору. $1 — статусы отмены. */
  cancelledAfterPayout: `
    SELECT cp.id::text AS payout_id, cp.agent_id::text AS agent_user_id, u.name AS agent_name,
           i.booking_id::text AS booking_id, i.amount::text AS amount, ob.booking_status
      FROM agent_payout_items i
      JOIN commission_payouts cp ON cp.id = i.payout_id AND cp.status = 'paid' AND cp.from_sales
      JOIN users u ON u.id = cp.agent_id
      JOIN operator_bookings ob ON ob.id = i.booking_id
     WHERE i.released_at IS NULL
       AND (ob.booking_status = ANY($1::text[]) OR ob.payment_status = 'refunded')
     ORDER BY cp.paid_at DESC
     LIMIT 100`,

  /** Агенты для администратора: ставка и статус одобрения. */
  adminAgents: `
    SELECT p.id::text AS partner_id, p.user_id::text AS user_id, p.name, u.email,
           p.profile_status, p.agent_commission_rate::text AS rate,
           p.agent_rate_set_at::text AS rate_set_at, p.agent_rate_reason AS rate_reason
      FROM partners p
      JOIN users u ON u.id = p.user_id
     WHERE p.category = 'agent'
     ORDER BY (p.profile_status = 'approved') DESC, p.name
     LIMIT 500`,

  /** Назначение ставки владельцем. $2 может быть NULL — «снять ставку». */
  setRate: `
    UPDATE partners
       SET agent_commission_rate = $2::numeric,
           agent_rate_set_by     = $3::uuid,
           agent_rate_set_at     = NOW(),
           agent_rate_reason     = $4,
           updated_at            = NOW()
     WHERE id = $1::uuid AND category = 'agent'
     RETURNING id::text AS partner_id, agent_commission_rate::text AS rate`,
} as const;

// ── Чистая часть: состояние продажи и сумма ───────────────────────────────

export type SaleState = 'cancelled' | 'unpaid' | 'waiting' | 'payable' | 'requested' | 'paid_out';
export type SaleFlag = 'cancelled_in_request' | 'cancelled_after_payout' | null;

export interface SaleRow {
  booking_id: string;
  booking_date: string | null;
  tour_title: string | null;
  final_price: string | null;
  booking_status: string | null;
  referral_link_id: string | null;
  voided: boolean;
  paid: boolean;
  release_after: string | null;
  released: boolean | null;
  payout_id: string | null;
  payout_status: string | null;
  item_rate: string | null;
  item_amount: string | null;
}

export interface AgentSale {
  bookingId: string;
  bookingDate: string | null;
  tourTitle: string | null;
  saleAmount: number | null;
  referralLinkId: string | null;
  releaseAfter: string | null;
  state: SaleState;
  /** Ставка: снимок заявки, иначе текущая; null — не назначена. */
  rate: number | null;
  /** Вознаграждение; null — не считается (нет ставки, нет суммы, не оплачено, отменено). */
  amount: number | null;
  payoutId: string | null;
  flag: SaleFlag;
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** final_price × ставка / 100 с округлением до копейки; нет ставки или суммы — null. */
export function commissionAmount(sale: number | null, rate: number | null): number | null {
  if (sale === null || rate === null) return null;
  return Math.round(sale * rate) / 100;
}

export function classifySale(row: SaleRow, rate: number | null): AgentSale {
  const base = {
    bookingId: row.booking_id,
    bookingDate: row.booking_date,
    tourTitle: row.tour_title,
    saleAmount: num(row.final_price),
    referralLinkId: row.referral_link_id,
    releaseAfter: row.release_after,
    payoutId: row.payout_id,
  };

  // Позиция заявки — снимок: ставка и сумма те, с которыми запросили.
  if (row.payout_id !== null) {
    const snap = { rate: num(row.item_rate), amount: num(row.item_amount) };
    if (row.payout_status === 'paid') {
      return { ...base, ...snap, state: 'paid_out', flag: row.voided ? 'cancelled_after_payout' : null };
    }
    return { ...base, ...snap, state: 'requested', flag: row.voided ? 'cancelled_in_request' : null };
  }

  if (row.voided) return { ...base, rate, amount: null, state: 'cancelled', flag: null };
  if (!row.paid) return { ...base, rate, amount: null, state: 'unpaid', flag: null };

  const amount = commissionAmount(base.saleAmount, rate);
  // released === null — срок выплаты не вычислен (нет даты тура): к выплате
  // такое не идёт, «не знаю» не равно «можно».
  if (row.released !== true) return { ...base, rate, amount, state: 'waiting', flag: null };
  return { ...base, rate, amount, state: 'payable', flag: null };
}

export interface AgentMoneySummary {
  /** Текущая ставка; null — не назначена. */
  rate: number | null;
  counts: Record<SaleState, number>;
  /** Ждут конца тура + 36 ч. null — ставка не назначена. */
  waiting: number | null;
  /** Можно запросить. null — ставка не назначена. */
  payable: number | null;
  /** В открытой заявке (снимок). */
  requested: number;
  /** Выплачено (снимок). */
  paidOut: number;
  /** Позиции, отменённые после заявки или выплаты, — вопрос администратору. */
  flagged: number;
  /** Оплаченные продажи без суммы брони — посчитать их нельзя. */
  withoutPrice: number;
}

function sum(xs: Array<number | null>): number {
  return Math.round(xs.reduce<number>((s, x) => s + (x ?? 0), 0) * 100) / 100;
}

export function summarize(sales: AgentSale[], rate: number | null): AgentMoneySummary {
  const counts: Record<SaleState, number> = {
    cancelled: 0, unpaid: 0, waiting: 0, payable: 0, requested: 0, paid_out: 0,
  };
  for (const s of sales) counts[s.state] += 1;
  const by = (st: SaleState) => sales.filter((s) => s.state === st);
  return {
    rate,
    counts,
    waiting: rate === null ? null : sum(by('waiting').map((s) => s.amount)),
    payable: rate === null ? null : sum(by('payable').map((s) => s.amount)),
    requested: sum(by('requested').map((s) => s.amount)),
    paidOut: sum(by('paid_out').map((s) => s.amount)),
    flagged: sales.filter((s) => s.flag !== null).length,
    withoutPrice: sales.filter((s) => (s.state === 'waiting' || s.state === 'payable') && s.saleAmount === null).length,
  };
}

/** Что войдёт в заявку: к выплате, с посчитанной суммой. */
export function payableForRequest(sales: AgentSale[]): AgentSale[] {
  return sales.filter((s) => s.state === 'payable' && s.amount !== null && s.saleAmount !== null && s.rate !== null);
}

/** SQLSTATE ошибки базы или null. */
export function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Отказ не глушится (§4.0): имя проверки и SQLSTATE — в лог. */
export function logAgentMoneyFailure(where: string, err: unknown): void {
  console.error(`[agent-money] ${where} не выполнился:`, `sqlstate=${sqlstateOf(err) ?? 'нет'}`,
    err instanceof Error ? err.message : String(err));
}

// ── Чтение ────────────────────────────────────────────────────────────────

export interface AgentProfileRow {
  partner_id: string;
  profile_status: string;
  rate: string | null;
  rate_set_at: string | null;
}

export interface AgentMoney {
  /** null — записи агента нет (кабинет ещё не открывали). */
  profile: AgentProfileRow | null;
  rate: number | null;
  sales: AgentSale[];
  summary: AgentMoneySummary;
}

export async function loadAgentMoney(db: Queryable, agentUserId: string, lock = false): Promise<AgentMoney> {
  const prof = await db.query<AgentProfileRow>(
    lock ? AGENT_MONEY_SQL.lockAgentProfile : AGENT_MONEY_SQL.agentProfile,
    [agentUserId],
  );
  const profile = prof.rows[0] ?? null;
  const rate = num(profile?.rate ?? null);
  const res = await db.query<SaleRow>(AGENT_MONEY_SQL.sales, [agentUserId, CANCELLED_STATUS_PARAM]);
  const sales = res.rows.map((r) => classifySale(r, rate));
  return { profile, rate, sales, summary: summarize(sales, rate) };
}
