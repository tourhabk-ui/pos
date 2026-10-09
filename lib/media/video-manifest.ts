/**
 * lib/media/video-manifest.ts — ролики платформы и их обложки: что лежит в
 * хранилище (S3) и каким оно обязано быть. Чистый модуль: его читают и
 * сервер (адрес ролика для страницы), и заливка с раннера (что везти и с чем
 * сверять прочитанное обратно).
 *
 * ── Что было до 09.10 ─────────────────────────────────────────────────────
 *
 * Ролики лежали в репозитории, в public/video: десять файлов, 7,1 МБ. Они
 * уезжали в каждый образ деплоя (лимит standalone — 50 МБ, §6.1) и в каждый
 * клон, хотя фото мест к тому времени давно жили в хранилище (§4.1, 18.09).
 * Владелец: «видео тоже в s3».
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Путь из базы → отпечаток файла. Пути `/video/...` записаны в
 * partners.video_url и video_clips, и форму держит CHECK
 * partners_video_shape (миграция 1185) — поэтому путь остался прежним, а
 * ключ объекта — тот же путь без ведущей косой.
 *
 * Новый файл — новое имя. Объект отдаётся с кэшем на год (immutable,
 * lib/storage/s3.ts), и замена под старым ключом у людей не обновилась бы:
 * заливка отказывается писать поверх объекта с другим отпечатком.
 */

export interface VideoFile {
  /** sha256 содержимого, hex. Сверяется до заливки и после чтения обратно. */
  sha256: string;
  bytes: number;
  type: 'video/mp4' | 'image/jpeg';
}

export const VIDEO_FILES: Readonly<Record<string, VideoFile>> = {
  // Нижний ролик карточки перевозчика (миграция 1189, владелец 09.10).
  '/video/shatun/shatun-bears.mp4': {
    sha256: '7c06a083254ce2b61030eefcf6fa01a9cbb83d216d5d2fa10d7d03e5358b32f0', bytes: 3596501, type: 'video/mp4' },
  '/video/shatun/shatun-bears.poster.jpg': {
    sha256: '738494352d464b3ab8ae0a06ee99b5c69d9a2370cfd4ae5e34b05520e027386e', bytes: 38280, type: 'image/jpeg' },
  // Прежний нижний ролик (миграция 1185). На экране его больше нет, но его
  // путь — в откате 1189: откат не должен вести в пустоту.
  '/video/shatun/shatun-river-crossing.mp4': {
    sha256: 'b38a3e6eaaefddfa9ac4e80a1bd1f5a25cf8f943f22f3a818e4eab2256f50fce', bytes: 2955811, type: 'video/mp4' },
  '/video/shatun/shatun-river-crossing.poster.jpg': {
    sha256: '15bd9641c06cf8469bbf75f183177f31acd196b33ce6426a7195d8ec914dac73', bytes: 37081, type: 'image/jpeg' },
  // Короткие петли ленты (миграция 1186).
  '/video/shatun/clip-water-approach.mp4': {
    sha256: '1e14f5ba099f62c678773163e431d3cdf53cd1973fd759d92abab250c6f80eea', bytes: 161894, type: 'video/mp4' },
  '/video/shatun/clip-water-approach.poster.jpg': {
    sha256: 'b4268b531483042ef3087059a1de0a39d8c801485ceeed8e1615f5f5b2a64f0b', bytes: 19232, type: 'image/jpeg' },
  '/video/shatun/clip-ferry-rope.mp4': {
    sha256: 'af6893b0483c34e45d6d7981de6e6f9d3a3bf91dc24fb8fbddd9d876608ce3c1', bytes: 229373, type: 'video/mp4' },
  '/video/shatun/clip-ferry-rope.poster.jpg': {
    sha256: '9220682877a18ba38d17f40095352e7c13f8399e64826daebf5423c8a0017b69', bytes: 24659, type: 'image/jpeg' },
  '/video/shatun/clip-beach-exit.mp4': {
    sha256: 'eabc7db0f2069eb38fc377f04d7367a6ff8d9080e7a51c906f97127c057bded1', bytes: 219117, type: 'video/mp4' },
  '/video/shatun/clip-beach-exit.poster.jpg': {
    sha256: 'c448b254cb794aa73bdf03c57250ebef17e3956bfde512d2d999118f65e49e97', bytes: 29525, type: 'image/jpeg' },
};

export function isKnownVideoPath(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(VIDEO_FILES, path);
}

/** Ключ объекта в хранилище: путь без ведущей косой (`video/shatun/...`). */
export function videoObjectKey(path: string): string {
  return path.replace(/^\/+/, '');
}
