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

import { isSeasonalClosure } from '@/lib/safety/park-closure';
import { DESCRIPTION_CLIP, TITLE_CLIP } from '@/lib/services/safety/park-closure-hold';
import type { QueryFn } from '@/lib/services/safety/alert-prune';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';

/** Причина жёлтого статуса места, которую пишет пересчёт (миграция 1461). */
export const PARK_SEASON_REASON = 'park_season';

interface Row { id: string; title: string | null; description: string | null }

/** Межсезонное ли это закрытие по сохранённому тексту строки. */
export function isSeasonalClosureRow(row: Pick<Row, 'title' | 'description'>): boolean {
  // Текст обрезан при записи: слово опасности могло остаться за обрезом.
  if ((row.title ?? '').length >= TITLE_CLIP || (row.description ?? '').length >= DESCRIPTION_CLIP) return false;
  return isSeasonalClosure(`${row.title ?? ''} ${row.description ?? ''}`);
}

export async function seasonalParkClosureIds(query: QueryFn): Promise<string[]> {
  try {
    const res = await query<Row>(
      `SELECT id::text AS id, title, description
         FROM external_alerts
        WHERE alert_type = 'park_closure'
          AND expires_at > ${UTC_WALL_NOW_SQL}`,
      [],
    );
    return res.rows.filter(isSeasonalClosureRow).map((r) => r.id);
  } catch (e) {
    const code = (e as { code?: string }).code ?? null;
    console.error('[safety-ingest] межсезонные закрытия парков не прочитались — все закрытия считаются красными:', code ?? (e as Error).message);
    return [];
  }
}
