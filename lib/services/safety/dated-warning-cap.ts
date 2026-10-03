/**
 * lib/services/safety/dated-warning-cap.ts
 *
 * Правило «предупреждение живёт до конца названного дня» — и к уже лежащему.
 *
 * Классификатор (`classifyMchsItem`) ставит такой срок новым постам. Но
 * строки, сохранённые до правила, держат старый: «Экстренное предупреждение
 * на 3 октября (сильный дождь)» ушло в паводок со сроком 120 часов. Тот же
 * приём, что у `pruneRejectedGenres`: правило одно (`datedWarningEnd`), крон
 * приёма каждые пять минут прогоняет им живой набор, и хранилище догоняет
 * само — без миграции, которая стала бы второй копией правила.
 *
 * Даты публикации в таблице нет — её место занимает `created_at` (строка
 * вставляется тем же прогоном, что прочёл пост). Она нужна правилу только
 * для года и для проверки «день не прошёл до публикации».
 *
 * Срок только СОКРАЩАЕТСЯ (`LEAST`): продлевать здесь нечего, продление —
 * дело повторной публикации (saveEvent).
 */

import { datedWarningEnd, DATED_WARNING_TYPES } from '@/lib/safety/dated-warning';
import type { QueryFn } from '@/lib/services/safety/alert-prune';

interface Row { id: string; title: string | null; created_at: Date | string | null; expires_at: Date | string | null }

export interface DatedCapResult { checked: number; capped: number }

export async function capDatedWarnings(query: QueryFn): Promise<DatedCapResult> {
  const res = await query<Row>(
    `SELECT id::text, title, created_at, expires_at
       FROM external_alerts
      WHERE expires_at > NOW()
        AND alert_type = ANY($1::text[])`,
    [[...DATED_WARNING_TYPES]],
  );

  const ids: string[] = [];
  const ends: string[] = [];
  for (const row of res.rows) {
    if (!row.title || row.created_at == null || row.expires_at == null) continue;
    const end = datedWarningEnd(row.title, new Date(row.created_at));
    if (!end) continue;
    if (end.getTime() >= new Date(row.expires_at).getTime()) continue;
    ids.push(row.id);
    ends.push(end.toISOString());
  }

  if (ids.length > 0) {
    await query(
      `UPDATE external_alerts ea
          SET expires_at = LEAST(ea.expires_at, v.end_at)
         FROM unnest($1::text[], $2::timestamp[]) AS v(id, end_at)
        WHERE ea.id::text = v.id`,
      [ids, ends],
    );
  }
  return { checked: res.rows.length, capped: ids.length };
}
