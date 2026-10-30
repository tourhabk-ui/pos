/**
 * Черновики прайса перевозчика в базе (миграция 1355). Живую строку
 * transfer_charter_prices пишет только одобрение.
 *
 * Как у проката (lib/rental/offer-edit-store): строку прайса ищет код по
 * словам перевозчика или по id, чужую не берёт; второй черновик той же
 * строки, пока первый pending, дополняет его (COALESCE), а не стирает;
 * одобрение сверяет черновик с тем, что видел модератор, — не сошлось,
 * ничего не применяется.
 *
 * Новая строка прайса одобрением ВСТАВЛЯЕТСЯ в живую таблицу; уникальные
 * индексы 1185/1292 (одно направление на вид машины, один тариф на вид)
 * судят дубль сами: 23505 — отдельный исход `duplicate`, черновик остаётся
 * pending, модератор отклоняет его с причиной.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { draftMayApply } from '@/lib/moderation/gate';
import { matchDestinations } from '@/lib/transfers/charter-format';
import {
  checkNewRowShape, patchIsEmpty, priceRowLabel, seenMatches,
  type CharterLineKind, type CharterPriceNewRow, type CharterPricePatch, type CharterPriceRow, type CharterPriceTarget,
  type SeenPriceDraft,
} from '@/lib/transfers/price-edit';
import type { CharterVehicleKind } from '@/lib/transfers/charter-format';

function sqlState(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет';
}

interface PriceRowDb {
  id: string; vehicle_kind: CharterVehicleKind; line_kind: CharterLineKind;
  from_text: string | null; to_text: string | null; price_rub: number; price_note: string | null;
  conditions: string | null; valid_year: number | null; is_active: boolean;
}

function toRow(r: PriceRowDb): CharterPriceRow {
  return {
    id: r.id,
    vehicleKind: r.vehicle_kind,
    lineKind: r.line_kind,
    fromText: r.from_text,
    toText: r.to_text,
    priceRub: r.price_rub,
    priceNote: r.price_note,
    conditions: r.conditions,
    validYear: r.valid_year,
    isActive: r.is_active === true,
  };
}

const ROW_COLUMNS = `id::text AS id, vehicle_kind, line_kind, from_text, to_text, price_rub, price_note,
          conditions, valid_year, is_active`;

const OWN_ROWS_SQL = `SELECT ${ROW_COLUMNS}
     FROM transfer_charter_prices
    WHERE partner_id = $1::uuid
    ORDER BY is_active DESC, sort_order, line_kind, to_text, vehicle_kind`;

export type OwnRows = { outcome: 'ok'; rows: CharterPriceRow[] } | { outcome: 'db_error' };

/** Все строки прайса перевозчика — и скрытые. */
export async function loadOwnPriceRows(partnerId: string): Promise<OwnRows> {
  try {
    const { rows } = await pool.query<PriceRowDb>(OWN_ROWS_SQL, [partnerId]);
    return { outcome: 'ok', rows: rows.map(toRow) };
  } catch (err) {
    console.error('[charter-price-edit] прайс не прочитан, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

export type FindRow =
  | { outcome: 'one'; row: CharterPriceRow }
  | { outcome: 'missing' }
  | { outcome: 'ambiguous'; rows: CharterPriceRow[] }
  | { outcome: 'db_error' };

/**
 * Строка прайса по цели команды из чата. Направление — той же мерой, что
 * поиск и заявка (matchDestinations: точное имя побеждает, иначе все слова);
 * тариф и доплата — по роду строки. Несколько строк (разные виды машин,
 * похожие направления) — не выбираем.
 */
export async function findOwnPriceRow(partnerId: string, target: CharterPriceTarget): Promise<FindRow> {
  const own = await loadOwnPriceRows(partnerId);
  if (own.outcome === 'db_error') return { outcome: 'db_error' };
  let hits: CharterPriceRow[];
  if (target.kind === 'destination') {
    const lines = own.rows
      .filter((r) => r.lineKind === 'destination' && r.fromText && r.toText)
      .map((r) => ({ row: r, from: r.fromText as string, to: r.toText as string }));
    hits = matchDestinations(lines, target.words).map((l) => l.row);
  } else if (target.kind === 'rate') {
    const kind: CharterLineKind = target.unit === 'hour' ? 'per_hour' : 'per_day';
    hits = own.rows.filter((r) => r.lineKind === kind);
  } else {
    hits = own.rows.filter((r) => r.lineKind === 'extra_day');
  }
  if (hits.length === 0) return { outcome: 'missing' };
  if (hits.length > 1) return { outcome: 'ambiguous', rows: hits };
  return { outcome: 'one', row: hits[0]! };
}

/** Строка прайса по id — только своя. */
export async function findOwnPriceRowById(partnerId: string, priceId: string): Promise<FindRow> {
  try {
    const { rows } = await pool.query<PriceRowDb>(
      `SELECT ${ROW_COLUMNS} FROM transfer_charter_prices WHERE id = $2::uuid AND partner_id = $1::uuid`,
      [partnerId, priceId],
    );
    if (rows.length === 0) return { outcome: 'missing' };
    return { outcome: 'one', row: toRow(rows[0]!) };
  } catch (err) {
    console.error('[charter-price-edit] строка прайса не прочитана, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

const SAVE_EDIT_SQL = `INSERT INTO transfer_charter_price_edits (partner_id, price_id, price_rub, price_note, conditions, is_active)
  VALUES ($1::uuid, $2::uuid, $3::int, $4::varchar, $5::text, $6::boolean)
  ON CONFLICT (price_id) WHERE moderation_status = 'pending'
  DO UPDATE SET
    price_rub = COALESCE(EXCLUDED.price_rub, transfer_charter_price_edits.price_rub),
    price_note = COALESCE(EXCLUDED.price_note, transfer_charter_price_edits.price_note),
    conditions = COALESCE(EXCLUDED.conditions, transfer_charter_price_edits.conditions),
    is_active = COALESCE(EXCLUDED.is_active, transfer_charter_price_edits.is_active),
    updated_at = NOW()
  RETURNING id::text AS id, price_rub, price_note, conditions, is_active`;

export interface SavedPatch {
  id: string;
  label: string;
  live: CharterPriceRow;
  draft: CharterPricePatch;
}

export type SavePatch =
  | { outcome: 'saved'; saved: SavedPatch }
  | { outcome: 'empty' }
  | { outcome: 'db_error' };

/** Черновик правки существующей строки (строка уже проверена как своя). */
export async function savePricePatch(opts: {
  partnerId: string;
  row: CharterPriceRow;
  patch: CharterPricePatch;
}): Promise<SavePatch> {
  if (patchIsEmpty(opts.patch)) return { outcome: 'empty' };
  try {
    const { rows } = await pool.query<{
      id: string; price_rub: number | null; price_note: string | null; conditions: string | null; is_active: boolean | null;
    }>(SAVE_EDIT_SQL, [
      opts.partnerId, opts.row.id, opts.patch.priceRub, opts.patch.priceNote, opts.patch.conditions, opts.patch.isActive,
    ]);
    const saved = rows[0];
    if (!saved) return { outcome: 'db_error' };
    return {
      outcome: 'saved',
      saved: {
        id: saved.id,
        label: priceRowLabel(opts.row),
        live: opts.row,
        draft: { priceRub: saved.price_rub, priceNote: saved.price_note, conditions: saved.conditions, isActive: saved.is_active },
      },
    };
  } catch (err) {
    console.error('[charter-price-edit] черновик правки не записан, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

const SAVE_NEW_SQL = `INSERT INTO transfer_charter_price_edits
    (partner_id, vehicle_kind, line_kind, from_text, to_text, price_rub, price_note, conditions, valid_year)
  VALUES ($1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::int, $7::varchar, $8::text, $9::int)
  RETURNING id::text AS id`;

export type SaveNew =
  | { outcome: 'saved'; id: string; label: string }
  | { outcome: 'bad_shape'; reason: string }
  | { outcome: 'db_error' };

/** Черновик новой строки прайса. Форма проверяется до запроса — и базой ещё раз. */
export async function saveNewPriceDraft(opts: { partnerId: string; row: CharterPriceNewRow }): Promise<SaveNew> {
  const shape = checkNewRowShape(opts.row);
  if (!shape.ok) return { outcome: 'bad_shape', reason: shape.reason };
  const r = opts.row;
  try {
    const { rows } = await pool.query<{ id: string }>(SAVE_NEW_SQL, [
      opts.partnerId, r.vehicleKind, r.lineKind, r.fromText, r.toText, r.priceRub, r.priceNote, r.conditions, r.validYear,
    ]);
    const saved = rows[0];
    if (!saved) return { outcome: 'db_error' };
    return { outcome: 'saved', id: saved.id, label: priceRowLabel({ ...r }) };
  } catch (err) {
    console.error('[charter-price-edit] черновик новой строки не записан, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

// ── Черновики перевозчика (кабинет) ─────────────────────────────────────────

export interface OwnDraft {
  id: string;
  /** null — черновик новой строки. */
  priceId: string | null;
  priceRub: number | null;
  priceNote: string | null;
  conditions: string | null;
  isActive: boolean | null;
  vehicleKind: CharterVehicleKind | null;
  lineKind: CharterLineKind | null;
  fromText: string | null;
  toText: string | null;
  validYear: number | null;
  status: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  createdAt: string;
  moderatedAt: string | null;
}

export type OwnDrafts = { outcome: 'ok'; drafts: OwnDraft[] } | { outcome: 'db_error' };

const OWN_DRAFTS_SQL = `SELECT e.id::text AS id, e.price_id::text AS price_id,
          e.price_rub, e.price_note, e.conditions, e.is_active,
          e.vehicle_kind, e.line_kind, e.from_text, e.to_text, e.valid_year,
          e.moderation_status, e.moderation_reason,
          e.created_at::text AS created_at, e.moderated_at::text AS moderated_at
     FROM transfer_charter_price_edits e
    WHERE e.partner_id = $1::uuid
      AND (e.moderation_status = 'pending' OR e.moderated_at > NOW() - INTERVAL '30 days')
    ORDER BY (e.moderation_status = 'pending') DESC, e.created_at DESC, e.id
    LIMIT $2::int`;

const DRAFT_LIMIT = 40;

/** Черновики перевозчика: ждущие и решённые за 30 дней — причина отказа видна ему. */
export async function loadOwnDrafts(partnerId: string, limit: number = DRAFT_LIMIT): Promise<OwnDrafts> {
  try {
    const { rows } = await pool.query<{
      id: string; price_id: string | null; price_rub: number | null; price_note: string | null; conditions: string | null;
      is_active: boolean | null; vehicle_kind: CharterVehicleKind | null; line_kind: CharterLineKind | null;
      from_text: string | null; to_text: string | null; valid_year: number | null;
      moderation_status: string; moderation_reason: string | null; created_at: string; moderated_at: string | null;
    }>(OWN_DRAFTS_SQL, [partnerId, limit]);
    return {
      outcome: 'ok',
      drafts: rows.map((r) => ({
        id: r.id,
        priceId: r.price_id,
        priceRub: r.price_rub,
        priceNote: r.price_note,
        conditions: r.conditions,
        isActive: r.is_active,
        vehicleKind: r.vehicle_kind,
        lineKind: r.line_kind,
        fromText: r.from_text,
        toText: r.to_text,
        validYear: r.valid_year,
        status: r.moderation_status === 'approved' ? 'approved' : r.moderation_status === 'rejected' ? 'rejected' : 'pending',
        reason: r.moderation_reason,
        createdAt: r.created_at,
        moderatedAt: r.moderated_at,
      })),
    };
  } catch (err) {
    console.error('[charter-price-edit] черновики не прочитаны, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

// ── Очередь модерации ───────────────────────────────────────────────────────

export interface PendingPriceEdit {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerSlug: string | null;
  /** null — новая строка. */
  priceId: string | null;
  /** Живая строка, которую правят; null — у новой. */
  live: CharterPriceRow | null;
  draft: SeenPriceDraft;
  createdAt: string;
}

const LIST_SQL = `SELECT e.id::text AS id, e.partner_id::text AS partner_id, e.price_id::text AS price_id,
          p.name AS partner_name, NULLIF(btrim(p.slug), '') AS partner_slug,
          e.price_rub AS d_price_rub, e.price_note AS d_price_note, e.conditions AS d_conditions, e.is_active AS d_is_active,
          e.vehicle_kind AS d_vehicle_kind, e.line_kind AS d_line_kind, e.from_text AS d_from_text, e.to_text AS d_to_text,
          e.valid_year AS d_valid_year,
          c.id::text AS l_id, c.vehicle_kind AS l_vehicle_kind, c.line_kind AS l_line_kind, c.from_text AS l_from_text,
          c.to_text AS l_to_text, c.price_rub AS l_price_rub, c.price_note AS l_price_note, c.conditions AS l_conditions,
          c.valid_year AS l_valid_year, c.is_active AS l_is_active,
          e.created_at::text AS created_at
     FROM transfer_charter_price_edits e
     JOIN partners p ON p.id = e.partner_id
     LEFT JOIN transfer_charter_prices c ON c.id = e.price_id AND c.partner_id = e.partner_id
    WHERE e.moderation_status = 'pending'
    ORDER BY e.created_at, e.id`;

interface ListRowDb {
  id: string; partner_id: string; price_id: string | null; partner_name: string; partner_slug: string | null;
  d_price_rub: number | null; d_price_note: string | null; d_conditions: string | null; d_is_active: boolean | null;
  d_vehicle_kind: string | null; d_line_kind: string | null; d_from_text: string | null; d_to_text: string | null;
  d_valid_year: number | null;
  l_id: string | null; l_vehicle_kind: CharterVehicleKind | null; l_line_kind: CharterLineKind | null;
  l_from_text: string | null; l_to_text: string | null; l_price_rub: number | null; l_price_note: string | null;
  l_conditions: string | null; l_valid_year: number | null; l_is_active: boolean | null;
  created_at: string;
}

function draftOf(r: ListRowDb): SeenPriceDraft {
  return {
    priceRub: r.d_price_rub, priceNote: r.d_price_note, conditions: r.d_conditions, isActive: r.d_is_active,
    vehicleKind: r.d_vehicle_kind, lineKind: r.d_line_kind, fromText: r.d_from_text, toText: r.d_to_text,
    validYear: r.d_valid_year,
  };
}

export async function listPendingPriceEdits(): Promise<{ outcome: 'ok'; edits: PendingPriceEdit[] } | { outcome: 'db_error' }> {
  try {
    const { rows } = await pool.query<ListRowDb>(LIST_SQL);
    return {
      outcome: 'ok',
      edits: rows.map((r) => ({
        id: r.id,
        partnerId: r.partner_id,
        partnerName: r.partner_name,
        partnerSlug: r.partner_slug,
        priceId: r.price_id,
        live: r.l_id && r.l_vehicle_kind && r.l_line_kind && r.l_price_rub !== null
          ? toRow({
            id: r.l_id, vehicle_kind: r.l_vehicle_kind, line_kind: r.l_line_kind, from_text: r.l_from_text, to_text: r.l_to_text,
            price_rub: r.l_price_rub, price_note: r.l_price_note, conditions: r.l_conditions, valid_year: r.l_valid_year,
            is_active: r.l_is_active === true,
          })
          : null,
        draft: draftOf(r),
        createdAt: r.created_at,
      })),
    };
  } catch (err) {
    console.error('[charter-price-edit] очередь не прочитана, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

// ── Решение администратора ──────────────────────────────────────────────────

export type DecidePriceEdit =
  | { outcome: 'approved'; partnerId: string; label: string }
  | { outcome: 'rejected'; partnerId: string; label: string }
  | { outcome: 'already' }
  | { outcome: 'changed' }
  | { outcome: 'duplicate'; label: string }
  | { outcome: 'not_found' }
  | { outcome: 'db_error' };

const LOCK_SQL = `SELECT e.id::text AS id, e.partner_id::text AS partner_id, e.price_id::text AS price_id, e.moderation_status,
          e.price_rub AS d_price_rub, e.price_note AS d_price_note, e.conditions AS d_conditions, e.is_active AS d_is_active,
          e.vehicle_kind AS d_vehicle_kind, e.line_kind AS d_line_kind, e.from_text AS d_from_text, e.to_text AS d_to_text,
          e.valid_year AS d_valid_year,
          c.id::text AS l_id, c.vehicle_kind AS l_vehicle_kind, c.line_kind AS l_line_kind, c.from_text AS l_from_text,
          c.to_text AS l_to_text, c.price_rub AS l_price_rub, c.price_note AS l_price_note, c.conditions AS l_conditions,
          c.valid_year AS l_valid_year, c.is_active AS l_is_active
     FROM transfer_charter_price_edits e
     LEFT JOIN transfer_charter_prices c ON c.id = e.price_id AND c.partner_id = e.partner_id
    WHERE e.id = $1::uuid
    FOR UPDATE OF e`;

const APPLY_EDIT_SQL = `UPDATE transfer_charter_prices
      SET price_rub = COALESCE($2::int, price_rub),
          price_note = COALESCE($3::varchar, price_note),
          conditions = COALESCE($4::text, conditions),
          is_active = COALESCE($5::boolean, is_active),
          updated_at = NOW()
    WHERE id = $1::uuid AND partner_id = $6::uuid
    RETURNING id`;

const APPLY_NEW_SQL = `INSERT INTO transfer_charter_prices
    (partner_id, vehicle_kind, line_kind, from_text, to_text, price_rub, price_note, conditions, valid_year, sort_order)
  VALUES ($1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::int, $7::varchar, $8::text, $9::int,
          (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM transfer_charter_prices WHERE partner_id = $1::uuid))
  RETURNING id`;

const DECIDE_SQL = `UPDATE transfer_charter_price_edits
      SET moderation_status = $2::varchar,
          moderation_reason = $3::text,
          moderated_at = NOW(),
          moderated_by = $4::uuid,
          updated_at = NOW()
    WHERE id = $1::uuid AND moderation_status = 'pending'
    RETURNING id`;

type LockRow = Omit<ListRowDb, 'partner_name' | 'partner_slug' | 'created_at'> & { moderation_status: string };

function lockedLabel(row: LockRow): string {
  if (row.l_id && row.l_vehicle_kind && row.l_line_kind) {
    return priceRowLabel({ lineKind: row.l_line_kind, fromText: row.l_from_text, toText: row.l_to_text, vehicleKind: row.l_vehicle_kind });
  }
  return priceRowLabel({
    lineKind: (row.d_line_kind ?? 'destination') as CharterLineKind,
    fromText: row.d_from_text,
    toText: row.d_to_text,
    vehicleKind: (row.d_vehicle_kind ?? 'other') as CharterVehicleKind,
  });
}

export async function decidePriceEdit(opts: {
  id: string;
  action: 'approve' | 'reject';
  reason: string | null;
  moderatedBy: string | null;
  /** Что было в карточке. Одобрение без него или при расхождении не применяется. */
  seen: SeenPriceDraft | null;
}): Promise<DecidePriceEdit> {
  const next = opts.action === 'approve' ? 'approved' : 'rejected';
  if (opts.action === 'approve' && !draftMayApply(next)) return { outcome: 'db_error' };

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[charter-price-edit] соединение не взято, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
  try {
    await client.query('BEGIN');
    const locked = await client.query<LockRow>(LOCK_SQL, [opts.id]);
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }
    if (row.moderation_status !== 'pending') {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    const label = lockedLabel(row);
    if (opts.action === 'approve') {
      if (opts.seen === null || !seenMatches(draftOf({ ...row, partner_name: '', partner_slug: null, created_at: '' }), opts.seen)) {
        await client.query('ROLLBACK');
        return { outcome: 'changed' };
      }
      if (row.price_id !== null) {
        // Живая строка пропала (удалена миграцией) — применять не к чему.
        if (row.l_id === null) {
          await client.query('ROLLBACK');
          console.error('[charter-price-edit] строка прайса черновика не найдена', row.price_id);
          return { outcome: 'not_found' };
        }
        const applied = await client.query(APPLY_EDIT_SQL, [
          row.price_id, row.d_price_rub, row.d_price_note, row.d_conditions, row.d_is_active, row.partner_id,
        ]);
        if (applied.rows.length !== 1) {
          await client.query('ROLLBACK');
          console.error('[charter-price-edit] живая строка не обновлена', row.price_id);
          return { outcome: 'db_error' };
        }
      } else {
        try {
          const inserted = await client.query(APPLY_NEW_SQL, [
            row.partner_id, row.d_vehicle_kind, row.d_line_kind, row.d_from_text, row.d_to_text,
            row.d_price_rub, row.d_price_note, row.d_conditions, row.d_valid_year,
          ]);
          if (inserted.rows.length !== 1) {
            await client.query('ROLLBACK');
            console.error('[charter-price-edit] новая строка не вставлена', row.id);
            return { outcome: 'db_error' };
          }
        } catch (err) {
          await client.query('ROLLBACK');
          // Такое направление (или тариф) на этот вид машины в прайсе уже есть — судит индекс.
          if (sqlState(err) === '23505') return { outcome: 'duplicate', label };
          throw err;
        }
      }
    }
    const decided = await client.query(DECIDE_SQL, [opts.id, next, opts.reason, opts.moderatedBy]);
    if (decided.rows.length !== 1) {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    await client.query('COMMIT');
    return opts.action === 'approve'
      ? { outcome: 'approved', partnerId: row.partner_id, label }
      : { outcome: 'rejected', partnerId: row.partner_id, label };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[charter-price-edit] откат не прошёл, SQLSTATE', sqlState(rollbackErr));
    }
    console.error('[charter-price-edit] решение не записано, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  } finally {
    client.release();
  }
}
