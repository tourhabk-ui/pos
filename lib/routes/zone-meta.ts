/**
 * Зоны Камчатки для зонных срезов каталога (/routes/[category]/[zone]).
 * Административных районов в данных НЕТ — есть поле zone из safety-слоя;
 * называем зоны честно зонами, не выдумывая «районы».
 */

export interface ZonePageMeta {
  slug: string;
  name: string;
}

export const ZONE_PAGES: Record<string, ZonePageMeta> = {
  avachinsky: { slug: 'avachinsky', name: 'Авачинская зона' },
  western:    { slug: 'western',    name: 'Западная Камчатка' },
  eastern:    { slug: 'eastern',    name: 'Восточная Камчатка' },
  northern:   { slug: 'northern',   name: 'Северная Камчатка' },
};

export const ZONE_SLUGS = Object.keys(ZONE_PAGES);

/**
 * Метки района, которые срез каталога читает как одну из четырёх зон.
 *
 * Корякский округ — это север Камчатки. С 16.10 у его мест своя метка района
 * (миграция 1299): по ней их находят тревоги, и сводки Мильково за 500 км к
 * ним больше не идут. Но витрина группирует по географии, а не по охвату
 * тревог: без псевдонима «Вулканы: Северная Камчатка» потеряли бы Срединный
 * хребет Тигиля, а тонкий срез ушёл бы в 404 с уже проиндексированным
 * адресом. Северные Курилы — Сахалинская область: в срезы Камчатки не
 * попадают, как и Командоры.
 */
export const CATALOG_ZONE_ALIASES: Readonly<Record<string, string>> = { krai_koryak: 'northern' };

/** Зона среза для одной записи — пара к catalogZoneSql. */
export function catalogZoneOf(zone: string | null | undefined): string | null {
  const z = zone?.trim();
  if (!z) return null;
  return CATALOG_ZONE_ALIASES[z] ?? z;
}

/** Зона среза в SQL: та же замена меток, что catalogZoneOf. `col` — имя колонки из кода, не ввод. */
export function catalogZoneSql(col: string): string {
  const whens = Object.entries(CATALOG_ZONE_ALIASES).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(' ');
  return `(CASE ${col} ${whens} ELSE ${col} END)`;
}

/** Жёсткое правило против индексного мусора: страница живёт только при ≥3 объектах */
export const MIN_ITEMS_FOR_PAGE = 3;
