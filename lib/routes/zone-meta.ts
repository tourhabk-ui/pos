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

/** Жёсткое правило против индексного мусора: страница живёт только при ≥3 объектах */
export const MIN_ITEMS_FOR_PAGE = 3;
