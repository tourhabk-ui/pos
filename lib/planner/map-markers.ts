/**
 * Что рисует карта планировщика и что говорит её легенда — одной функцией,
 * без React и Leaflet, чтобы правило проверялось вызовом (22.10).
 *
 *   • фоновая точка — маршрут под интересы человека, цветом СВОЕЙ зоны из
 *     базы (lib/planner/zone-style); зона не записана — серая;
 *   • при замене дня яркие только точки той же зоны, что у дня, остальные
 *     серые — заменить день маршрутом из другого конца края можно, но это
 *     уже не «рядом». Зона дня — показанная (dayShownZone): у дня, чья зона
 *     не записана, ярких точек нет вовсе;
 *   • день плана — кружок с номером (MapMarker.label), один цвет на все дни,
 *     не совпадающий ни с одной зоной; день, который правят, крупнее;
 *   • дни в ОДНОЙ точке — один пин со всеми номерами («1·7»). Движок ставит
 *     прилёт, отъезд, свободный день, отдых и возвращение в одну точку
 *     Петропавловска (engine.ts, PKC_COORDS), а продолжения многодневного
 *     тура — в точку первого дня. Пины с равными координатами Leaflet
 *     кладёт один на другой: виден последний, номер первого не виден и не
 *     нажимается ни на каком зуме (ревью 22.10: «7» закрывала «1»);
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
  /** Зона дня для логистики плана (всегда одна из четырёх). */
  zone: string;
  /**
   * Зона, которую показывать человеку, если она не равна `zone`: день из
   * маршрута с карты несёт зону маршрута как записана в базе (null — не
   * записана), а `zone` у него — догадка для транспорта. Нет поля — `zone`.
   */
  zoneShown?: string | null;
  coords: [number, number];
}

/**
 * Зона дня, которую видит человек: записанная у маршрута (`zoneShown`), а не
 * угаданная для логистики (`zone`). По ней и подпись пина, и подсветка «та
 * же зона» при замене дня — иначе догадка, убранная из подписи, вернулась бы
 * цветом точек (ревью 22.10, третий круг).
 */
export function dayShownZone(d: Pick<PlannerMapDay, 'zone' | 'zoneShown'>): string | null {
  return d.zoneShown !== undefined ? d.zoneShown : d.zone;
}

/**
 * Id пина дней — по нему клик по карте находит дни в плане. Ключи дней
 * (DayPlan.day, не позиции) через «_»: `day_7`, `day_7_12`.
 */
export function dayPinId(keys: readonly number[]): string {
  return `day_${keys.join('_')}`;
}

/** Ключи дней из id пина; не пин дней — null. */
export function parseDayPinId(id: string): number[] | null {
  const m = /^day_(\d+(?:_\d+)*)$/.exec(id);
  if (!m) return null;
  return m[1].split('_').map(Number);
}

/**
 * Какой день открыть нажатием на пин. Один день — тот же переключатель, что
 * у карточки дня: не открыт — открыть, открыт — закрыть. Несколько дней в
 * точке — по кругу: первый, следующий, после последнего — закрыть.
 */
export function nextDayOnPin(keys: readonly number[], editingDayId: number | null): number | null {
  if (keys.length === 0) return null;
  const at = editingDayId === null ? -1 : keys.indexOf(editingDayId);
  if (at === -1) return keys[0];
  return at + 1 < keys.length ? keys[at + 1] : null;
}

/** Сколько отрезков подписи пина помещается, прежде чем писать «+N». */
const PIN_LABEL_SEGMENTS = 3;

/**
 * Подпись пина по номерам дней (1-based, по возрастанию): «3», «1·7»,
 * подряд от трёх — диапазоном «2–4». Длиннее трёх отрезков — «+N» дней.
 */
