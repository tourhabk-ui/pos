/**
 * lib/stats/element-groups.ts
 *
 * ЕДИНЫЙ маппинг «стихий» Камчатки → location_type. Один источник для десктопа
 * (BentoSection) и мобайла (главная v8 «Стихии») — раньше одна стихия вела в
 * РАЗНЫЕ фильтры (Снег: category=snegohod vs location_type=mountain).
 *
 * Инвариант (guard-тест): каждый ключ LOCATION_TYPE_LABELS покрыт РОВНО одной
 * стихией XOR входит в EXCLUDED_TYPES. Ни фантомных типов (которых нет в БД),
 * ни осиротевших (реальных, но не попавших никуда).
 */

import { LOCATION_TYPE_LABELS } from '@/components/places/types';

export interface ElementGroup {
  key: string;
  label: string;
  /** location_type значения; первый — primary (задаёт href) */
  types: string[];
  href: string;
  /** Цвет стихии (hex) — карточки мест, линии горизонта, пеленг */
  color: string;
}

export const ELEMENT_GROUPS: ElementGroup[] = [
  { key: 'fire',   label: 'Огонь',   types: ['volcano'],                          href: '/routes?location_type=volcano',    color: '#C24C3D' },
  { key: 'snow',   label: 'Снег',    types: ['mountain', 'glacier'],              href: '/routes?location_type=mountain',   color: '#8FB8D8' },
  { key: 'ocean',  label: 'Океан',   types: ['bay', 'cape', 'island', 'beach'],   href: '/routes?location_type=bay',        color: '#38B6D8' },
  { key: 'therm',  label: 'Термы',   types: ['hot_spring', 'geyser', 'thermal'],  href: '/routes?location_type=hot_spring', color: '#E8842C' },
  { key: 'nature', label: 'Природа', types: ['lake', 'river', 'waterfall', 'forest'], href: '/routes?location_type=lake',   color: '#3E9B5F' },
];

/** Нейтраль для типов вне стихий (EXCLUDED: музеи, посёлки, скалы...) */
export const NEUTRAL_ELEMENT_COLOR = '#8B96AB';

/**
 * Стихия по location_type. null — тип вне стихий (или неизвестен): вызывающий
 * код берёт NEUTRAL_ELEMENT_COLOR. «Защита/Безопасность» стихией не является
 * и сюда не маппится никогда.
 */
export function getElementForType(
  locationType: string | null | undefined,
): { key: string; label: string; color: string; href: string } | null {
  if (!locationType) return null;
  const g = ELEMENT_GROUPS.find((el) => el.types.includes(locationType));
  return g ? { key: g.key, label: g.label, color: g.color, href: g.href } : null;
}

/**
 * Типы, не относящиеся к «стихиям» (антропогенные/служебные) — считаются в
 * общем числе локаций, но плиткой не показываются. Каждый реальный
 * location_type ОБЯЗАН быть здесь ИЛИ в ELEMENT_GROUPS.
 */
export const EXCLUDED_TYPES: readonly string[] = [
  'viewpoint', 'settlement', 'museum', 'historical', 'rock', 'other',
];

export interface ElementCount { key: string; label: string; count: number; href: string; }

/**
 * Группирует счётчики мест по стихиям. Чистая функция — тестируется без сети.
 * `unmappedTypes` — типы, которые не попали ни в стихию, ни в EXCLUDED
 * (сигнал рассинхрона; guard-тест держит его пустым).
 */
export function groupPlacesByElement(byType: Record<string, number>): {
  elements: ElementCount[];
  excludedCount: number;
  unmappedTypes: string[];
} {
  const mapped = new Set<string>();
  const elements: ElementCount[] = ELEMENT_GROUPS.map((g) => {
    let count = 0;
    for (const t of g.types) { count += byType[t] ?? 0; mapped.add(t); }
    return { key: g.key, label: g.label, count, href: g.href };
  }).filter((e) => e.count > 0);

  const excluded = new Set(EXCLUDED_TYPES);
  let excludedCount = 0;
  const unmappedTypes: string[] = [];
  for (const [t, n] of Object.entries(byType)) {
    if (mapped.has(t)) continue;
    if (excluded.has(t)) { excludedCount += n; continue; }
    unmappedTypes.push(t);
  }
  return { elements, excludedCount, unmappedTypes };
}

/** href стихии по её ключу — для BentoSection (десктоп ведёт как мобайл). */
export function elementHref(key: string): string {
  return ELEMENT_GROUPS.find((g) => g.key === key)?.href ?? '/routes';
}

/** Все объявленные в стихиях типы — для проверки на фантомы в тесте. */
export function allElementTypes(): string[] {
  return ELEMENT_GROUPS.flatMap((g) => g.types);
}

/** Известные location_type (ключи справочника меток) — источник правды для guard-теста. */
export function knownLocationTypes(): string[] {
  return Object.keys(LOCATION_TYPE_LABELS);
}
