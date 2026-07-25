/**
 * Кто платит за скидку по эко — Закон 5 из docs/ECO.md («эмиссия обеспечена
 * стоком»).
 *
 * Решение владельца 25.07.2026, две фазы:
 *
 *   Фаза 1 — ПЛАТФОРМА. Пока активных операторов меньше двадцати, скидку
 *   компенсирует платформа из своей комиссии. На старте нельзя требовать
 *   участия от тех, кто ещё не получил от программы потока клиентов: иначе
 *   операторы просто не подключатся, и эко станут фантиком.
 *
 *   Фаза 2 — ОПЕРАТОРЫ. С двадцатого активного оператора обязательство
 *   переходит к ним. К этому моменту программа уже приносит поток, и участие
 *   в ней окупается.
 *
 * Фазы различаются ТОЛЬКО плательщиком. Доля чека под эко — 15% на все стоки
 * в обеих фазах (MAX_SHARE_OF_CHECK в sinks.ts). Первоначально операторская
 * фаза задавалась вдвое меньшей, но тогда потолок для туриста обрывался вдвое
 * в день появления двадцатого оператора: копил под одни условия, тратил под
 * другие. Обрыва больше нет — и не может появиться, потому что делить нечего.
 *
 * Порог — не оценочное суждение, а счётное: активным считается оператор,
 * который реально продаёт. Иначе обязательство переложили бы на витрину из
 * мёртвых карточек.
 *
 * Обязательство фиксируется записью в eco_compensation_claims (миграция 774).
 * Без неё «платформа компенсирует» — просто слова: не с чем сверяться и нечего
 * предъявить.
 */
import { pool } from '@/lib/db-pool';
import { ECO_SINKS, resolveSink, type EcoSink } from '@/lib/eco/sinks';

export type EcoPayer = 'platform' | 'operator';

/** С двадцатого активного оператора обязательство переходит к операторам. */
export const ACTIVE_OPERATOR_THRESHOLD = 20;

/** Окно, в котором продажа считается свежей. */
export const ACTIVE_WINDOW_DAYS = 90;

/**
 * Кто платит при таком числе активных операторов. Чистая функция — под тестом.
 * Порог включающий: ровно двадцать — уже фаза операторов.
 */
export function resolvePayer(activeOperators: number): EcoPayer {
  return activeOperators >= ACTIVE_OPERATOR_THRESHOLD ? 'operator' : 'platform';
}

/**
 * Активный оператор — тот, кто продаёт: есть живой опубликованный тур и хотя
 * бы одна неотменённая бронь за окно. Определение намеренно строгое: порог
 * переключает, кто несёт расход, и набрать его регистрациями нельзя.
 */
export async function countActiveOperators(): Promise<number> {
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT p.id)::text AS cnt
     FROM partners p
     JOIN operator_tours t
       ON t.operator_id = p.id AND t.is_active = TRUE AND t.deleted_at IS NULL
     JOIN operator_bookings b
       ON b.operator_tour_id = t.id
      AND b.created_at >= NOW() - make_interval(days => $1)
      AND b.booking_status <> 'cancelled'
      AND b.deleted_at IS NULL
     WHERE p.category = 'operator' AND p.is_active = TRUE`,
    [ACTIVE_WINDOW_DAYS],
  );
  return Number(rows[0]?.cnt ?? 0);
}

export interface CompensationTerms {
  payer: EcoPayer;
  /** Доля чека, которую можно закрыть эко. От фазы не зависит — см. шапку. */
  maxShareOfCheck: number;
  activeOperators: number;
  threshold: number;
}

/** Условия стока в текущей фазе: меняется плательщик, доля — нет. */
export function termsFor(sink: EcoSink, activeOperators: number): CompensationTerms {
  return {
    payer: resolvePayer(activeOperators),
    maxShareOfCheck: sink.maxShareOfCheck,
    activeOperators,
    threshold: ACTIVE_OPERATOR_THRESHOLD,
  };
}

/** Сколько эко примет чек. Одинаково в обеих фазах — платит только разный. */
export function maxEcoForCheck(sink: EcoSink, checkAmountRub: number, activeOperators: number): number {
  if (checkAmountRub <= 0) return 0;
  return Math.floor(checkAmountRub * termsFor(sink, activeOperators).maxShareOfCheck);
}

/** Текущие условия по всем стокам — для витрины и для сторожа. */
export async function currentTerms(): Promise<{ activeOperators: number; payer: EcoPayer; sinks: Record<string, CompensationTerms> }> {
  const activeOperators = await countActiveOperators();
  const sinks: Record<string, CompensationTerms> = {};
  for (const [key, sink] of Object.entries(ECO_SINKS)) {
    sinks[key] = termsFor(sink, activeOperators);
  }
  return { activeOperators, payer: resolvePayer(activeOperators), sinks };
}

export interface ClaimInput {
  /** id проводки списания в eco_ledger. */
  ledgerId: string;
  sinkKey: string;
  ecoAmount: number;
  /** Рублёвый эквивалент скидки. */
  rubAmount: number;
  /** Оператор чека — нужен, когда платит он. */
  operatorId?: string | null;
}

export type ClaimResult =
  | { ok: true; payer: EcoPayer }
  | { ok: false; message: string };

/**
 * Зафиксировать обязательство по конкретному списанию. Кто платил — часть
 * истории: после перехода к фазе операторов старые претензии остаются на
 * платформе, а не переписываются задним числом.
 */
export async function recordClaim(input: ClaimInput): Promise<ClaimResult> {
  const sink = resolveSink(input.sinkKey);
  if (!sink.ok) return { ok: false, message: sink.reason };
  if (input.ecoAmount <= 0) return { ok: false, message: 'Пустое списание не порождает обязательства' };

  const payer = resolvePayer(await countActiveOperators());
  if (payer === 'operator' && !input.operatorId) {
    return { ok: false, message: 'Не указан оператор, который компенсирует скидку' };
  }

  try {
    await pool.query(
      `INSERT INTO eco_compensation_claims
         (ledger_id, sink, eco_amount, rub_amount, payer, operator_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ledger_id) DO NOTHING`,
      [input.ledgerId, input.sinkKey, input.ecoAmount, input.rubAmount, payer, input.operatorId ?? null],
    );
    return { ok: true, payer };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Ошибка записи обязательства' };
  }
}

export interface CompensationSummary {
  payer: EcoPayer;
  pendingClaims: number;
  pendingRub: number;
}

/** Сколько и кому платформа/операторы должны по нерасчитанным претензиям. */
export async function pendingCompensation(): Promise<CompensationSummary[]> {
  const { rows } = await pool.query<{ payer: EcoPayer; cnt: string; rub: string }>(
    `SELECT payer, COUNT(*)::text AS cnt, COALESCE(SUM(rub_amount), 0)::text AS rub
     FROM eco_compensation_claims
     WHERE status = 'pending'
     GROUP BY payer`,
  );
  return rows.map((r) => ({
    payer: r.payer,
    pendingClaims: Number(r.cnt),
    pendingRub: Number(r.rub),
  }));
}
