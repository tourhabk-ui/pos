/**
 * Модерация правок тура: чтение правок владельца (план готовности 23.11, этап 4).
 *
 * Отдельно от lib/tours/moderation-store намеренно: склад считает отпечаток
 * через `node:crypto`, а чтение подключают модули, до которых дотягивается
 * клиентский код (типы кабинета гида берутся из lib/guides/own-tours). Сторож
 * `client-no-node-builtins` ведёт цепочку импортов до `node:*` и такой путь
 * не пропускает.
 *
 * Только чтение: ни одной записи в `operator_tour_edits` здесь нет.
 */
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import {
  MODERATED_TOUR_COLUMNS, isModeratedTourColumn, mainPlaceIdsOf, tourEditChanges,
  type ModeratedTourColumn, type TourContentPatch, type TourEditChange,
} from '@/lib/tours/moderation';

type Db = Pick<PoolClient, 'query'>;

function sqlState(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет';
}

/** Только поля содержания: чужой ключ в черновике к живой строке не дойдёт. */
export function cleanPatch(raw: unknown): TourContentPatch {
  const out: TourContentPatch = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isModeratedTourColumn(key)) out[key] = value;
  }
  return out;
}

export function fieldsOf(patch: TourContentPatch): ModeratedTourColumn[] {
  return MODERATED_TOUR_COLUMNS.filter((f) => f in patch);
}

/**
 * Имена мест по адресам записей — чтобы дифф главного места говорил «Вулкан
 * Горелый», а не адрес записи. `null` — прочитать не удалось: дифф так и
 * скажет, а не выдаст место за ненайденное (§4.0). Места, которого в
 * справочнике нет, в ответе нет — это видно по отсутствию имени.
 */
export async function loadPlaceNames(ids: readonly string[], db: Db = pool): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const { rows } = await db.query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM places WHERE id::text = ANY($1::text[])`,
      [[...ids]],
    );
    for (const row of rows) out.set(row.id, row.name);
    return out;
  } catch (err) {
    console.error('[tour-edit] имена мест не прочитаны, SQLSTATE', sqlState(err));
    return null;
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

/** Время строкой ISO; null остаётся null. */
export const isoTime = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));
const iso = isoTime;

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
    // Имена мест нужны, только если какая-то правка на проверке меняет главное место.
    const placeEdits = rows
      .filter((row) => row.moderation_status === 'pending')
      .map((row) => ({ patch: cleanPatch(row.patch), live: live.get(row.tour_id) ?? {} }))
      .filter((e) => 'main_place_id' in e.patch);
    const placeNames = placeEdits.length > 0
      ? await loadPlaceNames(mainPlaceIdsOf(...placeEdits.flatMap((e) => [e.patch, e.live])), db)
      : undefined;
    for (const row of rows) {
      const patch = cleanPatch(row.patch);
      if (row.moderation_status === 'pending') {
        out.set(row.tour_id, {
          pending: {
            patch,
            wantsPublish: row.wants_publish === true,
            changes: tourEditChanges(live.get(row.tour_id) ?? {}, patch, { placeNames }),
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
