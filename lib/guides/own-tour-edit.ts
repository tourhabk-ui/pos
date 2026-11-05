/**
 * Правка своего тура гидом на сайте (`PATCH /api/guide/own/tours/[id]`).
 *
 * С 05.11 форма правит не только название, цену, группу, анонс и описание,
 * но и программу дня, что включено / не входит / что взять, правила
 * безопасности и фото (гид Андрей Запорожец: «непонятно, как отредактировать
 * программу или добавить фото к туру»). Пределы — те же, что у создания
 * (`OwnTourDraftSchema`) и у правки фразой в чате. Пустой список или
 * программа — null: поле снимается, а не пишется пустым массивом.
 */
import { z } from 'zod';
import { OwnTourDraftSchema } from '@/lib/guides/own-tour-create';
import { s3PublicUrl } from '@/lib/storage/s3';

/** Сколько фото у своего тура — как у формы оператора (lib/api/operator-tours). */
export const OWN_TOUR_PHOTOS_MAX = 20;

/**
 * Адрес фото своего тура — только тот, что выдаёт загрузка
 * (`POST /api/upload/tour-photo`): объект хранилища платформы в
 * `images/tours/` или локальный путь разработки. Чужой сайт на витрину гида
 * не поставить: строка в запросе — не доказательство происхождения.
 */
export function isOwnTourPhotoUrl(url: string): boolean {
  if (/^\/(?:images\/tours|api\/photos\/images\/tours)\/[\w.-]+$/.test(url) && !url.includes('..')) return true;
  const prefix = s3PublicUrl('images/tours/');
  if (!prefix || !url.startsWith(prefix)) return false;
  return /^[\w.-]+$/.test(url.slice(prefix.length)) && !url.includes('..');
}

const draft = OwnTourDraftSchema.shape;

export const OwnTourEditSchema = OwnTourDraftSchema.pick({
  title: true, base_price: true, max_participants: true, description: true,
}).extend({
  price_unit: z.enum(['per_person', 'per_tour']),
  short_description: z.string().trim().max(500).nullable(),
  program: draft.program.unwrap().nullable(),
  included: draft.included.unwrap().nullable(),
  not_included: draft.not_included.unwrap().nullable(),
  what_to_bring: draft.what_to_bring.unwrap().nullable(),
  safety_notes: draft.safety_notes.unwrap().nullable(),
  photos: z.array(z.string().trim().max(500).refine(isOwnTourPhotoUrl, 'Фото — только загруженное здесь же'))
    .max(OWN_TOUR_PHOTOS_MAX, `Не больше ${OWN_TOUR_PHOTOS_MAX} фото`),
}).partial().strict();

export type OwnTourEditInput = z.input<typeof OwnTourEditSchema>;
