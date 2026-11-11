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
import { photoKeyOf } from '@/lib/images/photo-key';
import { MAX_TOUR_CLIPS } from '@/lib/tours/tour-clips';

/** Сколько фото у своего тура — как у формы оператора (lib/api/operator-tours). */
export const OWN_TOUR_PHOTOS_MAX = 20;

/**
 * Клипы тура — ключи хранилища под `videos/` (их выдаёт загрузка
 * `POST /api/upload/tour-video`, а клипы, положенные раньше миграцией, лежат
 * там же): уже стоящий клип при сохранении формы не должен отвергаться.
 * Без «..» и без чужого расширения — как у карточки (lib/tours/tour-clips).
 */
export const OWN_CLIP_KEY = /^videos\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.mp4$/;
export const OWN_POSTER_KEY = /^videos\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.jpg$/;

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

/**
 * Снимок, перенесённый в хранилище миграцией (1406, 08.11): адрес раздачи
 * `/api/images/s3/photos/<папка>/<файл>`. Загрузкой гида такой адрес не
 * выдаётся, поэтому сам по себе он не «свой»: на витрину гида его пускает
 * только то, что он УЖЕ стоит у этого тура (роут правки сверяет с базой —
 * `keptStoredPhotos`). Без этого правка любого тура, чьи снимки перенесла
 * 1406, отвергалась целиком «Фото — только загруженное здесь же» (гид Андрей
 * Запорожец 11.11: подписи под фото не правятся после публикации).
 */
export function isStoredPhotoPath(url: string): boolean {
  if (!url.startsWith('/api/images/s3/')) return false;
  return photoKeyOf(url.slice('/api/images/s3/'.length).split('/')) !== null;
}

/** Снимки формы, которые пускает только их место в туре (не загрузка гида). */
export function keptStoredPhotos(photos: readonly string[]): string[] {
  return photos.filter((u) => !isOwnTourPhotoUrl(u) && isStoredPhotoPath(u));
}

const draft = OwnTourDraftSchema.shape;

/**
 * Программа, правила безопасности, клипы и подпись снимков — одни пределы у
 * гида и у оператора (08.11: форма оператора взяла эти блоки из кабинета
 * гида, и правила записи не должны разойтись вместе с формами).
 */
export const TourProgramEditSchema = draft.program.unwrap().nullable();
export const TourSafetyNotesEditSchema = draft.safety_notes.unwrap().nullable();
export const TourClipsEditSchema = z.array(z.object({
  key: z.string().regex(OWN_CLIP_KEY, 'Видео — только загруженное здесь же').refine((k) => !k.includes('..'), 'Видео — только загруженное здесь же'),
  poster: z.string().regex(OWN_POSTER_KEY, 'Обложка видео — только загруженная здесь же').refine((k) => !k.includes('..'), 'Обложка видео — только загруженная здесь же'),
  label: z.string().trim().min(1).max(120),
}).strict()).max(MAX_TOUR_CLIPS, `Не больше ${MAX_TOUR_CLIPS} видео`);
/** Чьи снимки — подпись «Фото: …» к новым фото тура (partners.gallery_credits). */
export const PhotoCreditEditSchema = z.string().trim().min(2, 'Автор снимков — хотя бы 2 знака').max(120);
/**
 * Подпись каждого снимка (11.11): адрес снимка → текст после «Фото:». Пустая —
 * снять подпись. Какие адреса — снимки этого тура, решает запись
 * (lib/tours/editor-media, setPhotoCaptions), а не форма.
 */
export const PhotoCaptionsEditSchema = z.record(z.string().max(500), z.string().trim().max(120, 'Подпись под фото — не длиннее 120 знаков'))
  .refine((m) => Object.keys(m).length <= 50, 'Подписей больше, чем фото у тура');

export const OwnTourEditSchema = OwnTourDraftSchema.pick({
  title: true, base_price: true, max_participants: true, description: true,
}).extend({
  price_unit: z.enum(['per_person', 'per_tour']),
  short_description: z.string().trim().max(500).nullable(),
  program: TourProgramEditSchema,
  included: draft.included.unwrap().nullable(),
  not_included: draft.not_included.unwrap().nullable(),
  what_to_bring: draft.what_to_bring.unwrap().nullable(),
  safety_notes: TourSafetyNotesEditSchema,
  photos: z.array(z.string().trim().max(500).refine((u) => isOwnTourPhotoUrl(u) || isStoredPhotoPath(u), 'Фото — только загруженное здесь же'))
    .max(OWN_TOUR_PHOTOS_MAX, `Не больше ${OWN_TOUR_PHOTOS_MAX} фото`),
  // Сезон (05.11): даты вне сезона открытие отклоняет, а поменять сезон гиду
  // было негде — Андрей открыл Горелый 15.07–15.10 и не смог добавить 1–14.07.
  video_clips: TourClipsEditSchema,
  photo_credit: PhotoCreditEditSchema,
  photo_captions: PhotoCaptionsEditSchema,
  season_start: z.string().date('Начало сезона — дата').nullable(),
  season_end: z.string().date('Конец сезона — дата').nullable(),
}).partial().strict().refine(
  (v) => !v.season_start || !v.season_end || v.season_start <= v.season_end,
  { message: 'Сезон кончается раньше, чем начинается', path: ['season_end'] },
);

export type OwnTourEditInput = z.input<typeof OwnTourEditSchema>;
