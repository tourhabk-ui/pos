/**
 * Текстовое поле из payload маршрута (JSONB metadata) — с проверкой типа.
 *
 * 13.10, перепись sitemap глазами Googlebot: два маршрута отвечали 500. У
 * обоих `payload.season` — массив, а его читали `as string`: routeFactsLine
 * звал `.toLowerCase()`, generateMetadata падал. Googlebot получал 500, браузер —
 * страницу без title, description и canonical. JSONB несёт строку, массив или
 * что угодно ещё; каст обещает тип, которого никто не проверял (§4: unknown +
 * type guards).
 *
 * Строка — она сама (пустая — null); массив — его строки через запятую (ни
 * одной — null); всё прочее — null, то есть «не записано», а не выдуманное
 * значение.
 */
export function payloadText(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? t : null;
  }
  if (Array.isArray(raw)) {
    const parts = raw
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/** Список строк из payload (фото, месяцы): нестроковые элементы отбрасываются. */
export function payloadStrings(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return out.length ? out : null;
}
