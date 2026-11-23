/**
 * Модерация правок тура: база (план готовности 23.11, этап 4).
 *
 * Правило и слова — lib/tours/moderation.ts. Здесь черновик
 * (`operator_tour_edits`, миграция 1507) кладётся, читается и решается.
 *
 * Одобрение применяет правку к живой строке ТОЙ ЖЕ функцией, которой тур
 * пишется всегда (lib/tours/tour-write): тип колонки, главное фото и сброс
 * чисел условий отмены не расходятся с обычной записью.
 *
 * Гонка «одобрение против новой правки» закрыта сверкой: администратор
 * одобряет то, что видел. Список отдаёт отпечаток содержания (`seen`),
 * решение его возвращает; оператор успел дописать — отпечаток другой, исход
 * `changed`, ничего не применено.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { draftMayApply } from '@/lib/moderation/gate';
import { writeTourPatch, type TourPatchInput } from '@/lib/tours/tour-write';
import {
  MODERATED_TOUR_COLUMNS, TOUR_FIELD_LABELS, TOUR_PHOTO_FIELDS,
  canonicalJson, contentDiff, effectiveContent, isModeratedTourColumn, tourEditChanges, tourValueText,
  type ModeratedTourColumn, type TourContentPatch, type TourEditChange,
} from '@/lib/tours/moderation';

type Db = Pick<PoolClient, 'query'>;

function sqlState(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет';
}

/** Колонки содержания живой строки — для сравнения и диффа. */
export const LIVE_CONTENT_COLUMNS = MODERATED_TOUR_COLUMNS.map((c) => `ot.${c}`).join(', ');

/** Только поля содержания: чужой ключ в черновике к живой строке не дойдёт. */
function cleanPatch(raw: unknown): TourContentPatch {
  const out: TourContentPatch = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isModeratedTourColumn(key)) out[key] = value;
  }
  return out;
}

function fieldsOf(patch: TourContentPatch): ModeratedTourColumn[] {
  return MODERATED_TOUR_COLUMNS.filter((f) => f in patch);
}

/** Отпечаток того, что станет витриной после одобрения. */
export function seenToken(live: Record<string, unknown>, patch: TourContentPatch, wantsPublish: boolean): string {
  const body = canonicalJson({ content: effectiveContent(live, patch), publish: wantsPublish });
  return createHash('sha256').update(body).digest('hex');
}

// ─── Положить черновик ────────────────────────────────────────────────────────

export type StagedTourEdit =
  | { outcome: 'pending'; editId: string; fields: ModeratedTourColumn[]; wantsPublish: boolean }
  /** Проверять нечего: правка совпала с витриной, публикации не просят. */
  | { outcome: 'none' };

const PENDING_SQL = `SELECT id::text AS id, patch, wants_publish
     FROM operator_tour_edits
    WHERE tour_id = $1::bigint AND moderation_status = 'pending'
    FOR UPDATE`;

const UPSERT_SQL = `INSERT INTO operator_tour_edits (tour_id, partner_id, created_by, patch, wants_publish)
  VALUES ($1::bigint, $2::uuid, $3::uuid, $4::jsonb, $5::boolean)
  ON CONFLICT (tour_id) WHERE moderation_status = 'pending'
  DO UPDATE SET patch = EXCLUDED.patch, wants_publish = EXCLUDED.wants_publish, updated_at = NOW()
  RETURNING id::text AS id`;

interface PendingRow {
  id: string;
  patch: unknown;
  wants_publish: boolean;
}

/** Есть ли у тура правка на проверке. Строка черновика блокируется до конца транзакции. */
export async function lockPendingTourEdit(client: Db, tourId: bigint | string): Promise<PendingRow | null> {
  const { rows } = await client.query<PendingRow>(PENDING_SQL, [String(tourId)]);
  return rows[0] ?? null;
}

/**
 * Кладёт содержание в черновик. Вторая правка дополняет первую: итог —
 * «витрина плюс всё, что владелец поменял», сверенный с живой строкой.
 * Вернул поле к значению витрины — оно из черновика уходит; ушло всё и
 * публикации не просят — черновик удаляется.
 *
 * Транзакцию даёт вызывающий.
 */
