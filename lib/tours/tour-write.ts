/**
 * Запись правки тура — один путь для кабинета оператора на сайте
 * (`PATCH /api/hub/operator/tours/[id]`) и для правки гида в чате кабинета
 * (lib/guides/tour-edit, слово владельца 30.10 «гид должен полностью
 * управлять своей ролью из MAX»).
 *
 * До 30.10 этот код жил в самом роуте, и чату пришлось бы писать тур своим
 * UPDATE: две записи одного тура расходятся (белый список, тип колонки,
 * сброс чисел условий отмены, главное фото). Теперь роут и чат зовут одну
 * функцию, а сторож `guide-tour-edit` проверяет это вызовом.
 *
 * Владение — в самом UPDATE: `ownerId` — карточка (`partners.id`), чей тур
 * правится; чужой или удалённый тур — `null`, ни строки не тронуто.
 * `ownerId: null` — только администратор (роут проверил роль).
 *
 * Транзакцию даёт вызывающий: роут пишет теги в той же транзакции, чат —
 * отметку черновика «сохранён». Пинг IndexNow — после COMMIT, у вызывающего.
 */

import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { UpdateTourSchema } from '@/lib/api/operator-tours';
import { assertLiveMainPlace } from '@/lib/tours/main-place';
import { getColumnTypes, valueForColumn } from '@/lib/db/column-types';

/** Шаг программы дня (operator_tours.program, миграция 809). */
export interface TourProgramStep {
  title: string;
  text: string;
}

/**
 * Правка тура: поля формы кабинета плюс программа и правила безопасности
 * тура. Последних в форме сайта нет (UpdateTourSchema их не пропускает),
 * их пишет чат гида — той же функцией.
 */
export type TourPatchInput = z.infer<typeof UpdateTourSchema> & {
  program?: TourProgramStep[] | null;
  safety_notes?: string[] | null;
};

/** Белый список колонок, которые правка тура вправе писать. */
export const TOUR_PATCH_COLUMNS = [
  'title', 'short_description', 'description',
  'location_type', 'activity_type', 'location_name',
  'latitude', 'longitude',
  'base_price', 'price_old', 'price_unit',
  'max_participants', 'min_participants',
  'duration_hours', 'duration_type', 'multi_day_count',
  'season_start', 'season_end', 'seasonal_only',
  'difficulty', 'weather_dependent',
  'min_visibility_m', 'max_wind_kmh', 'max_precipitation_mm',
  'is_active', 'is_published',
  'included', 'not_included', 'what_to_bring',
  'program', 'safety_notes',
  'cancellation_policy',
  'pickup_type', 'pickup_details',
  'photos', 'tour_image',
  'available_slots', 'next_available_date',
] as const;

export type TourPatchColumn = (typeof TOUR_PATCH_COLUMNS)[number];

export interface TourWriteResult {
  id: string;
  title: string;
  updated_at: Date | string;
}

export type TourWrite =
  | { outcome: 'written'; row: TourWriteResult }
  /** Тура нет, он удалён или не этой карточки — ничего не записано. */
  | { outcome: 'not_found' }
  /** В правке нет ни одного поля. */
  | { outcome: 'empty' };

