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
  MODERATED_TOUR_COLUMNS, TOUR_DATE_COLUMNS, contentDiff,
  type ModeratedTourColumn, type TourContentPatch,
} from '@/lib/tours/moderation';
import { cleanPatch, fieldsOf } from '@/lib/tours/moderation-read';
import { automatonIncoming, cleanProposedBy, nextProposedBy, type TourAutomaton } from '@/lib/tours/automaton';

export { countPendingTourEdits, loadOwnTourEdits, type OwnTourEdit } from '@/lib/tours/moderation-read';
export type { PendingTourEdit, TourContentLine } from '@/lib/tours/moderation';

type Db = Pick<PoolClient, 'query'>;

function sqlState(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет';
}

/**
 * Колонки содержания живой строки — для сравнения и диффа.
 *
 * Дата читается текстом «ГГГГ-ММ-ДД»: драйвер отдал бы её объектом времени,
 * а черновик и форма несут строку — отпечаток карточки и запись «что было»
 * разошлись бы с тем, что видел администратор.
 */
export const LIVE_CONTENT_COLUMNS = MODERATED_TOUR_COLUMNS
  .map((c) => (TOUR_DATE_COLUMNS.includes(c) ? `ot.${c}::text AS ${c}` : `ot.${c}`))
  .join(', ');

// ─── Положить черновик ────────────────────────────────────────────────────────

export type StagedTourEdit =
  | {
      outcome: 'pending'; editId: string; fields: ModeratedTourColumn[]; wantsPublish: boolean;
      /** Поля автомата, которые не легли: владелец уже отправил их на проверку. */
      keptOwner: ModeratedTourColumn[];
    }
  /** Проверять нечего: правка совпала с витриной, публикации не просят. */
  | { outcome: 'none' }
  /**
   * Автомат не положил ничего: все его поля владелец уже отправил на
   * проверку. Черновик не тронут.
   */
  | { outcome: 'kept'; keptOwner: ModeratedTourColumn[] };

const PENDING_SQL = `SELECT id::text AS id, patch, wants_publish, proposed_by
     FROM operator_tour_edits
    WHERE tour_id = $1::bigint AND moderation_status = 'pending'
    FOR UPDATE`;

const UPSERT_SQL = `INSERT INTO operator_tour_edits (tour_id, partner_id, created_by, patch, wants_publish, proposed_by)
  VALUES ($1::bigint, $2::uuid, $3::uuid, $4::jsonb, $5::boolean, $6::jsonb)
  ON CONFLICT (tour_id) WHERE moderation_status = 'pending'
  DO UPDATE SET patch = EXCLUDED.patch, wants_publish = EXCLUDED.wants_publish,
                proposed_by = EXCLUDED.proposed_by, updated_at = NOW()
  RETURNING id::text AS id`;

export interface PendingRow {
  id: string;
  patch: unknown;
  wants_publish: boolean;
  /** Кто предложил поля (1511): {колонка: имя автомата}. */
  proposed_by?: unknown;
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
    /** Правку предлагает автомат платформы (lib/tours/automaton); нет — владелец. */
    source?: TourAutomaton | null;
  },
): Promise<StagedTourEdit> {
  const pending = opts.pending !== undefined ? opts.pending : await lockPendingTourEdit(client, opts.tourId);
  const source = opts.source ?? null;
  const pendingPatch = cleanPatch(pending?.patch);
  const marksBefore = cleanProposedBy(pending?.proposed_by);
  // Автомат не перебивает то, что владелец уже отправил на проверку.
  const { incoming, keptOwner } = source === null
    ? { incoming: opts.content, keptOwner: [] as ModeratedTourColumn[] }
    : automatonIncoming(opts.content, pendingPatch, marksBefore);
  if (source !== null && keptOwner.length > 0 && Object.keys(incoming).length === 0) {
    return { outcome: 'kept', keptOwner };
  }
  const desired: TourContentPatch = { ...pendingPatch, ...incoming };
  const patch = contentDiff(opts.live, desired);
  const published = opts.live.is_published === true;
  // Опубликованному туру публикацию просить не нужно.
  const wantsPublish = !published && (pending?.wants_publish === true || opts.wantsPublish);

  if (Object.keys(patch).length === 0 && !wantsPublish) {
    if (pending) await client.query(`DELETE FROM operator_tour_edits WHERE id = $1::uuid`, [pending.id]);
    return { outcome: 'none' };
  }
  const marks = nextProposedBy({ patch, pendingPatch, marksBefore, incoming, source });
  const { rows } = await client.query<{ id: string }>(UPSERT_SQL, [
    String(opts.tourId), opts.partnerId, opts.userId, JSON.stringify(patch), wantsPublish, JSON.stringify(marks),
  ]);
  return { outcome: 'pending', editId: rows[0].id, fields: fieldsOf(patch), wantsPublish, keptOwner };
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
