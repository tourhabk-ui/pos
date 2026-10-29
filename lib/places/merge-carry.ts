/**
 * Слияние мест: тур уходит вслед за своим главным местом (миграция 1344,
 * слово владельца 29.10 «1в 2б 3 да»).
 *
 * Связь «тур → главное место» (operator_tours.main_place_id) ставят оператор,
 * администратор и миграции — каждая по своей улике. Когда дубль сливается в
 * каноническую запись, дубль скрывается (merged_into_id), и тур, связанный с
 * ним, пропадал бы с карточки места вовсе: «Туры к этому месту» читают
 * связь только с живым местом. Слияние говорит «это одно и то же место» —
 * значит, и тур едет к оставшемуся.
 *
 * Источник связи (`main_place_source`) сохраняется: перенос не делает связь
 * ни «выбором оператора», ни «выбором администратора» — она остаётся тем,
 * чем была, только адрес места стал каноническим.
 *
 * Разъединение (`/api/cron/places-unmerge`) связь назад НЕ возвращает: какое
 * место было у тура до слияния, база не хранит. Вернуть — рукой, в кабинете
 * тура или PATCH /api/admin/operator-tours/<id>.
 *
 * Зовётся в транзакции слияния рядом с переносом route_waypoints:
 * app/api/admin/places/merge, app/api/cron/places-dedup.
 */

import type { PoolClient } from 'pg';

/** Перевесить туры с места `mergeId` на `keepId`. Возвращает число туров. */
export async function carryTourMainPlace(
  client: Pick<PoolClient, 'query'>,
  keepId: string,
  mergeId: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE operator_tours
        SET main_place_id = $1::text, updated_at = NOW()
      WHERE main_place_id = $2::text`,
    [keepId, mergeId],
  );
  return res.rowCount ?? 0;
}
