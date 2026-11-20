/**
 * Дата последней правки записи — для видимой строки и `dateModified` в
 * JSON-LD (SEO-аудит 20.11.2026: dateModified не было на 1067 из 1098
 * страниц; видимая дата — у 7).
 *
 * ── Откуда дата ───────────────────────────────────────────────────────────
 *
 * Только из поля `updated_at` самой записи (места, маршрута, тура, статьи).
 * Дату сборки, «сегодня» или время запроса сюда не подставляем: поисковик,
 * которому каждый день говорят «изменено сегодня», перестаёт верить датам
 * сайта (аудит 01.10). Поля нет или оно не читается как дата — нет ни
 * строки, ни `dateModified`.
 *
 * ── Почему «Последняя правка записи», а не «Обновлено» ────────────────────
 *
 * `updated_at` двигает любая правка записи — фото, координата, заметка, — а
 * не проверка сведений. «Обновлено» читалось как «сведения свежие», и
 * 15.10 подпись карточки места заменена на «Последняя правка записи»
 * (components/places/PlaceFooter). Та же подпись — на всех типах.
 *
 * ── Почему отдельный узел WebPage ────────────────────────────────────────
 *
 * `dateModified` — свойство CreativeWork. TouristAttraction (Place) и
 * TouristTrip (Trip) — не CreativeWork, у них этого свойства нет, и
 * валидатор его отбросит. Дату несёт страница: узел `WebPage` с
 * `mainEntity` → сущность карточки.
 */

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Камчатка — UTC+12 круглый год (переход на летнее время отменён в 2011). */
const KAMCHATKA_OFFSET_MS = 12 * 60 * 60 * 1000;

/** Значение поля → Date или null (нет, пусто, не дата). */
export function parseRecordDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 8601 (UTC) для `dateModified` и `<time dateTime>`; null — даты нет. */
export function recordDateIso(value: string | Date | null | undefined): string | null {
  return parseRecordDate(value)?.toISOString() ?? null;
}

/**
 * «14 октября 2026» по камчатскому календарю. Без Intl: строка одинакова на
 * сервере и в браузере при любой локали и ICU — иначе гидратация разъедется
 * (toLocaleDateString в Node и в браузере даёт «… г.» не везде одинаково).
 */
export function formatRecordDate(value: string | Date | null | undefined): string | null {
  const d = parseRecordDate(value);
  if (!d) return null;
  const k = new Date(d.getTime() + KAMCHATKA_OFFSET_MS);
  return `${k.getUTCDate()} ${MONTHS_GENITIVE[k.getUTCMonth()]} ${k.getUTCFullYear()}`;
}

export interface WebPageModifiedInput {
  /** Абсолютный канонический адрес страницы. */
  url: string;
  name: string;
  dateModified: string | Date | null | undefined;
  /** `@id` сущности карточки (TouristAttraction, TouristTrip…), если он есть. */
  mainEntityId?: string | null;
}

/** Узел WebPage с dateModified; null — даты нет, узел не нужен. */
export function webPageModifiedJsonLd(input: WebPageModifiedInput): Record<string, unknown> | null {
  const iso = recordDateIso(input.dateModified);
  if (!iso) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${input.url}#webpage`,
    url: input.url,
    name: input.name,
    inLanguage: 'ru',
    dateModified: iso,
    ...(input.mainEntityId ? { mainEntity: { '@id': input.mainEntityId } } : {}),
  };
}
