/**
 * Имя файла GPX в заголовке Content-Disposition.
 *
 * ── Почему кнопка «Скачать GPX» отдавала 500 (аудит 20.11.2026) ───────────
 *
 * Имя файла собиралось из названия маршрута и оставляло кириллицу:
 * `attachment; filename="гейзеры_камчатки.gpx"`. Значения HTTP-заголовков —
 * строки байтов (ByteString): Headers в Node/undici бросает TypeError
 * «Cannot convert argument to a ByteString… value greater than 255» на любом
 * символе дальше Latin-1. Исключение ловил общий catch роута, и наружу
 * уходило `{"error":"Internal server error"}` — на всех маршрутах с русским
 * названием, то есть почти на всех (~302 страницы с кнопкой).
 *
 * Теперь по RFC 6266 / RFC 5987: `filename` — ASCII-запасное имя
 * (транслит), `filename*` — настоящее имя в UTF-8 percent-encoding.
 * Браузеры берут `filename*`, старые клиенты — `filename`.
 */
import { slugify } from '@/lib/text/slugify';

const MAX_NAME = 60;

/** ASCII-имя без расширения: транслит названия, иначе `route-<id8>`. */
export function gpxAsciiBase(title: string | null | undefined, id: string): string {
  const base = slugify(title ?? '').replace(/[^a-z0-9-]/g, '').slice(0, MAX_NAME).replace(/-+$/, '');
  return base || `route-${id.slice(0, 8)}`;
}

/** Имя в UTF-8 для `filename*`: название как есть, без символов, ломающих путь. */
export function gpxUnicodeBase(title: string | null | undefined): string {
  return (title ?? '')
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

export function gpxContentDisposition(title: string | null | undefined, id: string): string {
  const ascii = `${gpxAsciiBase(title, id)}.gpx`;
  const unicode = gpxUnicodeBase(title);
  if (!unicode) return `attachment; filename="${ascii}"`;
  const encoded = encodeURIComponent(`${unicode}.gpx`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