export async function stageTourEdit(
  client: Db,
  opts: {
    tourId: bigint | string;
    partnerId: string;
    userId: string | null;
    /** Живая строка тура (колонки содержания и is_published). */
    live: Record<string, unknown>;
    content: TourContentPatch;
    wantsPublish: boolean;
    /** Черновик, уже взятый под замок вызывающим. */
    pending?: PendingRow | null;
  },
): Promise<StagedTourEdit> {
  const pending = opts.pending !== undefined ? opts.pending : await lockPendingTourEdit(client, opts.tourId);
  const desired: TourContentPatch = { ...cleanPatch(pending?.patch), ...opts.content };
  const patch = contentDiff(opts.live, desired);
  const published = opts.live.is_published === true;
  // Опубликованному туру публикацию просить не нужно.
  const wantsPublish = !published && (pending?.wants_publish === true || opts.wantsPublish);

  if (Object.keys(patch).length === 0 && !wantsPublish) {
    if (pending) await client.query(`DELETE FROM operator_tour_edits WHERE id = $1::uuid`, [pending.id]);
    return { outcome: 'none' };
  }
  const { rows } = await client.query<{ id: string }>(UPSERT_SQL, [
    String(opts.tourId), opts.partnerId, opts.userId, JSON.stringify(patch), wantsPublish,
  ]);
  return { outcome: 'pending', editId: rows[0].id, fields: fieldsOf(patch), wantsPublish };
}

/** Владелец отзывает правку: черновик удаляется, витрина прежняя. */
export async function withdrawTourEdit(tourId: bigint | string, partnerId: string): Promise<'withdrawn' | 'none' | 'db_error'> {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM operator_tour_edits
        WHERE tour_id = $1::bigint AND partner_id = $2::uuid AND moderation_status = 'pending'`,
      [String(tourId), partnerId],
    );
    return (rowCount ?? 0) > 0 ? 'withdrawn' : 'none';
  } catch (err) {
    console.error('[tour-edit] правка не отозвана, SQLSTATE', sqlState(err));
    return 'db_error';
  }
}

// ─── Что видит владелец ───────────────────────────────────────────────────────

export interface OwnTourEdit {
  /** Правка на проверке. */
  pending: { patch: TourContentPatch; wantsPublish: boolean; changes: TourEditChange[]; since: string } | null;
  /** Последняя правка возвращена, и новой после неё нет. */
  rejected: { reason: string | null; fields: ModeratedTourColumn[]; wantsPublish: boolean; at: string | null } | null;
}

interface OwnEditRow {
  tour_id: string;
  patch: unknown;
  wants_publish: boolean;
  moderation_status: string;
  moderation_reason: string | null;
  moderated_at: Date | string | null;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * Последняя правка каждого тура. Одобренная правка владельцу уже не нужна —
 * она на витрине; тогда у тура нет ни `pending`, ни `rejected`.
 *
 * `live` — живые строки по id тура: по ним строится дифф «было / стало».
 * `null` — прочитать не удалось: «не знаю», а не «правок нет» (§4.0).
 */
export async function loadOwnTourEdits(
  tourIds: readonly string[],
  live: ReadonlyMap<string, Record<string, unknown>>,
  db: Db = pool,
): Promise<Map<string, OwnTourEdit> | null> {
  const out = new Map<string, OwnTourEdit>();
  if (tourIds.length === 0) return out;
  try {
    const { rows } = await db.query<OwnEditRow>(
      `SELECT DISTINCT ON (e.tour_id)
              e.tour_id::text AS tour_id, e.patch, e.wants_publish, e.moderation_status,
              e.moderation_reason, e.moderated_at, e.updated_at
         FROM operator_tour_edits e
        WHERE e.tour_id = ANY($1::bigint[])
        ORDER BY e.tour_id, e.created_at DESC`,
      [tourIds.map(String)],
    );
    for (const row of rows) {
      const patch = cleanPatch(row.patch);
      if (row.moderation_status === 'pending') {
        out.set(row.tour_id, {
          pending: {
            patch,
            wantsPublish: row.wants_publish === true,
            changes: tourEditChanges(live.get(row.tour_id) ?? {}, patch),
            since: iso(row.updated_at) ?? '',
          },
          rejected: null,
        });
      } else if (row.moderation_status === 'rejected') {
        out.set(row.tour_id, {
          pending: null,
          rejected: {
            reason: row.moderation_reason,
            fields: fieldsOf(patch),
            wantsPublish: row.wants_publish === true,
            at: iso(row.moderated_at),
          },
        });
      }
    }
    return out;
  } catch (err) {
    console.error('[tour-edit] правки владельца не прочитаны, SQLSTATE', sqlState(err));
    return null;
  }
}

/** Сколько правок партнёра ждёт проверки — для чек-листа готовности. */
export async function countPendingTourEdits(partnerId: string, db: Db = pool): Promise<number | null> {
  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM operator_tour_edits
        WHERE partner_id = $1::uuid AND moderation_status = 'pending'`,
      [partnerId],
    );
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    console.error('[tour-edit] счёт правок на проверке не прочитан, SQLSTATE', sqlState(err));
    return null;
  }
}

