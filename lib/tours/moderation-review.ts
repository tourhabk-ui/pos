/**
 * Модерация правок тура: очередь администратора и решение (план готовности
 * 23.11, этап 4).
 *
 * Одобрение применяет правку к живой строке ТОЙ ЖЕ функцией, которой тур
 * пишется всегда (lib/tours/tour-write): тип колонки, главное фото и сброс
 * чисел условий отмены не расходятся с обычной записью.
 *
 * Гонка «одобрение против новой правки» закрыта сверкой: администратор
 * одобряет то, что видел. Список отдаёт отпечаток содержания (`seen`),
 * решение его возвращает; владелец успел дописать — отпечаток другой, исход
 * `changed`, ничего не применено.
 *
 * Подключают только двери администратора: здесь `node:crypto`.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { draftMayApply } from '@/lib/moderation/gate';
import { writeTourPatch, type TourPatchInput } from '@/lib/tours/tour-write';
import {
  MODERATED_TOUR_COLUMNS, TOUR_FIELD_LABELS, TOUR_PHOTO_FIELDS,
  canonicalJson, effectiveContent, tourEditChanges, tourValueText,
  type ModeratedTourColumn, type PendingTourEdit, type TourContentLine, type TourContentPatch,
} from '@/lib/tours/moderation';
import { cleanPatch, fieldsOf, isoTime as iso } from '@/lib/tours/moderation-read';
import { photoAddressesOf, rejectedPhotoAddresses } from '@/lib/tours/photo-address';
import { LIVE_CONTENT_COLUMNS } from '@/lib/tours/moderation-store';

function sqlState(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет';
}

/** Отпечаток того, что станет витриной после одобрения. */
export function seenToken(live: Record<string, unknown>, patch: TourContentPatch, wantsPublish: boolean): string {
  const body = canonicalJson({ content: effectiveContent(live, patch), publish: wantsPublish });
  return createHash('sha256').update(body).digest('hex');
}

// ─── Очередь администратора ───────────────────────────────────────────────────

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
      /** Правка просила первую публикацию (у отказа — «тур не опубликован»). */
      askedPublish: boolean;
      /** Категория карточки владельца — в какой кабинет вести из сообщения. */
      partnerCategory: string | null;
    }
  | { outcome: 'already' }
  | { outcome: 'changed' }
  /** В правке новый адрес снимка, который не снимок: одобрить нельзя, только вернуть. */
  | { outcome: 'bad_photo' }
  | { outcome: 'not_found' }
  | { outcome: 'db_error' };

interface LockedEdit {
  id: string;
  tour_id: string;
  partner_id: string;
  patch: unknown;
  wants_publish: boolean;
  moderation_status: string;
  partner_category: string | null;
}

const LOCK_EDIT_SQL = `SELECT e.id::text AS id, e.tour_id::text AS tour_id, e.partner_id::text AS partner_id,
          e.patch, e.wants_publish, e.moderation_status,
          (SELECT p.category FROM partners p WHERE p.id = e.partner_id) AS partner_category
     FROM operator_tour_edits e
    WHERE e.id = $1::uuid
    FOR UPDATE OF e`;

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
    const base = {
      partnerId: edit.partner_id, tourId: edit.tour_id, fields,
      askedPublish: wantsPublish, partnerCategory: edit.partner_category,
    };

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
    // Одобрение не ставит на сайт «снимок», который снимком не является
    // (перепроверка 23.11): черновик мог лечь до правила двери. Адрес, уже
    // стоящий у тура, одобрение не судит — оно его не добавляет.
    if (rejectedPhotoAddresses(photoAddressesOf(patch), new Set(photoAddressesOf(live))).length > 0) {
      await client.query('ROLLBACK');
      return { outcome: 'bad_photo' };
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
