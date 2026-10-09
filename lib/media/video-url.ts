/**
 * lib/media/video-url.ts — адрес ролика или обложки для страницы. Только для
 * сервера: бакет хранилища живёт в окружении приложения.
 *
 * В базе записан путь `/video/...` (partners.video_url, video_clips — так
 * велит CHECK partners_video_shape), а файлы с 09.10 лежат в хранилище
 * (lib/media/video-manifest.ts). Страница получает прямой адрес объекта:
 * браузер идёт туда сам, без лишнего круга через наш сервер, и запрос мимо
 * нашего источника не попадает в service worker, который на отказ сети
 * отвечает разметкой страницы /offline.
 *
 * Путь вне манифеста или хранилище не настроено — путь как есть: его
 * разберёт /video/[...path] (переадресация или честный 404/503).
 */
import { s3PublicUrl } from '@/lib/storage/s3';
import { isKnownVideoPath, videoObjectKey } from '@/lib/media/video-manifest';

export function videoSrc(path: string): string {
  if (!isKnownVideoPath(path)) return path;
  return s3PublicUrl(videoObjectKey(path)) ?? path;
}
