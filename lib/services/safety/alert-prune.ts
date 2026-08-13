/**
 * lib/services/safety/alert-prune.ts
 *
 * Жанровые стражи применяются не только на приёме, но и к уже лежащему.
 *
 * ── Что случилось ──────────────────────────────────────────────────────────
 *
 * Перепись 11.08: 137 маршрутов из 421 стоят «Не сегодня», и причина у всех
 * одна — «На Камчатке сводная группировка спасателей ОБЕСПЕЧИЛА БЕЗОПАСНОСТЬ
 * туристической группы». Это репортаж о законченной работе, и страж жанра
 * `isRescueOperationReport` его знает: глагол «обеспечила безопасность» в нём
 * есть, новая такая запись до базы не дойдёт.
 *
 * Но запись уже лежала. Страж стоит на ПРИЁМЕ (`classifyMchsItem`), а старые
 * строки чистила миграция 846 — руками, своим списком глаголов на SQL:
 *
 *   TS-страж:  окажет|оказал|оказана|оказывают помощь · ОБЕСПЕЧИЛ БЕЗОПАСНОСТЬ ·
 *              сопроводил · вывел из/к · спасл · эвакуирова · деблокирова ·
 *              ведётся поиск · подняли на борт · транспортирован · сняли с маршрута
 *   SQL 846:   окажет|оказал|оказана помощь · эвакуирова · деблокирова
 *
 * Два списка об одном правиле, и они разошлись: SQL написан раньше, чем страж
 * дорос до «обеспечила безопасность». Запись пережила чистку и красит треть
 * справочника до сих пор.
 *
 * ── Почему не ещё одна миграция ────────────────────────────────────────────
 *
 * Потому что это было бы третьей копией того же правила, и она разойдётся так
 * же, как разошлась вторая — при следующем добавленном глаголе. Ровно тот
 * дефект, что мы весь день ловим: два независимых источника одной истины.
 *
 * Здесь правило остаётся ОДНО — те же функции стража. Крон приёма ходит
 * каждые пять минут и после разбора прогоняет ими уже сохранённое: что
 * сегодняшний страж не пропустил бы, того не должно быть и в базе. Список
 * глаголов пополняется в одном месте, и хранилище догоняет само.
 */

import { isDailyBulletin, isRescueOperationReport } from '@/lib/services/safety/seismic-parser';

export type RejectedGenre = 'daily_bulletin' | 'rescue_report';

/**
 * Какой жанр отбраковал бы текст сегодня. `null` — запись законная.
 *
 * Порядок проверок значения не имеет: обе ветки одинаково означают «это не
 * предупреждение», а различаются только в отчёте, чтобы было видно, чего
 * именно накопилось.
 */
export function rejectedGenre(text: string): RejectedGenre | null {
  if (isDailyBulletin(text)) return 'daily_bulletin';
  if (isRescueOperationReport(text)) return 'rescue_report';
  return null;
}

export type QueryFn = <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;

export interface PruneResult {
  /** Сколько живых записей просмотрено. */
  checked: number;
  removed: number;
  /** Сколько точек потеряло протухший алерт из своего массива. */
  places_cleaned: number;
  by_genre: Record<RejectedGenre, number>;
}

interface AlertRow { id: string; title: string | null; description: string | null }

/**
 * Убирает из хранилища то, что сегодняшний страж не пропустил бы.
 *
 * Смотрит заголовок ВМЕСТЕ с телом: жанр виден по глаголу, а глагол не всегда
 * в заголовке. Пустое тело — не повод считать запись законной, поэтому
 * проверяется склейка, а не тело отдельно.
 */
export async function pruneRejectedGenres(query: QueryFn): Promise<PruneResult> {
  const res = await query<AlertRow>(
    `SELECT id::text, title, description
       FROM external_alerts
      WHERE (expires_at IS NULL OR expires_at > NOW())`,
    [],
  );

  const by_genre: Record<RejectedGenre, number> = { daily_bulletin: 0, rescue_report: 0 };
  const doomedIds: string[] = [];
  const doomedTitles: string[] = [];

  for (const row of res.rows) {
    const text = `${row.title ?? ''} ${row.description ?? ''}`.trim();
    if (text === '') continue;
    const genre = rejectedGenre(text);
    if (!genre) continue;
    by_genre[genre] += 1;
    doomedIds.push(row.id);
    if (row.title != null && row.title !== '') doomedTitles.push(row.title);
  }

  if (doomedIds.length === 0) {
    return { checked: res.rows.length, removed: 0, places_cleaned: 0, by_genre };
  }

  // Сравнение ТЕКСТОМ, а не приведением к типу ключа — и это не мелочь стиля.
  //
  // Здесь стояло `id = ANY($1::uuid[])`. У `external_alerts` ключ —
  // `BIGSERIAL` (миграция 070), и Postgres отвечал на это
  // «operator does not exist: bigint = uuid». То есть удаление не работало
  // НИ РАЗУ с самого написания модуля: пока протухших записей не было, ветка
  // не исполнялась, а как только появилась первая — падал весь приём
  // (свидетельство приёма стиралось вместе с ним, тревога 3805 минут).
  //
  // Поэтому код больше не утверждает, какого типа ключ. Идентификаторы уже
  // пришли из SELECT выше строками; строками и сравниваем. Индекс по `id` при
  // этом не используется, но выборка выше и так читает весь живой набор
  // алертов — платить нечем.
  await query(`DELETE FROM external_alerts WHERE id::text = ANY($1::text[])`, [doomedIds]);

  // Тот же текст уже разложен по точкам массивом — снять его надо и там,
  // иначе запись исчезнет из источника и останется на карточках (миграция
  // 846 напоролась ровно на это).
  let places_cleaned = 0;
  if (doomedTitles.length > 0) {
    const upd = await query<{ id: string }>(
      `UPDATE location_real_time_status
          SET active_alerts = (
            SELECT COALESCE(array_agg(a), ARRAY[]::TEXT[])
              FROM unnest(active_alerts) AS a
             WHERE NOT (a = ANY($1::text[]))
          )
        WHERE EXISTS (
          SELECT 1 FROM unnest(active_alerts) AS a WHERE a = ANY($1::text[])
        )
        RETURNING id::text`,
      [doomedTitles],
    );
    places_cleaned = upd.rows.length;
  }

  return { checked: res.rows.length, removed: doomedIds.length, places_cleaned, by_genre };
}
