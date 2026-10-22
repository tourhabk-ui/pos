/**
 * Что рисует карта планировщика и что говорит её легенда — одной функцией,
 * без React и Leaflet, чтобы правило проверялось вызовом (22.10).
 *
 *   • фоновая точка — маршрут под интересы человека, цветом СВОЕЙ зоны из
 *     базы (lib/planner/zone-style); зона не записана — серая;
 *   • при замене дня яркие только точки той же зоны, что у дня, остальные
 *     серые — заменить день маршрутом из другого конца края можно, но это
 *     уже не «рядом»;
 *   • день плана — кружок с номером (MapMarker.label), один цвет на все дни,
 *     не совпадающий ни с одной зоной; день, который правят, крупнее;
 *   • линия между зонами плана — построение, а не путь (lib/map/line-standard).
 *
 * Легенда собирается из тех же точек и тех же цветов: зона, которой нет на
 * карте, в легенду не попадает, и цвет в легенде — ровно цвет пина.
 */
import type { MapMarker } from '@/components/shared/leaflet-types';
import { connectorLine, CONNECTOR_TITLES } from '@/lib/map/line-standard';
import { markerHex, type MarkerColorName } from '@/lib/map/marker-colors';
import { ZONE_IDS, type ZoneId } from '@/lib/planner/constants';
import {
  asPlannerZone, zonePin, zoneName, zoneShortName,
  NO_ZONE_PIN, PLAN_DAY_PIN, ZONE_NOT_RECORDED, ZONE_OUTSIDE,
} from '@/lib/planner/zone-style';

export interface PlannerMapRoute {
  id: string;
  title: string;
  lat: number;
  lng: number;
  /** Зона из базы как записана; null — не записана. */
  zone: string | null;
}

export interface PlannerMapDay {
  /** Ключ дня в плане (не позиция). */
  day: number;
  title: string;
  zone: string;
  coords: [number, number];
}

/** Id маркера дня — по нему клик по карте находит день в плане. */
export function dayMarkerId(day: number): string {
  return `day_${day}`;
}

export const ROUTE_LINE_ID = 'route_line';

export function buildPlannerMarkers(input: {
  routes: readonly PlannerMapRoute[];
  days: readonly PlannerMapDay[];
  editingDayId: number | null;
}): MapMarker[] {
  const { routes, days, editingDayId } = input;
  const editingDay = editingDayId !== null ? days.find(d => d.day === editingDayId) ?? null : null;
  const editingZone = editingDay ? asPlannerZone(editingDay.zone) : null;
  const result: MapMarker[] = [];

  for (const r of routes) {
    // Замена дня: та же зона — своим цветом, остальные — серые.
    const color: MarkerColorName = editingDay
      ? (editingZone !== null && asPlannerZone(r.zone) === editingZone ? zonePin(r.zone) : NO_ZONE_PIN)
      : zonePin(r.zone);
    result.push({
      id: r.id,
      coords: [r.lat, r.lng],
      title: r.title,
      color,
      suppressBalloon: true,
    });
  }

  days.forEach((d, i) => {
    result.push({
      id: dayMarkerId(d.day),
      coords: d.coords,
      title: `${i + 1}. ${d.title}`,
      description: zoneName(d.zone),
      color: PLAN_DAY_PIN,
      label: String(i + 1),
      emphasis: d.day === editingDayId,
      suppressBalloon: true,
    });
  });

  // Линия между днями плана — ПОСТРОЕНИЕ, а не путь (lib/map/line-standard).
  // Она соединяет центры зон, между которыми бывает триста километров и
  // хребет. Сплошная оранжевая под словом «Маршрут» читалась как проход:
  // и вид, и подпись обещали то, чего никто не снимал.
  const seen = new Set<string>();
  const zoneOrder: PlannerMapDay[] = [];
  for (const d of days) {
    if (!seen.has(d.zone)) { seen.add(d.zone); zoneOrder.push(d); }
  }
  if (zoneOrder.length >= 2) {
    result.push({
      id: ROUTE_LINE_ID,
      coords: zoneOrder[0].coords,
      title: CONNECTOR_TITLES.planOrder,
      geometry: { type: 'polyline', coordinates: zoneOrder.map(d => d.coords), ...connectorLine() },
      // Держатель линии, не место: без флага LeafletMap ставил под кружок
      // первого дня ещё и синий пин без смысла (виден на снимке 22.10).
      geometryOnly: true,
    });
  }

  return result;
}

export interface LegendEntry {
  /** Зона планировщика; null — серая строка «без зоны». */
  zone: ZoneId | null;
  name: string;
  /** Hex пина этой строки — ровно тот, каким нарисованы её точки. */
  hex: string;
  count: number;
}

/**
 * Легенда фоновых точек: только зоны, которые реально нарисованы, в порядке
 * зон движка, и серая строка в конце, если есть точки без зоны планировщика.
 */
export function plannerLegend(routes: readonly PlannerMapRoute[]): LegendEntry[] {
  const counts = new Map<ZoneId, number>();
  let notRecorded = 0;
  let outside = 0;
  for (const r of routes) {
    const z = asPlannerZone(r.zone);
    if (z) counts.set(z, (counts.get(z) ?? 0) + 1);
    else if (typeof r.zone === 'string' && r.zone.trim() !== '') outside += 1;
    else notRecorded += 1;
  }
  const entries: LegendEntry[] = [];
  for (const z of ZONE_IDS) {
    const n = counts.get(z);
    if (n) entries.push({ zone: z, name: zoneShortName(z), hex: markerHex(zonePin(z)), count: n });
  }
  if (notRecorded + outside > 0) {
    const name = outside === 0 ? ZONE_NOT_RECORDED
      : notRecorded === 0 ? ZONE_OUTSIDE
      : `${ZONE_OUTSIDE} или не записана`;
    entries.push({ zone: null, name, hex: markerHex(NO_ZONE_PIN), count: notRecorded + outside });
  }
  return entries;
}
