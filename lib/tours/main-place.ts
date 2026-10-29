/**
 * Главное место тура — проверка выбора (миграции 1286, 1343).
 *
 * Связь «тур → место» пишут четыре двери: миграция по точному равенству
 * координат (coords_equal, 1286), миграция по сверке названий (verified,
 * 1343), оператор в кабинете — при создании и правке тура (operator), и
 * администратор (admin, PATCH /api/admin/operator-tours/[id]). Двери
 * человека принимают только ЖИВОЕ место справочника: существующее, видимое и
 * не слитое. Проверка одна на все двери — копия в каждом роуте разошлась бы
 * при первой правке, как расходились копии флагов витрины.
 *
 * Свободного текста нет: место выбирают из списка (MainPlacePicker), а
 * выводить связь из близости координат или похожести имени запрещено
 * (CLAUDE.md §4.1, §14).
 */

import type { PoolClient } from 'pg';

/** Источник связи — ровно четыре значения; CHECK миграции 1343 держит то же. */
export const MAIN_PLACE_SOURCES = ['coords_equal', 'operator', 'verified', 'admin'] as const;
export type MainPlaceSource = (typeof MAIN_PLACE_SOURCES)[number];

/**
 * Место не принято: такого нет, оно скрыто или слито в другое. Отказ клиенту
 * (400), а не сбой: выбрать можно только живое место справочника.
 */
export class MainPlaceRejected extends Error {
  constructor() {
    super('Главное место не найдено в справочнике мест или скрыто — выберите место из списка');
    this.name = 'MainPlaceRejected';
  }
}

/**
 * Проверить место в транзакции записи. `FOR SHARE` держит строку места до
 * конца транзакции: скрыть или слить его между проверкой и записью тура
 * нельзя. Не живое — бросает MainPlaceRejected.
 */
export async function assertLiveMainPlace(client: Pick<PoolClient, 'query'>, placeId: string): Promise<void> {
  const place = await client.query(
    `SELECT id FROM places
      WHERE id = $1 AND is_visible = TRUE AND merged_into_id IS NULL
      FOR SHARE`,
    [placeId],
  );
  if (place.rows.length === 0) throw new MainPlaceRejected();
}
