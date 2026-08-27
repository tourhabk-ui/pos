/**
 * Абсолютизация фотографий тура для Telegram — ОДНО правило на всех.
 *
 * Telegram скачивает картинку сам и относительный путь не поймёт; при этом
 * уже-абсолютный URL нельзя приклеивать к базе (склейка `${appUrl}${photo}`
 * давала `https://vedarai.ruhttps://…`, Telegram не скачивал битый URL и
 * пост тура молча ронялся в голый текст — кейс kuzmich_tour, 27.08).
 *
 * Вынесено из tour-channel-post в нейтральный модуль: telegram-channel
 * (постер Кузьмича) не может импортировать из tour-channel-post — тот сам
 * импортирует tgPostMediaGroup из telegram-channel, вышел бы цикл.
 */

/** Сколько снимков влезает в один альбом Telegram (sendMediaGroup). */
export const MAX_PHOTOS = 10;

/** Абсолютные URL: относительные пути — к базе, абсолютные — как есть. */
export function absolutePhotoUrls(photos: string[] | null, baseUrl: string): string[] {
  return (photos ?? [])
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => (/^https?:\/\//i.test(p) ? p : `${baseUrl.replace(/\/$/, '')}${p.startsWith('/') ? '' : '/'}${p}`))
    .slice(0, MAX_PHOTOS);
}
