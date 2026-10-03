/**
 * lib/on-route/calculated-remaining.ts — сколько осталось ПО ПОСЧИТАННОМУ
 * ПУТИ, а не по прямой.
 *
 * Скрин владельца 03.10 («Дикие озерки»): на карте синий путь петлёй по
 * дорогам, а главная цифра листа — «1.9 км до цели, ~44 мин». 1.9 км — это
 * прямая от телефона до цели, 44 минуты — время ВСЕГО пути от провайдера.
 * Два числа из разных мерок на одном экране, и крупное из них — меньшее:
 * «расстояние от точки до точки правильное, но сам маршрут намного больше,
 * и это вводит в заблуждение — человек может не рассчитать силы».
 *
 * Правило: главная цифра — остаток вдоль линии пути от места, где человек на
 * неё выходит, плюс подход к линии по прямой, если человек в стороне. Время —
 * та же доля от durationS провайдера, что и оставшаяся доля линии: число
 * провайдера остаётся единственным источником темпа (хожалый темп к
 * автопути не относится), но больше не описывает уже пройденное.
 *
 * Длина линии считается в мерке провайдера (`distanceM`): геометрия приходит
 * прореженной и её собственная длина меньше настоящей — мерить по ней значило
 * бы снова занизить остаток.
 */
import { calculatedCarToLeafletCoordinates, type CalculatedCarRoute } from './calculated-route';
import { projectOnTrack, straightKm, type GeoPoint } from './approach';

export interface CalculatedRemaining {
  /** До цели: подход к линии по прямой + остаток вдоль линии, км. */
  remainingKm: number;
  /** На сколько человек в стороне от линии пути, км. */
  offRouteKm: number;
  /** Остаток вдоль линии от точки выхода на неё, км (в мерке провайдера). */
  alongKm: number;
  /** Доля линии, которая ещё впереди, 0..1 — по ней режется время. */
  fractionAhead: number;
}

/**
 * Остаток посчитанного пути от положения `pos`. `null` — геометрия битая или
 * положения нет: тогда цифры нет вовсе, а не прямая вместо неё (§4.0).
 */
export function calculatedRemaining(
  route: Pick<CalculatedCarRoute, 'geometry' | 'distanceM'>,
  pos: GeoPoint | null,
): CalculatedRemaining | null {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return null;
  const coords = calculatedCarToLeafletCoordinates(route);
  if (!coords) return null;
  const line: GeoPoint[] = coords.map(([lat, lng]) => ({ lat, lng }));

  let lineKm = 0;
  for (let i = 1; i < line.length; i++) lineKm += straightKm(line[i - 1], line[i]);
  if (!(lineKm > 0)) return null;

  const pr = projectOnTrack(pos, line);
  if (!pr) return null;

  let doneKm = 0;
  for (let i = 0; i < pr.segment; i++) doneKm += straightKm(line[i], line[i + 1]);
  doneKm += straightKm(line[pr.segment], pr.point);

  const fractionAhead = Math.min(1, Math.max(0, (lineKm - doneKm) / lineKm));
  // Мерка провайдера — настоящая длина пути; своя длина ломаной — запас,
  // если провайдер её не назвал.
  const providerKm = Number.isFinite(route.distanceM) && route.distanceM > 0
    ? route.distanceM / 1000
    : lineKm;
  const alongKm = providerKm * fractionAhead;

  return {
    remainingKm: alongKm + pr.offTrackKm,
    offRouteKm: pr.offTrackKm,
    alongKm,
    fractionAhead,
  };
}
