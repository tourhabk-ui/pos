/**
 * Наш ли адрес снимка (14.10, слово владельца: «Только используй наши
 * фотографии»).
 *
 * У места два поля со ссылками на снимки — `places.photo_url` и
 * `places.images` — собраны ИМПОРТОМ с посторонних сайтов (lib/places/
 * place-detail, 19.09): ссылка живёт, сколько захочет чужой владелец, а прав
 * на снимок у нас не записано. До 14.10 карточка показывала их, когда своего
 * снимка не было, а превью ссылки (og:image) и разметка (JSON-LD) ставили их
 * даже впереди своего.
 *
 * Наш адрес — путь самого сайта (`/api/images/…`, `/images/…`), адрес нашего
 * домена и объект нашего хранилища (база — `s3PublicUrl`, та же, что даёт
 * заливка; имя бакета живёт в окружении, не здесь). Всё прочее — чужой хост,
 * и его не показываем нигде.
 */
import { s3PublicUrl } from '@/lib/storage/s3';

const SITE_HOSTS = ['vedarai.ru', 'www.vedarai.ru'];

export function isOwnImageUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  // Путь сайта — наш; `//host/…` — адрес чужого хоста без схемы.
  if (u.startsWith('/')) return !u.startsWith('//');
  const store = s3PublicUrl('');
  if (store && u.startsWith(store)) return true;
  if (!URL.canParse(u)) return false;
  const parsed = new URL(u);
  return parsed.protocol === 'https:' && SITE_HOSTS.includes(parsed.hostname);
}

/** Из списка ссылок — только наши, в прежнем порядке. */
export function ownImageUrls(list: unknown): string[] {
  return Array.isArray(list) ? list.filter(isOwnImageUrl) : [];
}

/**
 * Снимок места для превью ссылки и разметки — тем же порядком, что герой
 * карточки: наш снимок места первым, затем наши адреса из прежних полей.
 * null — снимка нет; что вместо, решает вызывающий (превью — картинка сайта,
 * разметка — без поля image).
 */
export function ownPlacePhoto(ownPhoto: string | null, photoUrl: unknown, images: unknown): string | null {
  if (ownPhoto) return ownPhoto;
  if (isOwnImageUrl(photoUrl)) return photoUrl;
  return ownImageUrls(images)[0] ?? null;
}
