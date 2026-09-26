/**
 * Подъезд к маршруту по дорогам общего пользования (26.09).
 *
 * Владелец на экране «На маршруте» (Петропавловск → «Авачинский вулкан: путь
 * на вершину», 30.9 км до линии): «мы же решили, что трек по дороге общего
 * пользования». На карте был пунктир по азимуту через хребты — прямая от
 * человека до ближайшей точки тропы. Роутер по дорожному графу при этом
 * существовал (`/api/routing/path`, `roadGraphCarProvider`), и его описание
 * прямо называет отрезок «от меня до старта тропы», — но экран поля его ни
 * разу не звал. Механизм был объявлен и не подключён (§10.09).
 *
 * Правило: человек в стороне от маршрута дальше ROAD_APPROACH_MIN_KM и сеть
 * есть — просим у роутера путь на машине до СТАРТА маршрута (туда, где тропа
 * начинается от дороги, а не до ближайшей к человеку точки линии, которая на
 * вулкане может оказаться серединой склона). Нашёлся — рисуется рассчитанным
 * автопутём (стандарт calculatedCarLine), а от конца дороги до старта, если
 * дорога до него не дотягивает, — пунктиром построения. Не нашёлся, сети нет,
 * роутер отказал — остаётся прямая по азимуту с подписью «по прямой»: это
 * третье состояние, а не «пути нет».
 */
import type { CalculatedCarRoute } from '@/lib/on-route/calculated-route';

/**
 * Ближе этого подъезд по дорогам не просим: пара километров до линии — это
 * выход на тропу пешком, а не поездка, и роутер здесь дал бы крюк по городу.
 */
export const ROAD_APPROACH_MIN_KM = 2;

/**
 * Разрыв «конец дороги → старт маршрута», начиная с которого его рисуют
 * пунктиром. Меньше — это точность привязки к графу, а не отрезок пути.
 */
export const TRAILHEAD_GAP_DRAW_M = 150;

export function wantsRoadApproach(p: { offTrack: boolean; approachKm: number | null; offline: boolean; hasStart: boolean }): boolean {
  return p.offTrack && !p.offline && p.hasStart && p.approachKm != null && p.approachKm >= ROAD_APPROACH_MIN_KM;
}

/**
 * Ключ запроса: маршрут и положение, огрублённое до сотых градуса (~1 км).
 * Пока человек в пределах километра, путь не перезапрашивается — иначе роутер
 * звали бы на каждом шаге.
 */
export function roadApproachKey(routeKey: string, lat: number, lng: number): string {
  return `${routeKey}|${Math.round(lat * 100) / 100}|${Math.round(lng * 100) / 100}`;
}

/** Путь годится для карты: сервер разрешил показ и геометрия — линия. */
export function displayableRoadApproach(r: CalculatedCarRoute | null | undefined): CalculatedCarRoute | null {
  if (!r || !r.mayDisplay) return null;
  if (r.geometry.type !== 'LineString' || r.geometry.coordinates.length < 2) return null;
  return r;
}

/**
 * Разрыв от конца дороги до старта маршрута, [lat, lng] обоих концов — или
 * null, если дорога подходит к старту ближе порога.
 */
export function trailheadGap(
  r: CalculatedCarRoute,
  start: [number, number],
): { from: [number, number]; to: [number, number]; meters: number } | null {
  const meters = r.destinationSnapped.snapDistanceM;
  if (!(meters > TRAILHEAD_GAP_DRAW_M)) return null;
  const [lng, lat] = r.geometry.coordinates[r.geometry.coordinates.length - 1];
  return { from: [lat, lng], to: start, meters };
}