export function dayPinLabel(numbers: readonly number[]): string {
  const segments: { text: string; size: number }[] = [];
  let i = 0;
  while (i < numbers.length) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j += 1;
    const run = j - i + 1;
    if (run >= 3) {
      segments.push({ text: `${numbers[i]}–${numbers[j]}`, size: run });
    } else {
      for (let k = i; k <= j; k += 1) segments.push({ text: String(numbers[k]), size: 1 });
    }
    i = j + 1;
  }
  if (segments.length <= PIN_LABEL_SEGMENTS) return segments.map(x => x.text).join('·');
  const shown = segments.slice(0, PIN_LABEL_SEGMENTS - 1);
  const rest = segments.slice(PIN_LABEL_SEGMENTS - 1).reduce((a, x) => a + x.size, 0);
  return `${shown.map(x => x.text).join('·')}·+${rest}`;
}

/**
 * Одна ли это точка на карте. Порог — около 30 м: на 17-м зуме (максимум
 * карты) пин в 28 px покрывает примерно 20 м, и пины ближе этого
 * перекрываются и там. Дальние пины разводит приближение.
 */
const SAME_POINT_LAT = 0.0003;
const SAME_POINT_LNG = 0.0005;

function samePoint(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < SAME_POINT_LAT && Math.abs(a[1] - b[1]) < SAME_POINT_LNG;
}

interface DayPinGroup {
  coords: [number, number];
  /** Ключи дней в порядке плана. */
  keys: number[];
  /** Номера дней 1..n в порядке плана. */
  numbers: number[];
  titles: string[];
  /** Подпись зоны первого дня группы. */
  zoneLabel: string;
}

/** Дни плана, сведённые по точкам: одна точка — один пин. Порядок — по первому дню. */
export function groupDaysByPoint(days: readonly PlannerMapDay[]): DayPinGroup[] {
  const groups: DayPinGroup[] = [];
  days.forEach((d, i) => {
    const g = groups.find(x => samePoint(x.coords, d.coords));
    if (g) {
      g.keys.push(d.day);
      g.numbers.push(i + 1);
      g.titles.push(d.title);
    } else {
      groups.push({
        coords: d.coords, keys: [d.day], numbers: [i + 1], titles: [d.title],
        zoneLabel: zoneName(dayShownZone(d)),
      });
    }
  });
  return groups;
}

/** Сколько фоновых точек той же зоны планировщика, что у дня. */
export function sameZoneCount(routes: readonly PlannerMapRoute[], zone: string | null | undefined): number {
  const z = asPlannerZone(zone);
  if (!z) return 0;
  return routes.filter(r => asPlannerZone(r.zone) === z).length;
}

export const ROUTE_LINE_ID = 'route_line';

export function buildPlannerMarkers(input: {
  routes: readonly PlannerMapRoute[];
  days: readonly PlannerMapDay[];
  editingDayId: number | null;
  /**
   * Можно ли открытый день заменить точкой с карты (lib/planner/plan-ops,
   * replaceRefusal). Нельзя — точки не перекрашиваются: «яркие — та же
   * зона» имеет смысл только там, где точку можно поставить вместо дня.
   */
  editingReplaceable?: boolean;
}): MapMarker[] {
  const { routes, days, editingDayId, editingReplaceable = true } = input;
  const editingDay = editingDayId !== null && editingReplaceable
    ? days.find(d => d.day === editingDayId) ?? null
    : null;
  // Зона показанная, а не угаданная: у дня «Зона не записана» ярких точек нет.
  const editingZone = editingDay ? asPlannerZone(dayShownZone(editingDay)) : null;
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

  // Дни в одной точке — один пин со всеми номерами (см. шапку): иначе
  // верхний пин закрывает нижний целиком, и его день с карты не открыть.
  for (const g of groupDaysByPoint(days)) {
    result.push({
      id: dayPinId(g.keys),
      coords: g.coords,
      title: g.numbers.map((n, k) => `${n}. ${g.titles[k]}`).join(' · '),
      description: g.zoneLabel,
      color: PLAN_DAY_PIN,
      label: dayPinLabel(g.numbers),
      emphasis: editingDayId !== null && g.keys.includes(editingDayId),
      suppressBalloon: true,
    });
  }

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
