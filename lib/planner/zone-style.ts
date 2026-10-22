/**
 * Зона планировщика на карте и в плане: цвет пина и имя словами — ОДИН
 * источник (22.10).
 *
 * ── Что было ────────────────────────────────────────────────────────────
 *
 * Владелец 22.10 со скрином /planner на телефоне: «как работает карта в
 * Планировщике не пойму?». Зоне отвечали пять словарей, и они расходились:
 *
 *   • фоновые точки красились именами значков Яндекс-карт («оранжевая точка»)
 *     в поле `preset`, которого LeafletMap не читал, — все точки выходили
 *     синими;
 *   • плашка обещала четыре цвета зон кружками токенов темы, а `--accent`
 *     синий в светлой теме и оранжевый в тёмной;
 *   • подписи зон в плане («Мильковская — озёра и рыбалка», «Тигильская —
 *     гейзеры и север») спорили с движком и базой: Мильковский округ база
 *     относит к северной зоне, Долину гейзеров — к восточной (1294, 1296).
 *
 * ── Правило ─────────────────────────────────────────────────────────────
 *
 * Имя зоны — то, которым называет её движок (`ZONE_NAMES`). Цвет — имя из
 * таблицы пинов (lib/map/marker-colors): пин рисуется им, легенда и кружки
 * плана берут hex оттуда же — один цвет в обеих темах. Синего и красного
 * среди зон нет: синий — день плана, красный — опасность.
 *
 * Чего не знаем — так и говорим (§4.0): зона не записана — серый пин и
 * «Зона не записана», а не угаданная по расстоянию до центра зоны.
 */
import { ZONE_IDS, ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';
import { markerHex, type MarkerColorName } from '@/lib/map/marker-colors';

/** Цвет пина зоны. Без синего (день плана) и красного (опасность). */
export const ZONE_PIN: Record<ZoneId, MarkerColorName> = {
  avachinsky: 'darkOrange',
  western:    'purple',
  eastern:    'darkCyan',
  northern:   'darkGreen',
};

/** Серый — нет зоны планировщика (не записана или район вне четырёх зон) и «другая зона» при замене дня. */
export const NO_ZONE_PIN: MarkerColorName = 'gray';

/** День плана на карте — кружок с номером этим цветом; ни одна зона его не носит. */
export const PLAN_DAY_PIN: MarkerColorName = 'darkBlue';

export const ZONE_NOT_RECORDED = 'Зона не записана';
export const ZONE_OUTSIDE = 'Вне четырёх зон';

/** Строка из базы → одна из четырёх зон планировщика, иначе null. */
export function asPlannerZone(zone: unknown): ZoneId | null {
  return typeof zone === 'string' && (ZONE_IDS as readonly string[]).includes(zone) ? zone as ZoneId : null;
}

/** Короткое имя для легенды: «Авачинская» (полное — «Авачинская зона»). */
export function zoneShortName(zone: ZoneId): string {
  return ZONE_NAMES[zone].replace(/\s+зона$/, '');
}

/**
 * Имя зоны словами. Три исхода: зона планировщика — её имя; записан другой
 * район (Корякский округ, Северные Курилы) — «Вне четырёх зон»; ничего —
 * «Зона не записана».
 */
export function zoneName(zone: string | null | undefined): string {
  const z = asPlannerZone(zone);
  if (z) return ZONE_NAMES[z];
  return typeof zone === 'string' && zone.trim() !== '' ? ZONE_OUTSIDE : ZONE_NOT_RECORDED;
}

/** Имя цвета пина для зоны; без зоны планировщика — серый. */
export function zonePin(zone: string | null | undefined): MarkerColorName {
  const z = asPlannerZone(zone);
  return z ? ZONE_PIN[z] : NO_ZONE_PIN;
}

/** Hex того же цвета, каким нарисован пин зоны, — для легенды и кружков плана. */
export function zoneHex(zone: string | null | undefined): string {
  return markerHex(zonePin(zone));
}

/** Hex кружка дня плана — как его пин на карте. */
export function planDayHex(): string {
  return markerHex(PLAN_DAY_PIN);
}
