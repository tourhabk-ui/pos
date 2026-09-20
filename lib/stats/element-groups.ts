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

/**
 * ── `kind=place` в адресе обязателен (20.09) ──────────────────────────────
 *
 * Владелец: «с главной сложно попасть на страницу мест». Оказалось хуже:
 * попасть было НЕЛЬЗЯ.
 *
 * Адрес стихии был `/routes?location_type=volcano`, без рода. А род на
 * витрине умолчанием — МАРШРУТЫ (`app/routes/page.tsx`), и фильтр по типу
 * места при маршрутах отбрасывается обеими сторонами по построению:
 * сервер — `kind === 'place' ? location_type : ''`, клиент —
 * `if (kind === 'place' && locationType)`.
 *
 * То есть все пять плиток «Стихии» на главной вели в ОДНО место: полный
 * список маршрутов без единого фильтра. Плитка обещала «Огонь — вулканы и
 * мощь земли», человек получал всё подряд, и ни одна ссылка главной не
 * доходила до мест вовсе — раздел был достижим только с карточки уже
 * открытого места («← Все места»).
 *
 * Отсюда правило: ссылка с `location_type` без `kind=place` — мёртвая.
 * Держит сторож `tests/unit/platform-counts.test.ts`, и он же проверяет
 * репозиторий целиком, а не только этот файл: копия такого адреса руками
 * повторила бы ровно ту же тишину.
 */
export const ELEMENT_GROUPS: ElementGroup[] = [
  { key: 'fire',   label: 'Огонь',   types: ['volcano'],                          href: '/routes?kind=place&location_type=volcano',    color: '#C24C3D' },
  { key: 'snow',   label: 'Снег',    types: ['mountain', 'glacier'],              href: '/routes?kind=place&location_type=mountain',   color: '#8FB8D8' },
  { key: 'ocean',  label: 'Океан',   types: ['bay', 'cape', 'island', 'beach'],   href: '/routes?kind=place&location_type=bay',        color: '#38B6D8' },
  { key: 'therm',  label: 'Термы',   types: ['hot_spring', 'geyser', 'thermal'],  href: '/routes?kind=place&location_type=hot_spring', color: '#E8842C' },
  { key: 'nature', label: 'Природа', types: ['lake', 'river', 'waterfall', 'forest'], href: '/routes?kind=place&location_type=lake',   color: '#3E9B5F' },
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
 * Типы вне «стихий» — считаются в общем числе локаций, но плиткой не
 * показываются. Каждый реальный location_type ОБЯЗАН быть здесь ИЛИ в
 * ELEMENT_GROUPS.
 *
 * ── Четыре типа рельефа пришли 19.09 ──────────────────────────────────────
 *
 * Словарь типов был сведён из пяти копий (lib/places/location-types.ts), и
 * стало известно на четыре типа больше: `park`, `pass`, `plateau`, `valley`.
 * До сведения они не были «исключены» — они были НЕВИДИМЫ: ни одна копия их
 * не знала, а `groupPlacesByElement` складывал их в `unmappedTypes`, то есть
 * места этих типов не попадали ни в счёт стихий, ни в счёт исключённых.
 * Сумма на главной не сходилась молча.
 *
 * Здесь они попадают в исключения, и причина у каждого своя — не
 * «антропогенные», как у музея с посёлком:
 *
 *   park    — природный парк это ТЕРРИТОРИЯ, внутри которой есть и вулканы,
 *             и реки, и термы. Он не одна стихия по построению;
 *   pass,
 *   plateau,
 *   valley,
 *   cave    — это форма РЕЛЬЕФА, а не стихия. Какая стихия у конкретной
 *             долины, видно только по самому месту: Долина гейзеров — термы,
 *             речная долина — природа. Раскидать их по имени типа значило бы
 *             выдумать счёт на главной.
 *
 * Отсюда правило: это «не знаю» (§4.0), а не приговор. Появится разметка по
 * местам — тип переедет в свою стихию, и список исключений сократится.
 */
export const EXCLUDED_TYPES: readonly string[] = [
  'viewpoint', 'settlement', 'museum', 'historical', 'rock', 'other',
  'park', 'pass', 'plateau', 'valley', 'cave',
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

/**
 * href стихии по её ключу — для BentoSection (десктоп ведёт как мобайл).
 *
 * Запасной адрес — витрина МЕСТ, а не общая `/routes`: у неизвестного ключа
 * стихии всё равно спрашивают места, и умолчание `/routes` уводило бы в
 * маршруты — тот же обрыв, что чинится выше, только тише.
 */
export function elementHref(key: string): string {
  return ELEMENT_GROUPS.find((g) => g.key === key)?.href ?? '/routes?kind=place';
}

/** Все объявленные в стихиях типы — для проверки на фантомы в тесте. */
export function allElementTypes(): string[] {
  return ELEMENT_GROUPS.flatMap((g) => g.types);
}

/** Известные location_type (ключи справочника меток) — источник правды для guard-теста. */
export function knownLocationTypes(): string[] {
  return Object.keys(LOCATION_TYPE_LABELS);
}
