/**
 * Черновик правки прайса проката. Живую строку пишет только одобрение.
 *
 * Название машины ищет сам код по словам прокатчика, не модель: ноль
 * совпадений и несколько совпадений — разные ответы, чужую машину не берём.
 * Второй черновик той же машины, пока первый pending, дополняет его:
 * новая цена не стирает уже присланное описание и наоборот.
 *
 * Поэтому одобрение сверяет черновик с тем, что видел модератор: пока
 * карточка была открыта, прокатчик мог прислать другое число в ту же строку.
 * Не сошлось — ничего не применяется, модератору «черновик изменился».
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { draftMayApply } from '@/lib/moderation/gate';

export interface OwnedOffer {
  id: string;
  title: string;
  priceRub: number;
  priceIsFrom: boolean;
  conditions: string | null;
}

export type FindOffer =
  | { outcome: 'one'; offer: OwnedOffer }
  | { outcome: 'missing' }
  | { outcome: 'ambiguous'; count: number }
  | { outcome: 'db_error' };

export type SaveEdit =
  | {
    outcome: 'saved';
    title: string;
    livePrice: number;
    priceIsFrom: boolean;
    liveConditions: string | null;
    draftPrice: number | null;
    draftConditions: string | null;
  }
  | { outcome: 'missing' }
  | { outcome: 'ambiguous'; count: number }
  | { outcome: 'db_error' };

export interface PendingOfferEdit {
  id: string;
  offerId: string;
  partnerName: string;
  partnerSlug: string | null;
  title: string;
  livePrice: number;
  priceIsFrom: boolean;
  liveConditions: string | null;
  draftPrice: number | null;
  draftConditions: string | null;
  createdAt: string;
}

/** Цена и описание черновика, какими их показала карточка модератору. */
export interface SeenDraft {
  price: number | null;
  conditions: string | null;
}

export type DecideEdit =
  | { outcome: 'approved'; title: string; partnerId: string }
  | { outcome: 'rejected'; title: string; partnerId: string }
  | { outcome: 'already' }
  | { outcome: 'changed' }
  | { outcome: 'not_found' }
  | { outcome: 'db_error' };

const FIND_SQL = `SELECT id::text AS id, title, price_rub_per_day, price_is_from, conditions
    FROM car_rental_offers
   WHERE partner_id = $1::uuid
     AND lower(btrim(title)) = lower(btrim($2::text))`;

const SAVE_SQL = `INSERT INTO rental_offer_edits (offer_id, partner_id, price_rub_per_day, conditions)
  VALUES ($1::uuid, $2::uuid, $3::int, $4::text)
  ON CONFLICT (offer_id) WHERE moderation_status = 'pending'
  DO UPDATE SET
    price_rub_per_day = COALESCE(EXCLUDED.price_rub_per_day, rental_offer_edits.price_rub_per_day),
    conditions = COALESCE(EXCLUDED.conditions, rental_offer_edits.conditions),
    updated_at = NOW()
  RETURNING price_rub_per_day, conditions`;

function sqlState(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет';
}

