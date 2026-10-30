/**
 * Чтение заявки партнёру (прокат или машина целиком, #2862) и запись его
 * ответа. Партнёр — из привязанного чата: чужой lead_id строку не создаёт.
 * Отказ базы — отдельный исход, с SQLSTATE в логе, без ПД.
 *
 * Ответ обоих видов — одна строка `lead_activity_log.partner_answered` под
 * одним уникальным индексом (1326): второго ответа на заявку не бывает ни
 * у проката, ни у перевозчика. В деталях — `kind` и `at` (ISO из
 * приложения: у `created_at` таблицы тип без зоны, см. delivery-outcome), по
 * `at` «Входящие» перевозчика считают время первого ответа.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { isLeadId, rentalSpanDays, type PartnerRequestKind, type RequestAnswer } from '@/lib/rental/request-answer';

interface Sql {
  query: PoolClient['query'];
}

export interface OwnedRentalRequest {
  kind: PartnerRequestKind;
  leadId: string;
  /** Машина проката из заявки; у заявки на машину целиком — null. */
  offerId: string | null;
  /** У проката — машина, у заявки на машину — направление. */
  title: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export type LoadRequest =
  | { outcome: 'ok'; request: OwnedRentalRequest }
  /** `not_request` — лид есть и этого партнёра, но это не заявка на прокат и не на машину. */
  | { outcome: 'missing' | 'not_yours' | 'not_request' | 'db_error' };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export async function loadOwnedRentalRequest(partnerId: string, leadId: string): Promise<LoadRequest> {
  if (!isLeadId(leadId) || !isLeadId(partnerId)) return { outcome: 'missing' };
  try {
    const { rows } = await pool.query<{ id: string; operator_id: string | null; source_data: unknown }>(
      `SELECT id::text AS id, operator_id::text AS operator_id, source_data
         FROM leads
        WHERE id = $1::uuid`,
      [leadId],
    );
    const row = rows[0];
    if (!row) return { outcome: 'missing' };
    if (row.operator_id !== partnerId) return { outcome: 'not_yours' };
    const data = asRecord(row.source_data);
    if (!data || (data.kind !== 'car_rental' && data.kind !== 'charter')) return { outcome: 'not_request' };
    if (data.kind === 'charter') {
      // Заявка на машину целиком (lib/transfers/charter-request): адресат —
      // carrier_id; расходится с operator_id — не его, как у проката company_id.
      const carrierId = asText(data.carrier_id);
      if (carrierId && carrierId !== partnerId) return { outcome: 'not_yours' };
      return {
        outcome: 'ok',
        request: {
          kind: 'charter',
          leadId: row.id,
          offerId: null,
          title: asText(data.destination),
          dateFrom: asText(data.date_from),
          dateTo: asText(data.date_to),
        },
      };
    }
    const companyId = asText(data.company_id);
    if (companyId && companyId !== partnerId) return { outcome: 'not_yours' };
    const offerId = asText(data.offer_id);
    return {
      outcome: 'ok',
      request: {
        kind: 'car_rental',
        leadId: row.id,
        offerId: offerId && isLeadId(offerId) ? offerId.toLowerCase() : null,
        title: asText(data.offer_title),
        dateFrom: asText(data.date_from),
        dateTo: asText(data.date_to),
      },
    };
  } catch (err) {
    console.error('[rental-request-answer] заявка не прочитана, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return { outcome: 'db_error' };
  }
}

export type ResolveOffer =
  | { outcome: 'ok'; offerId: string; title: string }
  | { outcome: 'none' | 'ambiguous' | 'db_error' };

/**
 * Машина заявки в прайсе этого прокатчика. id из заявки — если он его.
 * Иначе одно точное название. Два совпадения — не выбираем: чужую машину
 * занятой не помечаем.
 */
export async function resolveRequestOffer(
  partnerId: string,
  offerId: string | null,
  title: string | null,
): Promise<ResolveOffer> {
  try {
    if (offerId && isLeadId(offerId)) {
      const { rows } = await pool.query<{ id: string; title: string }>(
        `SELECT id::text AS id, title
           FROM car_rental_offers
          WHERE partner_id = $1::uuid AND id = $2::uuid`,
        [partnerId, offerId],
      );
      const row = rows[0];
      if (row) return { outcome: 'ok', offerId: row.id, title: row.title };
      return { outcome: 'none' };
    }
    const name = title?.trim() ?? '';
    if (!name) return { outcome: 'none' };
    const { rows } = await pool.query<{ id: string; title: string }>(
      `SELECT id::text AS id, title
         FROM car_rental_offers
        WHERE partner_id = $1::uuid AND lower(btrim(title)) = lower(btrim($2::text))
        LIMIT 2`,
      [partnerId, name],
    );
    if (rows.length === 1) return { outcome: 'ok', offerId: rows[0]!.id, title: rows[0]!.title };
    if (rows.length === 0) return { outcome: 'none' };
    return { outcome: 'ambiguous' };
  } catch (err) {
    console.error('[rental-request-answer] машина заявки не прочитана, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return { outcome: 'db_error' };
  }
}

export type MarkRequest = { outcome: 'saved'; marked: number } | { outcome: 'not_yours' | 'bad_dates' | 'db_error' };

/**
 * «Беру»: дни заявки заняты, source `request`, lead_id — эта заявка.
 * Чужой offer не создаёт строк. Повтор той же заявки перезаписывает те же дни.
 */
const MARK_SQL = `INSERT INTO rental_car_busy (offer_id, day, busy, source, lead_id)
       SELECT o.id, d.day::date, TRUE, 'request', $4::uuid
         FROM car_rental_offers o
         CROSS JOIN unnest($3::text[]) AS d(day)
        WHERE o.id = $1::uuid AND o.partner_id = $2::uuid
       ON CONFLICT (offer_id, day) DO UPDATE
         SET busy = TRUE,
             source = 'request',
             lead_id = EXCLUDED.lead_id,
             updated_at = NOW()
       RETURNING day::text AS day`;

async function markBusyOn(
  db: Sql,
  partnerId: string,
  offerId: string,
  dateFrom: string,
  dateTo: string,
  leadId: string,
): Promise<MarkRequest> {
  const days = rentalSpanDays(dateFrom, dateTo);
  if (!days) return { outcome: 'bad_dates' };
  const { rows } = await db.query<{ day: string }>(MARK_SQL, [offerId, partnerId, days, leadId]);
  if (rows.length === 0) return { outcome: 'not_yours' };
  if (rows.length !== days.length) {
    console.error('[rental-request-answer] отмечено дней', rows.length, 'из', days.length);
    return { outcome: 'db_error' };
  }
  return { outcome: 'saved', marked: rows.length };
}

async function readAnswerOn(db: Sql, leadId: string): Promise<RequestAnswer | 'none'> {
  const { rows } = await db.query<{ answer: string | null }>(
    `SELECT details->>'answer' AS answer
       FROM lead_activity_log
      WHERE lead_id = $1::uuid AND action = 'partner_answered'
      ORDER BY id DESC
      LIMIT 1`,
    [leadId],
  );
  const answer = rows[0]?.answer;
  if (answer === 'take' || answer === 'decline') return answer;
  return 'none';
}

export async function readPartnerAnswer(leadId: string): Promise<RequestAnswer | 'none' | 'db_error'> {
  try {
    return await readAnswerOn(pool, leadId);
  } catch (err) {
    console.error('[rental-request-answer] журнал ответа не прочитан, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return 'db_error';
  }
}

export type ClaimAnswer =
  | { outcome: 'saved'; marked: number | null }
  | { outcome: 'already'; answer: RequestAnswer }
  | { outcome: 'db_error' };

/**
 * Один ответ на заявку. Замок на id заявки, потом чтение, отметка дней и
 * журнал — в одной транзакции. Второе нажатие видит уже записанный ответ и
 * дни не трогает. Отказ отметки откатывает и журнал: кнопку можно нажать
 * снова, «Не могу» не запишется поверх занятых дней.
 */
export async function claimPartnerAnswer(opts: {
  leadId: string;
  answer: RequestAnswer;
  /** Вид заявки — в детали журнала; по умолчанию прокат (так писали до 30.10). */
  kind?: PartnerRequestKind;
  partnerId: string;
  offerId: string | null;
  carTitle: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** Отметить дни в этой же транзакции. null — ответ без отметки. */
  mark: { offerId: string; dateFrom: string; dateTo: string } | null;
  /** Часы приложения — для `at` в деталях; подставляются в тесте. */
  now?: Date;
}): Promise<ClaimAnswer> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[rental-request-answer] соединение не взято, SQLSTATE', (err as { code?: string }).code ?? 'нет');
    return { outcome: 'db_error' };
  }
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [opts.leadId]);
    const prior = await readAnswerOn(client, opts.leadId);
    if (prior === 'take' || prior === 'decline') {
      await client.query('ROLLBACK');
      return { outcome: 'already', answer: prior };
    }
    let marked: number | null = null;
    if (opts.mark) {
      const wrote = await markBusyOn(
        client, opts.partnerId, opts.mark.offerId, opts.mark.dateFrom, opts.mark.dateTo, opts.leadId,
      );
      if (wrote.outcome === 'db_error') {
        await client.query('ROLLBACK');
        return { outcome: 'db_error' };
      }
      if (wrote.outcome === 'saved') marked = wrote.marked;
    }
    await client.query(
      `INSERT INTO lead_activity_log (lead_id, actor, action, details)
       VALUES ($1::uuid, 'partner', 'partner_answered', $2::jsonb)`,
      [opts.leadId, JSON.stringify({
        answer: opts.answer,
        kind: opts.kind ?? 'car_rental',
        at: (opts.now ?? new Date()).toISOString(),
        offer_id: opts.offerId,
        car_title: opts.carTitle,
        date_from: opts.dateFrom,
        date_to: opts.dateTo,
        days_marked: marked,
      })],
    );
    await client.query('COMMIT');
    return { outcome: 'saved', marked };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[rental-request-answer] откат не прошёл, SQLSTATE', (rollbackErr as { code?: string }).code ?? 'нет');
    }
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      try {
        const prior = await readAnswerOn(pool, opts.leadId);
        if (prior === 'take' || prior === 'decline') return { outcome: 'already', answer: prior };
      } catch (readErr) {
        console.error('[rental-request-answer] ответ после конфликта не прочитан, SQLSTATE', (readErr as { code?: string }).code ?? 'нет');
      }
    }
    console.error('[rental-request-answer] ответ не зафиксирован, SQLSTATE', code ?? 'нет');
    return { outcome: 'db_error' };
  } finally {
    client.release();
  }
}
