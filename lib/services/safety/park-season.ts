/**
 * Какие живые закрытия парков — межсезонные (слово владельца 19.11 «go», #3487).
 *
 * Пересчёт статуса мест (safety-ingest, updateRealTimeStatus) красит место
 * красным по своему закрытию парка. Межсезонное закрытие закрывает тропы
 * парка до сезона, а не называет опасность дня: такое место становится
 * жёлтым с причиной `park_season`, и карточка говорит «Тропы парка закрыты на
 * межсезонье», а не «Сегодня там опасно».
 *
 * Признак не хранится в строке тревоги: он считается правилом из текста
 * (`isSeasonalClosure`) на каждом пересчёте, как срок у park-closure-hold.
 * Хранимый признак разошёлся бы с правилом при его следующей правке.
 *
 * Отказ — пустой список, то есть все закрытия красные, как до 19.11: ошибка
 * в эту сторону ничего не прячет. Отказ пишется в лог.
 */

import { isBareParkClosure, isSeasonalClosure } from '@/lib/safety/park-closure';
import { DESCRIPTION_CLIP, TITLE_CLIP } from '@/lib/services/safety/park-closure-hold';
import type { QueryFn } from '@/lib/services/safety/alert-prune';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';

/** Причина жёлтого статуса места, которую пишет пересчёт (миграция 1461). */
export const PARK_SEASON_REASON = 'park_season';

interface Row { id: string; title: string | null; description: string | null; affected_parks: string[] | null }

/** Текст обрезан при записи: слово опасности могло остаться за обрезом. */
function isClipped(row: Pick<Row, 'title' | 'description'>): boolean {
  return (row.title ?? '').length >= TITLE_CLIP || (row.description ?? '').length >= DESCRIPTION_CLIP;
}

/** Межсезонное ли это закрытие по сохранённому тексту строки. */
export function isSeasonalClosureRow(row: Pick<Row, 'title' | 'description'>): boolean {
  if (isClipped(row)) return false;
  return isSeasonalClosure(`${row.title ?? ''} ${row.description ?? ''}`);
}

/**
 * Какие из живых закрытий парков межсезонные.
 *
 * Первое — межсезонное по своему тексту (`isSeasonalClosureRow`). Второе
 * (слово владельца 19.11 «Да, вариант 2»): закрытие, не сказавшее ничего,
 * кроме самого закрытия (`isBareParkClosure`, строка сводки Минтура
 * «„Налычево“ и „Южно-Камчатский“, „Быстринский“ — маршруты закрыты»), —
 * межсезонное, если КАЖДЫЙ названный в нём парк закрыт межсезонным закрытием
 * по тексту в этом же наборе. Один парк без такого покрытия — строка остаётся
 * красной целиком: про него межсезонья никто не говорил. Парки не названы —
 * тоже красная: покрывать нечего. Одно голое закрытие другое не покрывает.
 */
export function seasonalClosureIdsOf(rows: readonly Row[]): string[] {
  const seasonal = rows.filter(isSeasonalClosureRow);
  const seasonParks = new Set(seasonal.flatMap((r) => r.affected_parks ?? []));
  const seasonalIds = new Set(seasonal.map((r) => r.id));
  const bare = rows.filter((r) =>
    !seasonalIds.has(r.id)
    && !isClipped(r)
    && (r.affected_parks?.length ?? 0) > 0
    && (r.affected_parks ?? []).every((p) => seasonParks.has(p))
    && isBareParkClosure(`${r.title ?? ''} ${r.description ?? ''}`));
  return [...seasonal, ...bare].map((r) => r.id);
}

export async function seasonalParkClosureIds(query: QueryFn): Promise<string[]> {
  try {
    const res = await query<Row>(
      `SELECT id::text AS id, title, description, affected_parks
         FROM external_alerts
        WHERE alert_type = 'park_closure'
          AND expires_at > ${UTC_WALL_NOW_SQL}`,
      [],
    );
    return seasonalClosureIdsOf(res.rows);
  } catch (e) {
    const code = (e as { code?: string }).code ?? null;
    console.error('[safety-ingest] межсезонные закрытия парков не прочитались — все закрытия считаются красными:', code ?? (e as Error).message);
    return [];
  }
}
