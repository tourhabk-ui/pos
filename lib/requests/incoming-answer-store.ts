/**
 * Запись ответа на входящую заявку. Партнёр — из привязанного чата.
 * Чужой предмет строку не создаёт. Повтор не переписывает первый ответ.
 * Отказ базы — отдельный исход, SQLSTATE в логе, без персональных данных.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { isIncomingSubjectId, type IncomingAnswer, type IncomingKind } from '@/lib/requests/incoming-card';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OWNER_SQL: Record<IncomingKind, string> = {
  lead: `SELECT operator_id::text AS owner FROM leads WHERE id::text = $1`,
  stay_request: `SELECT a.partner_id::text AS owner
                   FROM stay_requests r
                   JOIN accommodations a ON a.id = r.accommodation_id
                  WHERE r.id::text = $1`,
  stay_booking: `SELECT a.partner_id::text AS owner
                   FROM accommodation_bookings b
                   JOIN accommodations a ON a.id = b.accommodation_id
                  WHERE b.id::text = $1`,
  gear: `SELECT gi.partner_id::text AS owner
           FROM gear_rentals r
           JOIN gear_items gi ON gi.id = r.gear_id
          WHERE r.id::text = $1`,
  // У брони нет своего operator_id: владелец — партнёр тура (operator-owns).
  booking: `SELECT t.operator_id::text AS owner
              FROM operator_bookings b
              JOIN operator_tours t ON t.id = b.operator_tour_id
             WHERE b.id::text = $1
               AND b.deleted_at IS NULL
               AND t.deleted_at IS NULL`,
};

export type ClaimIncoming =
  | { outcome: 'saved' }
  | { outcome: 'already'; answer: IncomingAnswer }
  | { outcome: 'missing' | 'not_yours' | 'unread' };

function sqlState(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет';
}

function isAnswer(value: string | null | undefined): value is IncomingAnswer {
  return value === 'accept' || value === 'no_seats' || value === 'clarify' || value === 'self';
}

export async function claimIncomingAnswer(opts: {
  partnerId: string;
  kind: IncomingKind;
  subjectId: string;
  answer: IncomingAnswer;
}): Promise<ClaimIncoming> {
  if (!UUID.test(opts.partnerId) || !isIncomingSubjectId(opts.subjectId)) return { outcome: 'missing' };
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[incoming-answer] соединение не взято, SQLSTATE', sqlState(err));
    return { outcome: 'unread' };
  }
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${opts.kind}:${opts.subjectId}`]);
    const owned = await client.query<{ owner: string | null }>(OWNER_SQL[opts.kind], [opts.subjectId]);
    const owner = owned.rows[0]?.owner ?? null;
    if (!owned.rows[0]) {
      await client.query('ROLLBACK');
      return { outcome: 'missing' };
    }
    if (owner !== opts.partnerId) {
      await client.query('ROLLBACK');
      return { outcome: 'not_yours' };
    }
    const inserted = await client.query<{ answer: string }>(
      `INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer)
       VALUES ($1::uuid, $2::text, $3::text, $4::text)
       ON CONFLICT (subject_kind, subject_id) DO NOTHING
       RETURNING answer`,
      [opts.partnerId, opts.kind, opts.subjectId, opts.answer],
    );
    if (inserted.rows[0]) {
      await client.query('COMMIT');
      return { outcome: 'saved' };
    }
    const prior = await client.query<{ answer: string }>(
      `SELECT answer FROM partner_incoming_answers
        WHERE subject_kind = $1::text AND subject_id = $2::text`,
      [opts.kind, opts.subjectId],
    );
    await client.query('COMMIT');
    const answer = prior.rows[0]?.answer;
    if (!isAnswer(answer)) {
      console.error('[incoming-answer] строка конфликта без известного ответа');
      return { outcome: 'unread' };
    }
    return { outcome: 'already', answer };
  } catch (err) {
    await client.query('ROLLBACK').catch((rb) => {
      console.error('[incoming-answer] откат не выполнен, SQLSTATE', sqlState(rb));
    });
    console.error('[incoming-answer] ответ не записан, SQLSTATE', sqlState(err));
    return { outcome: 'unread' };
  } finally {
    client.release();
  }
}
