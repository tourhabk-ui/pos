/**
 * Адрес фото, который можно привязать к объекту, — только НАШ: объект,
 * положенный /api/upload в наше хранилище (S3 `uploads/`), или
 * dev-фоллбэк того же роута (`/uploads/...`).
 *
 * До 26.09 POST .../photos принимал любой внешний URL: владелец (или
 * укравший его сессию) мог повесить на витрину картинку с чужого сервера —
 * трекинг-пиксель, подменяемое содержимое, чужие авторские права. Байты с
 * чужого адреса мы не проверяли и проверить не можем.
 *
 * База хранилища — `s3PublicBase()` из lib/storage/s3 (та же, из которой
 * собирается url при заливке), своя не заводится.
 */

import { isS3Configured, s3PublicBase } from '@/lib/storage/s3';

const FILE = /^[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i;

export function isOwnUploadUrl(url: string): boolean {
  const local = /^\/uploads\/([^/?#]+)$/.exec(url);
  if (local) return FILE.test(local[1]);

  if (!isS3Configured) return false;
  const prefix = `${s3PublicBase()}/uploads/`;
  if (!url.startsWith(prefix)) return false;
  const rest = url.slice(prefix.length);
  return FILE.test(rest);
}

/** MIME по расширению нашего же имени (имя даёт /api/upload по сигнатуре байт). */
export function mimeFromOwnUploadUrl(url: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const lower = url.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
