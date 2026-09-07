/**
 * lib/notifications/telegram-upload.ts — снимок уходит в Telegram БАЙТАМИ.
 *
 * ПОВОД (07.09, журнал прода назвал причину словами дважды):
 *
 *   channel_photo_fallback       «Bad Request: failed to get HTTP URL content»
 *   channel_media_group_fallback «Bad Request: failed to send message #1
 *                                 with the error message "WEBPAGE_CURL_FAILED"»
 *
 * Оба кода означают одно: Bot API попытался СКАЧАТЬ наш URL и не смог. При
 * этом снимки живы — перепись с прода отдала по ним `200 · image/jpeg ·
 * 68–214 КБ`, и с раннера GitHub они качаются тоже. Почему у Telegram не
 * вышло, мы НЕ УСТАНОВИЛИ, и выдумывать причину не будем.
 *
 * Но пока мы даём ссылку, публикация зависит от того, дойдёт ли чужой сервер
 * до нашего хоста — а это условие, которого мы не контролируем и проверить
 * не можем. Байты убирают вопрос целиком: файл скачивает НАШ сервер (у него
 * снимок под рукой) и отдаёт его Telegram напрямую, multipart/form-data.
 *
 * Это не обход диагностики: отказ по-прежнему называется словами, просто
 * теперь у него на одну причину меньше.
 */

/** Потолок Bot API на загруженное фото — 10 МБ (у ссылки было 5). */
export const TELEGRAM_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export interface FetchedPhoto {
  blob: Blob;
  filename: string;
  bytes: number;
  contentType: string;
}

/** Имя файла из адреса: Telegram по нему определяет расширение. */
function filenameOf(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    if (/\.(jpe?g|png|webp|gif)$/i.test(last)) return last;
  } catch { /* адрес битый — имя ниже */ }
  return 'photo.jpg';
}

/**
 * Скачать снимок НАШИМ сервером.
 *
 * Возвращает `null` с причиной в логе — не бросает: отправка сама решит, что
 * делать (попробовать ссылкой, уйти текстом), а молчаливое исключение
 * превратило бы отказ сети в «фотографии нет».
 */
export async function fetchPhotoForUpload(url: string): Promise<FetchedPhoto | { error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: `наш адрес отдал HTTP ${res.status}` };

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      // Не картинка — Telegram отказал бы так же, только позже и невнятнее.
      return { error: `тип содержимого ${contentType || 'не указан'}, а не изображение` };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return { error: 'пустое тело ответа' };
    if (buf.byteLength > TELEGRAM_UPLOAD_MAX_BYTES) {
      return { error: `${buf.byteLength} б — больше потолка Telegram ${TELEGRAM_UPLOAD_MAX_BYTES} б` };
    }

    return {
      blob: new Blob([buf], { type: contentType }),
      filename: filenameOf(url),
      bytes: buf.byteLength,
      contentType,
    };
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

export function isFetched(v: FetchedPhoto | { error: string }): v is FetchedPhoto {
  return 'blob' in v;
}
