/**
 * Модерация правок тура: черновик (план готовности 23.11, этап 4).
 *
 * Правило и слова — lib/tours/moderation.ts. Здесь черновик
 * (`operator_tour_edits`, миграция 1507) кладётся и отзывается. Очередь
 * администратора и решение — lib/tours/moderation-review.ts, чтение правок
 * владельца — lib/tours/moderation-read.ts.
 *
 * Три файла вместо одного намеренно: решение считает отпечаток через
 * `node:crypto`, а этот файл подключает единая дверь владельца, до которой
 * дотягивается клиентский код (типы кабинета гида). Сторож
 * `client-no-node-builtins` такую цепочку не пропускает.
 */
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import {
  MODERATED_TOUR_COLUMNS, contentDiff,
  type ModeratedTourColumn, type TourContentPatch,
} from '@/lib/tours/moderation';
import { cleanPatch, fieldsOf } from '@/lib/tours/moderation-read';

export { countPendingTourEdits, loadOwnTourEdits, type OwnTourEdit } from '@/lib/tours/moderation-read';
export type { PendingTourEdit, TourContentLine } from '@/lib/tours/moderation';

type Db = Pick<PoolClient, 'query'>;

function sqlState(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет';
}

/** Колонки содержания живой строки — для сравнения и диффа. */
export const LIVE_CONTENT_COLUMNS = MODERATED_TOUR_COLUMNS.map((c) => `ot.${c}`).join(', ');

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
