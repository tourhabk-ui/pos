/**
 * Новый тур гида — ОДНА функция создания для сайта и чата (слово владельца
 * 31.10: гид сам создаёт свои туры, «а должен»).
 *
 * Двери три, запись одна:
 *  - раздел «Свои туры» на сайте — `POST /api/guide/own/tours`;
 *  - фраза в чате кабинета «новый тур: Горелый; цена 15000; группа 4;
 *    описание: …» → предпросмотр → кнопка «Создать черновик»;
 *  - документ Word (.docx, MAX), тура из которого нет среди своих, → тот же
 *    предпросмотр и та же кнопка (lib/guides/tour-edit/create-*).
 *
 * Тур создаётся ЧЕРНОВИКОМ: `is_published = FALSE`, туристу не виден. На сайт
 * его выводит сам гид кнопкой «Опубликовать» — через витринный гейт
 * (lib/guides/own-tour-publish). Создание ничего не публикует.
 *
 * Поля — минимум, без которого карточка соврала бы: название, цена, размер
 * группы, описание. Размер группы — не прихоть: `max_participants` в схеме
 * NOT NULL с умолчанием 1, и тур без него показал бы туристу «группа до 1
 * человека» — число, которого гид не называл (§4.0). Остальное (программа,
 * состав, что взять, безопасность) — по желанию сразу (из документа) или
 * правкой фразой потом. Чего гид не назвал, не пишется: зависимость от
 * погоды — NULL («не записано»), а не умолчание схемы «зависит».
 *
 * Чей тур — в самом INSERT: строка пишется, только если `ownerId` — карточка
 * гида (`partners.category = 'guide'`). Иначе — `not_guide`, ни строки.
 * Транзакцию даёт вызывающий (чат отмечает черновик «создан» в той же).
 */

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getColumnTypes, valueForColumn } from '@/lib/db/column-types';
import { TOUR_DESCRIPTION_MAX, TOUR_LIST_ITEM_MAX, TOUR_SAFETY_ITEM_MAX } from '@/lib/tours/text-limits';
import { LIMITS } from '@/lib/guides/tour-edit/parse';

/** Размер группы своего тура гида: от одного до… — больше в поход не водят. */
export const OWN_TOUR_GROUP_MAX = 200;

const ListSchema = (itemMax: number) => z.array(z.string().trim().min(1).max(itemMax)).min(1).max(LIMITS.listItems);

export const OwnTourDraftSchema = z.object({
  title: z.string().trim().min(LIMITS.titleMin, `Название — хотя бы ${LIMITS.titleMin} знаков`).max(LIMITS.title),
  base_price: z.number().int('Цена — целым числом рублей').min(LIMITS.priceMin).max(LIMITS.priceMax),
  /** «за человека» — как у формы оператора (CreateTourSchema); «за группу» — если гид так сказал. */
  price_unit: z.enum(['per_person', 'per_tour']).default('per_person'),
  max_participants: z.number().int('Размер группы — целым числом').min(1).max(OWN_TOUR_GROUP_MAX),
  description: z.string().trim().min(1, 'Нужно описание тура').max(TOUR_DESCRIPTION_MAX),
  short_description: z.string().trim().min(1).max(LIMITS.short_description).optional(),
  program: z.array(z.object({
    title: z.string().trim().min(1).max(LIMITS.stepTitle),
    text: z.string().max(LIMITS.stepText),
  })).min(1).max(LIMITS.programSteps).optional(),
  included: ListSchema(TOUR_LIST_ITEM_MAX).optional(),
  not_included: ListSchema(TOUR_LIST_ITEM_MAX).optional(),
  what_to_bring: ListSchema(TOUR_LIST_ITEM_MAX).optional(),
  safety_notes: ListSchema(TOUR_SAFETY_ITEM_MAX).optional(),
}).strict();

export type OwnTourDraftInput = z.input<typeof OwnTourDraftSchema>;

export type CreateOwnTour =
  | { outcome: 'created'; tour: { id: string; title: string; slug: string | null } }
  /** `ownerId` — не карточка гида: ни строки не записано. */
  | { outcome: 'not_guide' };

/**
 * Создать черновик своего тура. Вход проверяется схемой здесь же, а не
 * только у двери: функция — единственный путь записи, и проверка у неё.
 */
export async function createOwnTourDraft(
  client: Pick<PoolClient, 'query'>,
  opts: { ownerId: string; userId: string; input: OwnTourDraftInput },
): Promise<CreateOwnTour> {
  const input = OwnTourDraftSchema.parse(opts.input);
  // Состав и списки — тип колонки из схемы (TEXT[] или jsonb), как у createTour.
  const types = await getColumnTypes('operator_tours');
  const list = (v: string[] | undefined, column: string) => (v === undefined ? null : valueForColumn(v, column, types));
  const { rows } = await client.query<{ id: string; title: string; slug: string | null }>(
    `INSERT INTO operator_tours (
        operator_id, title, description, short_description,
        base_price, price_unit, min_participants, max_participants,
        program, included, not_included, what_to_bring, safety_notes,
        weather_dependent, is_active, is_published, created_by
      )
      SELECT p.id, $2, $3, $4,
             $5::numeric, $6, 1, $7::int,
             $8::jsonb, $9, $10, $11, $12,
             NULL, TRUE, FALSE, $13::uuid
        FROM partners p
       WHERE p.id = $1::uuid AND p.category = 'guide'
      RETURNING id::text AS id, title, NULLIF(btrim(slug), '') AS slug`,
    [
      opts.ownerId,
      input.title,
      input.description,
      input.short_description ?? null,
      input.base_price,
      input.price_unit,
      input.max_participants,
      input.program === undefined ? null : JSON.stringify(input.program),
      list(input.included, 'included'),
      list(input.not_included, 'not_included'),
      list(input.what_to_bring, 'what_to_bring'),
      list(input.safety_notes, 'safety_notes'),
      opts.userId,
    ],
  );
  const row = rows[0];
  return row ? { outcome: 'created', tour: row } : { outcome: 'not_guide' };
}
