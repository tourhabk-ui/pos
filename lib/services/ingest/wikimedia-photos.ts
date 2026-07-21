/**
 * Wikimedia Commons real-photo lookup for places.
 *
 * Ищет свободно-лицензированные (CC / public domain) фото рядом с координатами
 * места через Commons API (geosearch по File-namespace + imageinfo с extmetadata),
 * фильтрует по лицензии и собирает атрибуцию (автор + лицензия + ссылки).
 *
 * Кандидаты НЕ сохраняются автоматически — админ выбирает нужный кадр в ревью
 * (чтобы не приклеить неверное фото), после чего оно скачивается и кладётся в
 * ai_route_images с атрибуцией. Требует сетевого доступа (работает на проде).
 */

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
// Wikimedia требует осмысленный User-Agent с контактом.
const USER_AGENT = 'TourHab/1.0 (+https://vedarai.ru; photos@vedarai.ru)';

export interface WikiCandidate {
  title: string; // File:Xxx.jpg
  pageId: number;
  distanceM: number | null;
  imageUrl: string; // полноразмерный оригинал
  thumbUrl: string; // превью для ревью
  width: number;
  height: number;
  mime: string;
  author: string; // очищенный от HTML автор ('' если неизвестно)
  license: string; // короткое имя лицензии
  licenseUrl: string; // ссылка на лицензию ('' если нет)
  descriptionUrl: string; // страница файла на Commons
}

// ── Pure helpers (тестируемы без сети) ──────────────────────────

/**
 * Свободна ли лицензия для повторного использования. Опираемся на
 * машиночитаемое extmetadata.License (cc-by-sa-4.0, cc0, pd, ...) и
 * fallback на LicenseShortName. Отсекаем fair use / non-free / all rights.
 */
export function isFreeLicense(machineCode: string | null, shortName: string | null): boolean {
  const code = (machineCode ?? '').trim().toLowerCase();
  const short = (shortName ?? '').trim().toLowerCase();

  const blocked = /fair\s*use|non[-\s]?free|all rights reserved|copyright|©/i;
  if (blocked.test(short) && !short.includes('cc')) return false;

  if (code) {
    if (code === 'pd' || code === 'cc0') return true;
    if (code.startsWith('cc-') || code.startsWith('cc0') || code.startsWith('pd-')) return true;
    if (code.includes('public domain')) return true;
    return false;
  }

  // Нет машинного кода — судим по короткому имени.
  return /(^|\s)cc[\s0-]|creative commons|public domain|cc0/i.test(short);
}

/** Снимает HTML-теги и схлопывает пробелы — extmetadata.Artist часто HTML. */
export function stripHtml(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExtMetaField { value?: string }
interface ExtMetadata {
  Artist?: ExtMetaField;
  LicenseShortName?: ExtMetaField;
  License?: ExtMetaField;
  LicenseUrl?: ExtMetaField;
}
interface ImageInfoEntry {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: ExtMetadata;
}
interface ImageInfoPage {
  pageid?: number;
  title?: string;
  imageinfo?: ImageInfoEntry[];
}
interface GeosearchHit {
  pageid: number;
  title: string;
  dist?: number;
}

/**
 * Собирает кандидата из imageinfo-страницы, если лицензия свободна, тип —
 * растровое изображение и размер достаточен. Иначе null.
 */
export function buildCandidate(
  page: ImageInfoPage,
  distanceM: number | null,
  minWidth = 800,
): WikiCandidate | null {
  const info = page.imageinfo?.[0];
  if (!info?.url) return null;

  const mime = info.mime ?? '';
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null; // без svg/tiff/gif

  const width = info.width ?? 0;
  const height = info.height ?? 0;
  if (width < minWidth) return null;

  const ext = info.extmetadata ?? {};
  const license = stripHtml(ext.LicenseShortName?.value) || stripHtml(ext.License?.value);
  if (!isFreeLicense(ext.License?.value ?? null, ext.LicenseShortName?.value ?? null)) return null;

  return {
    title: page.title ?? '',
    pageId: page.pageid ?? 0,
    distanceM,
    imageUrl: info.url,
    thumbUrl: info.thumburl ?? info.url,
    width,
    height,
    mime,
    author: stripHtml(ext.Artist?.value),
    license: license || 'CC',
    licenseUrl: stripHtml(ext.LicenseUrl?.value),
    descriptionUrl: info.descriptionurl ?? '',
  };
}

async function commonsFetch(params: Record<string, string>): Promise<unknown> {
  const url = `${COMMONS_API}?${new URLSearchParams({ format: 'json', origin: '*', ...params }).toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  return res.json();
}

// ── Public: поиск кандидатов ────────────────────────────────────

export interface SearchOpts {
  radiusM?: number; // радиус geosearch (макс. 10000 по API)
  limit?: number; // сколько кандидатов вернуть
  minWidth?: number;
}

/** Ищет свободные фото рядом с координатой. Возвращает кандидатов для ревью. */
export async function searchCommonsPhotos(
  lat: number,
  lng: number,
  opts: SearchOpts = {},
): Promise<WikiCandidate[]> {
  const radiusM = Math.min(opts.radiusM ?? 3000, 10_000);
  const limit = opts.limit ?? 12;
  const minWidth = opts.minWidth ?? 800;

  const geo = (await commonsFetch({
    action: 'query',
    list: 'geosearch',
    gscoord: `${lat}|${lng}`,
    gsradius: String(radiusM),
    gslimit: '40',
    gsnamespace: '6', // File:
  })) as { query?: { geosearch?: GeosearchHit[] } };

  const hits = geo.query?.geosearch ?? [];
  if (hits.length === 0) return [];

  const distByTitle = new Map<string, number>();
  for (const h of hits) distByTitle.set(h.title, Math.round(h.dist ?? 0));

  // imageinfo батчами до 50 заголовков
  const titles = hits.map((h) => h.title).slice(0, 50);
  const info = (await commonsFetch({
    action: 'query',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|mime',
    iiurlwidth: '480',
    titles: titles.join('|'),
  })) as { query?: { pages?: Record<string, ImageInfoPage> } };

  const pages = Object.values(info.query?.pages ?? {});
  const candidates: WikiCandidate[] = [];
  for (const page of pages) {
    const dist = page.title ? distByTitle.get(page.title) ?? null : null;
    const c = buildCandidate(page, dist, minWidth);
    if (c) candidates.push(c);
  }

  candidates.sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
  return candidates.slice(0, limit);
}

/** Скачивает байты выбранного фото (для последующей обработки sharp). */
export async function downloadPhotoBytes(imageUrl: string): Promise<Buffer> {
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('Пустой файл');
  return buf;
}
