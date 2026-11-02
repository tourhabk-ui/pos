/**
 * Записанная обстановка на выезды (#2969) — только чтение, для «Сегодня»
 * оператора и напоминания за сутки. Отдельно от situation-store: экрану в
 * чате не нужны прогноз, лента предупреждений и оценка зон.
 */
import { pool } from '@/lib/db-pool';
import type { SituationKind } from '@/lib/trips/situation';

const sqlState = (err: unknown) => (err as { code?: string })?.code ?? 'нет SQLSTATE';

export interface StoredSituation { tourId: number; date: string; kind: SituationKind; line: string; checkedAt: string }

/** Записанная обстановка на выезды — для «Сегодня» и напоминания; 'failed' — не прочиталась. */
export async function readStoredSituations(tourIds: readonly number[], dates: readonly string[]): Promise<StoredSituation[] | 'failed'> {
  if (tourIds.length === 0 || dates.length === 0) return [];
  try {
    const { rows } = await pool.query<{ tour_id: number; d: string; kind: SituationKind; line: string; checked_at: string }>(
      `SELECT tour_id::int AS tour_id, trip_date::text AS d, kind, line, checked_at::text AS checked_at
         FROM trip_situations WHERE tour_id = ANY($1::bigint[]) AND trip_date = ANY($2::date[])`,
      [[...tourIds], [...dates]],
    );
    return rows.map((r) => ({ tourId: Number(r.tour_id), date: r.d.slice(0, 10), kind: r.kind, line: r.line, checkedAt: r.checked_at }));
  } catch (err) {
    console.error('[trip-situation] записанная обстановка не прочиталась, SQLSTATE', sqlState(err));
    return 'failed';
  }
}