export async function findOwnedOffer(partnerId: string, title: string): Promise<FindOffer> {
  try {
    const { rows } = await pool.query<{
      id: string; title: string; price_rub_per_day: number; price_is_from: boolean; conditions: string | null;
    }>(FIND_SQL, [partnerId, title]);
    if (rows.length === 0) return { outcome: 'missing' };
    if (rows.length > 1) return { outcome: 'ambiguous', count: rows.length };
    const row = rows[0];
    return {
      outcome: 'one',
      offer: {
        id: row.id,
        title: row.title,
        priceRub: row.price_rub_per_day,
        priceIsFrom: row.price_is_from === true,
        conditions: row.conditions,
      },
    };
  } catch (err) {
    console.error('[rental-offer-edit] машину не прочитал, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

export async function savePendingOfferEdit(opts: {
  partnerId: string;
  offer: OwnedOffer;
  priceRub: number | null;
  conditions: string | null;
}): Promise<SaveEdit> {
  if (opts.priceRub === null && opts.conditions === null) return { outcome: 'db_error' };
  try {
    const { rows } = await pool.query<{ price_rub_per_day: number | null; conditions: string | null }>(
      SAVE_SQL,
      [opts.offer.id, opts.partnerId, opts.priceRub, opts.conditions],
    );
    const saved = rows[0];
    if (!saved) return { outcome: 'db_error' };
    return {
      outcome: 'saved',
      title: opts.offer.title,
      livePrice: opts.offer.priceRub,
      priceIsFrom: opts.offer.priceIsFrom,
      liveConditions: opts.offer.conditions,
      draftPrice: saved.price_rub_per_day,
      draftConditions: saved.conditions,
    };
  } catch (err) {
    console.error('[rental-offer-edit] черновик не записан, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

const LIST_SQL = `SELECT e.id::text AS id, e.offer_id::text AS offer_id,
          p.name AS partner_name, NULLIF(btrim(p.slug), '') AS partner_slug,
          o.title, o.price_rub_per_day AS live_price, o.price_is_from, o.conditions AS live_conditions,
          e.price_rub_per_day AS draft_price, e.conditions AS draft_conditions,
          e.created_at::text AS created_at
     FROM rental_offer_edits e
     JOIN car_rental_offers o ON o.id = e.offer_id AND o.partner_id = e.partner_id
     JOIN partners p ON p.id = e.partner_id
    WHERE e.moderation_status = 'pending'
    ORDER BY e.created_at, e.id`;

export async function listPendingOfferEdits(): Promise<
  { outcome: 'ok'; edits: PendingOfferEdit[] } | { outcome: 'db_error' }
> {
  try {
    const { rows } = await pool.query<{
      id: string; offer_id: string; partner_name: string; partner_slug: string | null;
      title: string; live_price: number; price_is_from: boolean; live_conditions: string | null;
      draft_price: number | null; draft_conditions: string | null; created_at: string;
    }>(LIST_SQL);
    return {
      outcome: 'ok',
      edits: rows.map((r) => ({
        id: r.id,
        offerId: r.offer_id,
        partnerName: r.partner_name,
        partnerSlug: r.partner_slug,
        title: r.title,
        livePrice: r.live_price,
        priceIsFrom: r.price_is_from === true,
        liveConditions: r.live_conditions,
        draftPrice: r.draft_price,
        draftConditions: r.draft_conditions,
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    console.error('[rental-offer-edit] очередь не прочитана, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

const LOCK_SQL = `SELECT e.id::text AS id, e.offer_id::text AS offer_id, e.partner_id::text AS partner_id,
          e.price_rub_per_day, e.conditions, e.moderation_status, o.title
     FROM rental_offer_edits e
     JOIN car_rental_offers o ON o.id = e.offer_id AND o.partner_id = e.partner_id
    WHERE e.id = $1::uuid
    FOR UPDATE OF e`;

const APPLY_SQL = `UPDATE car_rental_offers
      SET price_rub_per_day = COALESCE($2::int, price_rub_per_day),
          conditions = CASE WHEN $3::text IS NULL THEN conditions ELSE $3::text END,
          updated_at = NOW()
    WHERE id = $1::uuid AND partner_id = $4::uuid
    RETURNING id`;

const DECIDE_SQL = `UPDATE rental_offer_edits
      SET moderation_status = $2::varchar,
          moderation_reason = $3::text,
          moderated_at = NOW(),
          moderated_by = $4::uuid,
          updated_at = NOW()
    WHERE id = $1::uuid AND moderation_status = 'pending'
    RETURNING id`;

export async function decideOfferEdit(opts: {
  id: string;
  action: 'approve' | 'reject';
  reason: string | null;
  moderatedBy: string | null;
  /** Что было в карточке. Одобрение без него или при расхождении не применяется. */
  seen: SeenDraft | null;
}): Promise<DecideEdit> {
  const next = opts.action === 'approve' ? 'approved' : 'rejected';
  if (opts.action === 'approve' && !draftMayApply(next)) return { outcome: 'db_error' };

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[rental-offer-edit] соединение не взято, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
  try {
    await client.query('BEGIN');
    const locked = await client.query<{
      id: string; offer_id: string; partner_id: string;
      price_rub_per_day: number | null; conditions: string | null;
      moderation_status: string; title: string;
    }>(LOCK_SQL, [opts.id]);
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }
    if (row.moderation_status !== 'pending') {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    if (opts.action === 'approve') {
      if (
        opts.seen === null
        || row.price_rub_per_day !== opts.seen.price
        || row.conditions !== opts.seen.conditions
      ) {
        await client.query('ROLLBACK');
        return { outcome: 'changed' };
      }
      const applied = await client.query(APPLY_SQL, [
        row.offer_id, row.price_rub_per_day, row.conditions, row.partner_id,
      ]);
      if (applied.rows.length !== 1) {
        await client.query('ROLLBACK');
        console.error('[rental-offer-edit] живая строка не обновлена', row.offer_id);
        return { outcome: 'db_error' };
      }
    }
    const decided = await client.query(DECIDE_SQL, [opts.id, next, opts.reason, opts.moderatedBy]);
    if (decided.rows.length !== 1) {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    await client.query('COMMIT');
    return opts.action === 'approve'
      ? { outcome: 'approved', title: row.title, partnerId: row.partner_id }
      : { outcome: 'rejected', title: row.title, partnerId: row.partner_id };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[rental-offer-edit] откат не прошёл, SQLSTATE', sqlState(rollbackErr));
    }
    console.error('[rental-offer-edit] решение не записано, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  } finally {
    client.release();
  }
}