// ─── Очередь администратора ───────────────────────────────────────────────────

export interface TourContentLine {
  field: ModeratedTourColumn;
  label: string;
  text: string;
  photos?: string[];
}

export interface PendingTourEdit {
  id: string;
  tourId: string;
  tourTitle: string;
  partnerId: string;
  partnerName: string;
  partnerCategory: string | null;
  /** Новый тур просится на витрину либо правка уже опубликованного. */
  kind: 'publish' | 'edit';
  /** Что меняется против витрины. */
  changes: TourEditChange[];
  /** Всё содержание, каким оно станет: новому туру диффа мало. */
  content: TourContentLine[];
  /** Отпечаток содержания: решение возвращает его обратно. */
  seen: string;
  since: string;
}

type LiveRow = Record<string, unknown> & { title: string; is_published: boolean | null };

interface PendingListRow extends LiveRow {
  e_id: string;
  e_tour_id: string;
  e_partner_id: string;
  e_patch: unknown;
  e_wants_publish: boolean;
  e_updated_at: Date | string;
  partner_name: string;
  partner_category: string | null;
}

function photosOf(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : [];
}

function contentLines(content: Record<ModeratedTourColumn, unknown>): TourContentLine[] {
  return MODERATED_TOUR_COLUMNS.map((field) => ({
    field,
    label: TOUR_FIELD_LABELS[field],
    text: tourValueText(field, content[field]),
    ...(TOUR_PHOTO_FIELDS.includes(field) ? { photos: photosOf(content[field]) } : {}),
  }));
}