export async function writeTourPatch(
  client: Pick<PoolClient, 'query'>,
  opts: {
    tourId: bigint | string;
    /** `partners.id` владельца тура; null — администратор. */
    ownerId: string | null;
    input: TourPatchInput;
    /** Строка тура до правки (для главного места: пишется только перемена). */
    current: Record<string, unknown>;
  },
): Promise<TourWrite> {
  const { input, current } = opts;
  const rec = input as Record<string, unknown>;
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  // Тип колонки берём из схемы, а не из предположения: состав тура на проде
  // год был jsonb там, где репозиторий объявлял TEXT[], и сохранение падало.
  const columnTypes = await getColumnTypes('operator_tours');

  for (const key of TOUR_PATCH_COLUMNS) {
    if (key in rec && rec[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      // Программа — jsonb всегда: массив объектов в TEXT[] не ляжет.
      values.push(key === 'program' && rec[key] !== null ? JSON.stringify(rec[key]) : valueForColumn(rec[key], key, columnTypes));
    }
  }

  // Главное фото каталога — первое фото галереи. Редактор пишет только
  // photos («первое — главное»), а плитка каталога и OG-картинка читают
  // tour_image: до 25.09 в каталоге оставалась старая картинка.
  if (Array.isArray(rec.photos) && rec.tour_image === undefined) {
    const first = (rec.photos as unknown[]).find((p): p is string => typeof p === 'string' && p.trim().length > 0);
    fields.push(`tour_image = $${idx++}`);
    values.push(first ?? null);
  }

  // Числа условий отмены (1012) выведены из ПРЕЖНЕГО текста. Оператор
  // переписал текст — числа больше ему не соответствуют, и счёт возврата
  // разошёлся бы с тем, что турист читает на карточке. Сбрасываем их в NULL
  // («условия не записаны» → 100%, lib/payments/tour-refund.ts): пробел в
  // данных безопаснее для туриста, чем число от чужой фразы. RHS в SET
  // читает старое значение строки, поэтому сравнение — со старым текстом.
  const policyInput = rec.cancellation_policy;
  if (policyInput !== undefined) {
    const p = `$${idx++}`;
    values.push(policyInput);
    fields.push(
      `cancellation_free_days = CASE WHEN cancellation_policy IS DISTINCT FROM ${p}::text THEN NULL ELSE cancellation_free_days END`,
      `cancellation_late_refund_percent = CASE WHEN cancellation_policy IS DISTINCT FROM ${p}::text THEN NULL ELSE cancellation_late_refund_percent END`,
    );
  }

  // Закрепление наверху страницы оператора (1267). Повторное «закрепить»
  // не сдвигает момент закрепления: порядок закреплённых — по тому, кого
  // закрепили раньше, и сохранение формы целиком его не перемешивает.
  if (typeof rec.pinned === 'boolean') {
    fields.push(`pinned_at = CASE WHEN $${idx++}::boolean THEN COALESCE(pinned_at, NOW()) ELSE NULL END`);
    values.push(rec.pinned);
  }

  // Главное место тура (1286, аудит 15.10 TOUR-PLACE). Форма шлёт поле
  // целиком при каждом сохранении, поэтому пишем только ПЕРЕМЕНУ: иначе
  // связь, поставленная миграцией по координатам, при любой правке цены
  // выдавала бы себя за выбор оператора, а место, скрытое позже, не давало
  // бы сохранить тур вовсе. Новое место проверяется здесь же, в транзакции
  // вызывающего: только существующее, видимое и не слитое.
  const mainPlaceInput = rec.main_place_id as string | null | undefined;
  const currentMainPlace = (current.main_place_id as string | null | undefined) ?? null;
  const mainPlaceChange = mainPlaceInput !== undefined && mainPlaceInput !== currentMainPlace;
  if (mainPlaceChange) {
    fields.push(`main_place_id = $${idx++}::text`);
    values.push(mainPlaceInput);
    fields.push(`main_place_source = $${idx++}::text`);
    values.push(mainPlaceInput === null ? null : 'operator');
  }

  // Одни теги без полей — тоже «нечего сохранять», как было у роута.
  if (fields.length === 0) return { outcome: 'empty' };

  if (mainPlaceChange && mainPlaceInput !== null && mainPlaceInput !== undefined) {
    await assertLiveMainPlace(client, mainPlaceInput);
  }

  const tourIdx = idx++;
  const ownerIdx = idx++;
  values.push(String(opts.tourId), opts.ownerId);
  const result = await client.query<TourWriteResult>(
    `UPDATE operator_tours SET ${[...fields, 'updated_at = NOW()'].join(', ')}
      WHERE id = $${tourIdx}::bigint AND deleted_at IS NULL
        AND ($${ownerIdx}::uuid IS NULL OR operator_id = $${ownerIdx}::uuid)
      RETURNING id::text AS id, title, updated_at`,
    values,
  );
  const row = result.rows[0];
  if (!row) return { outcome: 'not_found' };

  if (input.tags !== undefined) {
    await client.query(`DELETE FROM operator_tour_tags WHERE tour_id = $1`, [String(opts.tourId)]);
    for (const tag of input.tags) {
      await client.query(
        `INSERT INTO operator_tour_tags (tour_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [String(opts.tourId), tag.trim().toLowerCase()],
      );
    }
  }
  return { outcome: 'written', row };
}
