/**
 * lib/planner/zone-match.ts — какой тур подходит дню зоны (аудит
 * планировщика 07.11, волна 3.4, E4).
 *
 * Тур подходит, если его зона совпала с зоной дня. Тур без записанной зоны
 * (маршрут не указан или у маршрута нет зоны) — городской и подходит только
 * Авачинской зоне.
 *
 * До 07.11 предикат был `ark.zone = $1 OR $1 = 'avachinsky'`: Авачинская
 * зона брала туры ЛЮБОЙ зоны, и западная рыбалка вставала днём в городе без
 * переезда. Комментарий рядом обещал «тур без зоны — городской», а код брал и
 * туры с чужой зоной.
 *
 * Один предикат на всех, кто спрашивает «туры этой зоны»: отбор туров на
 * день (`fetchRealToursForZone`), счёт заполненности зоны
 * (`fetchZoneCapacity`) и список туров дня в планировщике
 * (`/api/planner/tours-for-day`). Два запроса об одном обязаны отбирать
 * одно и то же — иначе зона, чьи туры движок ставит, никогда не считается
 * заполненной (разбор 27.09, `tests/unit/planner-zone-crowd.test.ts`).
 */

import { SOUTHERN_ZONE_MAX_LAT } from '@/lib/planner/constants';

/**
 * SQL-условие «тур подходит зоне дня». `arkAlias` — псевдоним
 * `agent_route_knowledge` в запросе (через LEFT JOIN: тура без маршрута
 * строка есть, зона — NULL), `zoneParam` — номер параметра с зоной дня
 * (`$1`, `$2`). Значение зоны — только параметром, не строкой в SQL.
 */
export function zoneMatchSql(arkAlias: string, zoneParam: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(arkAlias) || !/^\$\d+$/.test(zoneParam)) {
    throw new Error(`zoneMatchSql: недопустимый псевдоним или параметр (${arkAlias}, ${zoneParam})`);
  }
  return `(${plannerZoneSql(arkAlias)} = ${zoneParam} OR (${arkAlias}.zone IS NULL AND ${zoneParam} = 'avachinsky'))`;
}

/**
 * Зона планера записи каталога (#3394 п.3): южнее `SOUTHERN_ZONE_MAX_LAT` —
 * южная (Курильское озеро), иначе записанная зона. `places.zone` Курильского
 * озера — `western` по району, и его не трогаем: по районам приходят тревоги
 * МЧС. Широта — та же, что в `plannerZoneOf` для экрана.
 */
export function plannerZoneSql(arkAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(arkAlias)) throw new Error(`plannerZoneSql: недопустимый псевдоним (${arkAlias})`);
  return `(CASE WHEN ${arkAlias}.lat IS NOT NULL AND ${arkAlias}.lat < ${SOUTHERN_ZONE_MAX_LAT} THEN 'southern' ELSE ${arkAlias}.zone END)`;
}
