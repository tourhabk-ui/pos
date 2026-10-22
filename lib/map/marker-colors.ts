/**
 * Цвета пинов Leaflet-карты — одна таблица на карту и на её легенду.
 *
 * Жила внутри components/shared/LeafletMap.tsx (`COLOR_MAP`) и была закрыта
 * от остальных. Поэтому легенда планировщика рисовала свои кружки токенами
 * темы (`var(--accent)` и т.д.), а пины — этой таблицей: в светлой теме
 * «оранжевая» зона на легенде выходила синей, а на карте все точки и вовсе
 * были синими (22.10, скрин владельца: «как работает карта в Планировщике не
 * пойму?»). Легенда обязана показывать ТОТ ЖЕ цвет, каким нарисован пин, —
 * значит, обе стороны берут его отсюда.
 *
 * Токены темы здесь не годятся: цвет уходит в атрибут `fill` SVG и в
 * инлайн-стиль divIcon, где `var(--…)` меняется вместе с темой, а пин на
 * карте — нет.
 */

export const MARKER_HEX = {
  red:       '#DC2626',
  blue:      '#2568B0',
  green:     '#3FB950',
  orange:    '#D44A0C',
  purple:    '#8B5CF6',
  darkBlue:  '#1E40AF',
  darkCyan:  '#0891B2',
  lightBlue: '#38BDF8',
  darkGreen: '#15803D',
  teal:      '#0D9488',
  brown:     '#92400E',
  gray:      '#6B7280',
  darkOrange:'#C2410C',
  cyan:      '#06B6D4',
} as const;

export type MarkerColorName = keyof typeof MARKER_HEX;

/** Имя цвета из таблицы → hex. */
export function markerHex(name: MarkerColorName): string {
  return MARKER_HEX[name];
}

function isMarkerColorName(value: string): value is MarkerColorName {
  return Object.prototype.hasOwnProperty.call(MARKER_HEX, value);
}

/**
 * Цвет маркера/линии — из таблицы по имени либо хекс как есть.
 *
 * `lib/map/line-standard.ts` (`trackLine()`/`connectorLine()`) отдаёт цвет
 * УЖЕ хексом (`#4ade80`, `#9A9590` — §12 «линия называет своё
 * происхождение»). Прежний код искал этот хекс в таблице как ключ, не
 * находил и всегда откатывался на дефолт: набросок и снятый трек, зелёный и
 * серый по стандарту, рисовались одинаковым teal — стандарт был мёртв на
 * каждом экране, который через LeafletMap его применял (карточка маршрута,
 * планер, паспорт маршрута).
 */
export function resolveMarkerColor(color: string | undefined | null, fallback: MarkerColorName): string {
  if (color) {
    if (color.startsWith('#')) return color;
    if (isMarkerColorName(color)) return MARKER_HEX[color];
  }
  return MARKER_HEX[fallback];
}
