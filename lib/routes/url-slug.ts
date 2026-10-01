/**
 * ЧПУ записи каталога для ссылки на карточку.
 *
 * Каталог читает VIEW agent_route_knowledge, а в нём ЧПУ нет — он живёт в
 * мастер-таблицах. Поэтому карточки каталога, подборок и категорий ссылались
 * по UUID, а карточка отвечала на UUID редиректом 308 на ЧПУ. Аудит 01.10:
 * 477 внутренних адресов с редиректом, 372 из них — /places/<uuid>, 102 —
 * /routes/<uuid>. Поисковику каждый такой адрес — лишний шаг и второй адрес
 * одной страницы.
 *
 * Поле `slug` у CatalogItem — НЕ адрес, а ключ дедупликации
 * (route_dedupe_key); адрес отдаётся отдельным полем `urlSlug`.
 */

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL-выражение ЧПУ для строки VIEW: у места — places.slug (по ark_id), у
 * маршрута — kamchatka_routes.slug (id VIEW = COALESCE(ark_id, id)). NULL —
 * ЧПУ нет, ссылка остаётся по id.
 */
export function arkUrlSlugSql(arkAlias: string): string {
  if (!ALIAS_RE.test(arkAlias)) throw new Error(`arkUrlSlugSql: недопустимый псевдоним ${arkAlias}`);
  return `CASE ${arkAlias}.kind
      WHEN 'place' THEN (SELECT us_p.slug FROM places us_p WHERE us_p.ark_id = ${arkAlias}.id LIMIT 1)
      WHEN 'route' THEN (SELECT us_r.slug FROM kamchatka_routes us_r
                          WHERE us_r.id = ${arkAlias}.id OR us_r.ark_id = ${arkAlias}.id LIMIT 1)
    END`;
}

/**
 * Адрес карточки записи каталога: ЧПУ, если он есть, иначе id. Раздел — по
 * роду записи: место на /places, маршрут на /routes. Род не известен —
 * раздел вызывающего (как было до 01.10): ЧПУ места под /routes отвечал бы
 * тем же редиректом, от которого здесь и уходим.
 */
export function catalogHref(
  item: { id: string; kind?: string | null; urlSlug?: string | null },
  fallback: '/places' | '/routes',
): string {
  const base = item.kind === 'route' ? '/routes' : item.kind === 'place' ? '/places' : fallback;
  // Без рода ЧПУ не подставляется: какой раздел его примет, неизвестно.
  const tail = item.kind === 'route' || item.kind === 'place' ? (item.urlSlug ?? item.id) : item.id;
  return `${base}/${tail}`;
}
