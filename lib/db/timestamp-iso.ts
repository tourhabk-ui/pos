/**
 * Метка времени из колонки `timestamp` (без пояса) — в ISO с «Z» (03.10).
 *
 * Повод — плитка «Радар» на главной: у владельца в 20:26 по Камчатке она
 * писала «9 ч назад», хотя сбор безопасности идёт каждые 5 минут, а сервер в
 * тот же час рисовал её «Обстановка недоступна». Метку читали как
 * `MAX(updated_at)::text`: колонка `location_real_time_status.updated_at` —
 * `timestamp` без пояса, `NOW()` пишет в неё стенное время пояса сессии
 * базы, и строка уходит наружу без смещения. Дальше её разбирает
 * `Date.parse`, а он берёт пояс того, кто читает:
 *
 *   - сервер в UTC принимал московские 11:27 за 11:27Z — время из будущего,
 *     и dataFreshness честно отвечал «недоступна»;
 *   - телефон на Камчатке (UTC+12) принимал их за 11:27 по Камчатке, то
 *     есть 23:27 UTC прошлых суток, — «9 ч назад».
 *
 * Здесь стенное время переводится в момент по ПОЯСУ СЕССИИ (тому же, в
 * котором его записал NOW()), а момент печатается в UTC с «Z». При поясе
 * базы UTC результат совпадает с прежним — правка безвредна при любом поясе.
 * Проверено на PostgreSQL 16 под SET TIME ZONE 'Europe/Moscow'.
 */
export function isoUtcSql(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * Метка из колонки `timestamp`, в которую писали стенное время UTC, — в ISO с
 * «Z» (#2495, 15.10).
 *
 * Не всякая колонка без пояса заполнена через NOW(). `external_alerts.created_at`
 * и `expires_at` пишет ингест датой JS с сервера в UTC, а у `timestamp`
 * PostgreSQL смещение входной строки отбрасывает — в колонке остаётся стенное
 * время UTC (так их и читают: `seismic-feed`, `seismic-latency-census` —
 * «created_at без пояса, в UTC; NOW() — в поясе сессии, +03 на проде»).
 * `isoUtcSql` для них неверен: он считает стенное время поясом сессии и на
 * проде сдвигает момент на три часа назад — поймано pg-тестом `safety_status`
 * (`tests/integration/safety-status-feed.pg.test.ts`).
 *
 * Правило решает писатель колонки: у `external_alerts` с миграции 1269 писатель
 * один — стенное UTC у всех строк (ручные записи, ставившие NOW(), переведены,
 * умолчания колонок — `UTC_WALL_NOW_SQL`). `location_real_time_status.updated_at`
 * пишется NOW() в поясе сессии — ей `isoUtcSql`.
 */
export function utcWallIsoSql(expr: string): string {
  return `to_char((${expr}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * «Сейчас» стенным временем UTC — для сравнения с колонками того же рода
 * (`external_alerts.created_at/expires_at`) и для записи в них (15.10).
 *
 * `expires_at > NOW()` сравнивает `timestamp` с `timestamptz`: PostgreSQL
 * толкует стенное время колонки поясом сессии (+03 на проде), и тревога со
 * сроком 12:00 UTC уходила из ленты в 09:00 UTC — на три часа раньше. Сутки
 * предупреждения о шторме стояли в ленте 21 час. Сторож —
 * `tests/unit/alert-time-utc.test.ts` и pg-тест с поясом МСК.
 */
export const UTC_WALL_NOW_SQL = "(NOW() AT TIME ZONE 'UTC')";
