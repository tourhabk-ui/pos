/**
 * lib/tours/tour-clips.ts — короткие клипы тура (миграция 1194).
 *
 * В базе лежат КЛЮЧИ объектов хранилища (`videos/...`), адрес собирает сервер
 * из той же базы, что и заливка (`s3PublicBase`). Строка в базе — не
 * доказательство происхождения: ключ вне `videos/`, чужое расширение или
 * обложка не из хранилища отбрасываются, и клип не показывается.
 *
 * Хранилище не настроено — клипов нет: адрес без имени бакета указывал бы в
 * никуда, и карточка рисовала бы пустые рамки.
 *
 * Сторож: tests/unit/tour-video-clips.test.ts.
 */

import { isS3Configured, s3PublicBase } from '@/lib/storage/s3';

export interface TourClip {
  url: string;
  poster: string;
  label: string;
}

const CLIP_KEY = /^videos\/[a-z0-9/._-]+\.mp4$/;
const POSTER_KEY = /^videos\/[a-z0-9/._-]+\.jpg$/;
/** Больше на карточке не нужно: лента клипов — настроение, а не фильм. */
export const MAX_TOUR_CLIPS = 6;

/** Разобрать `operator_tours.video_clips`. `base` — публичная база хранилища или null. */
export function parseTourClips(raw: unknown, base: string | null): TourClip[] {
  if (!base || !Array.isArray(raw)) return [];
  const out: TourClip[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const { key, poster, label } = c as { key?: unknown; poster?: unknown; label?: unknown };
    if (typeof key !== 'string' || !CLIP_KEY.test(key) || key.includes('..')) continue;
    if (typeof poster !== 'string' || !POSTER_KEY.test(poster) || poster.includes('..')) continue;
    const text = typeof label === 'string' && label.trim() ? label.trim() : 'Видео тура';
    out.push({ url: `${base}/${key}`, poster: `${base}/${poster}`, label: text });
    if (out.length >= MAX_TOUR_CLIPS) break;
  }
  return out;
}

/** Клипы тура для карточки: адреса хранилища этого приложения. */
export function tourClips(raw: unknown): TourClip[] {
  return parseTourClips(raw, isS3Configured ? s3PublicBase() : null);
}