export async function listPendingTourEdits(): Promise<{ outcome: 'ok'; edits: PendingTourEdit[] } | { outcome: 'db_error' }> {
  try {
    const { rows } = await pool.query<PendingListRow>(
      `SELECT e.id::text AS e_id, e.tour_id::text AS e_tour_id, e.partner_id::text AS e_partner_id,
              e.patch AS e_patch, e.wants_publish AS e_wants_publish, e.updated_at AS e_updated_at,
              p.name AS partner_name, p.category AS partner_category,
              ot.is_published, ${LIVE_CONTENT_COLUMNS}
         FROM operator_tour_edits e
         JOIN operator_tours ot ON ot.id = e.tour_id AND ot.deleted_at IS NULL
         JOIN partners p ON p.id = e.partner_id
        WHERE e.moderation_status = 'pending'
        ORDER BY e.created_at ASC
        LIMIT 200`,
    );
    const edits = rows.map((row): PendingTourEdit => {
      const patch = cleanPatch(row.e_patch);
      const wantsPublish = row.e_wants_publish === true && row.is_published !== true;
      const content = effectiveContent(row, patch);
      return {
        id: row.e_id,
        tourId: row.e_tour_id,
        tourTitle: String(content.title ?? row.title ?? ''),
        partnerId: row.e_partner_id,
        partnerName: row.partner_name,
        partnerCategory: row.partner_category,
        kind: wantsPublish ? 'publish' : 'edit',
        changes: tourEditChanges(row, patch),
        content: contentLines(content),
        seen: seenToken(row, patch, wantsPublish),
        since: iso(row.e_updated_at) ?? '',
      };
    });
    return { outcome: 'ok', edits };
  } catch (err) {
    console.error('[tour-edit] очередь правок не прочитана, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

// ─── Решение ──────────────────────────────────────────────────────────────────

export type DecideTourEdit =
  | {
      outcome: 'approved' | 'rejected';
      partnerId: string;
      tourId: string;
      title: string;
      fields: ModeratedTourColumn[];
      /** Одобрение поставило тур на витрину впервые. */
      published: boolean;
    }
  | { outcome: 'already' }
  | { outcome: 'changed' }
  | { outcome: 'not_found' }
  | { outcome: 'db_error' };

interface LockedEdit {
  id: string;
  tour_id: string;
  partner_id: string;
  patch: unknown;
  wants_publish: boolean;
  moderation_status: string;
}

const LOCK_EDIT_SQL = `SELECT id::text AS id, tour_id::text AS tour_id, partner_id::text AS partner_id,
          patch, wants_publish, moderation_status
     FROM operator_tour_edits
    WHERE id = $1::uuid
    FOR UPDATE`;

const LOCK_TOUR_SQL = `SELECT ot.title, ot.is_published, ot.main_place_id, ${LIVE_CONTENT_COLUMNS}
     FROM operator_tours ot
    WHERE ot.id = $1::bigint AND ot.deleted_at IS NULL
    FOR UPDATE`;

const DECIDE_SQL = `UPDATE operator_tour_edits
      SET moderation_status = $2::varchar,
          moderation_reason = $3::text,
          moderated_at = NOW(),
          moderated_by = $4::uuid,
          live_before = $5::jsonb,
          updated_at = NOW()
    WHERE id = $1::uuid AND moderation_status = 'pending'
    RETURNING id`;

/**
 * Решение по правке. Одобрение — одно действие: правка применяется к живой
 * строке и черновик закрывается в одной транзакции. Отказ живую строку не
 * трогает.
 */
export async function decideTourEdit(opts: {
  id: string;
  action: 'approve' | 'reject';
  reason: string | null;
  moderatedBy: string | null;
  /** Отпечаток из списка. Одобрение без него или при расхождении не применяется. */
  seen: string | null;
}): Promise<DecideTourEdit> {
  const next = opts.action === 'approve' ? 'approved' : 'rejected';
  if (opts.action === 'approve' && !draftMayApply(next)) return { outcome: 'db_error' };

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[tour-edit] соединение не взято, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
  try {
    await client.query('BEGIN');
    const edit = (await client.query<LockedEdit>(LOCK_EDIT_SQL, [opts.id])).rows[0];
    if (!edit) {
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }
    if (edit.moderation_status !== 'pending') {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    const live = (await client.query<LiveRow>(LOCK_TOUR_SQL, [edit.tour_id])).rows[0];
    if (!live) {
      // Тур удалён, пока правка ждала: применять не к чему.
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }
    const patch = cleanPatch(edit.patch);
    const fields = fieldsOf(patch);
    const wantsPublish = edit.wants_publish === true && live.is_published !== true;
    const title = String((patch.title as string | undefined) ?? live.title ?? '');
    const base = { partnerId: edit.partner_id, tourId: edit.tour_id, fields };

    if (opts.action === 'reject') {
      const done = await client.query(DECIDE_SQL, [edit.id, 'rejected', opts.reason, opts.moderatedBy, null]);
      if (done.rows.length !== 1) {
        await client.query('ROLLBACK');
        return { outcome: 'already' };
      }
      await client.query('COMMIT');
      return { outcome: 'rejected', ...base, title: String(live.title ?? ''), published: false };
    }

    if (opts.seen === null || opts.seen !== seenToken(live, patch, wantsPublish)) {
      await client.query('ROLLBACK');
      return { outcome: 'changed' };
    }
    const input = { ...patch, ...(wantsPublish ? { is_published: true } : {}) } as TourPatchInput;
    if (Object.keys(input).length > 0) {
      const applied = await writeTourPatch(client, { tourId: edit.tour_id, ownerId: null, input, current: live });
      if (applied.outcome !== 'written') {
        await client.query('ROLLBACK');
        console.error('[tour-edit] живая строка тура не обновлена, исход', applied.outcome);
        return { outcome: 'db_error' };
      }
    }
    const liveBefore: Record<string, unknown> = {};
    for (const f of fields) liveBefore[f] = live[f] ?? null;
    const done = await client.query(DECIDE_SQL, [edit.id, 'approved', null, opts.moderatedBy, JSON.stringify(liveBefore)]);
    if (done.rows.length !== 1) {
      await client.query('ROLLBACK');
      return { outcome: 'already' };
    }
    await client.query('COMMIT');
    return { outcome: 'approved', ...base, title, published: wantsPublish };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[tour-edit] решение по правке не записано, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  } finally {
    client.release();
  }
}
