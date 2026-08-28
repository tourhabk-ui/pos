/**
 * lib/on-route/route-provider.ts — контракт автомобильного маршрутизатора
 * (владелец 28.08, PR 5B-1: инфраструктура + продолжение с нормализованным
 * found/not_found).
 *
 * Владелец зафиксировал для первого релиза: car — да, foot — только по
 * известной сети (5B-2, отдельно), внешний онлайн-маршрутизатор — только
 * через серверный адаптер (ключ не в браузере). Источник самого
 * маршрутизатора при этом ОСТАЁТСЯ НЕРЕШЁННЫМ: региональный тест 28.08
 * (публичный демо-OSRM, реальные координаты Камчатки) зафиксировал
 * НОРМАЛИЗОВАННУЮ форму ответа (lib/on-route/calculated-route.ts), но не
 * выбрал конкретного поставщика — тот выбирается bake-off'ом на 20-30
 * парах с демо-ключами Yandex/2ГИС, отдельным шагом.
 *
 * `notWiredCarRouteProvider` — единственная реализация, подключённая к
 * `/api/routes/build` СЕГОДНЯ: честно отвечает `not_wired`, а не молчит и
 * не выдаёт локальную заглушку за реальный маршрут. `fakeCarRouteProvider`
 * и `fakeFarSnapCarRouteProvider` — тестовые адаптеры на РЕАЛЬНЫХ данных
 * пробы 28.08 (не в проде, только для тестов): доказывают, что found/
 * not_found/snap-guard работают до появления настоящего провайдера.
 */

import {
  MAX_CAR_SNAP_M, withinSnapTolerance,
  type CalculatedCarRoute,
} from '@/lib/on-route/calculated-route';

export interface CarRouteQuery {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
}

export type CarRouteProviderResult =
  | { status: 'found'; route: CalculatedCarRoute }
  | { status: 'not_found'; reason: string }
  | { status: 'not_wired'; message: string }
  | { status: 'error'; retryable: boolean; message: string };

export interface CarRouteProvider {
  route(query: CarRouteQuery): Promise<CarRouteProviderResult>;
}

export const CAR_PROVIDER_NOT_WIRED_MESSAGE =
  'Автомобильный маршрутизатор ещё не подключён — источник для PR 5B-1 не выбран.';

export const notWiredCarRouteProvider: CarRouteProvider = {
  async route(): Promise<CarRouteProviderResult> {
    return { status: 'not_wired', message: CAR_PROVIDER_NOT_WIRED_MESSAGE };
  },
};

export const SNAP_TOO_FAR_REASON =
  `Ближайшая дорога дальше ${MAX_CAR_SNAP_M} м от точки — привязка ненадёжна, путь не строится.`;

/**
 * Центральная политика, ОДНА на все будущие адаптеры (не копия в каждом
 * провайдере): найденный путь с ненадёжной привязкой понижается в
 * `not_found`, а не рисуется как есть. Без этого гейта провайдер вроде
 * OSRM молча снапит далёкую точку на ближайшую дорогу (проба 28.08: 8.8 км
 * без ограничения радиуса, честный NoSegment при radius=1000) — платформа
 * тогда обещала бы путь туда, где дороги на самом деле нет.
 */
export function applySnapGuard(result: CarRouteProviderResult): CarRouteProviderResult {
  if (result.status !== 'found') return result;
  if (withinSnapTolerance(result.route)) return result;
  return { status: 'not_found', reason: SNAP_TOO_FAR_REASON };
}

// ─── Тестовые адаптеры (владелец 28.08) — НЕ подключены к /api/routes/build ──
//
// Построены на настоящем ответе публичного демо-OSRM по координатам
// Камчатки (проба владельца), не на выдумке: реальная геометрия/расстояние/
// время маршрута Елизово → Петропавловск и реальные snap-расстояния двух
// проб (35 м / 1.3 м — в пределах Камчатки; 8.8 км — межрегиональная точка
// без ограничения радиуса). Используются только в тестах — доказывают, что
// found/not_found/guard работают на реальной форме ответа маршрутизатора,
// пока настоящий провайдер не выбран.

const KAMCHATKA_SAMPLE_ORIGIN_SNAP_M = 35.01300981;
const KAMCHATKA_SAMPLE_DEST_SNAP_M = 1.336672814;
const REMOTE_SAMPLE_DEST_SNAP_M = 8804.39108;

function fixedFoundResult(destSnapM: number): CarRouteProviderResult {
  const route: CalculatedCarRoute = {
    kind: 'calculated_car',
    geometry: { type: 'LineString', coordinates: [[158.45052, 53.186963], [158.649992, 53.035011]] },
    distanceM: 26108.5,
    durationS: 1830.8,
    originSnapped: { lat: 53.186963, lon: 158.45052, snapDistanceM: KAMCHATKA_SAMPLE_ORIGIN_SNAP_M },
    destinationSnapped: { lat: 53.035011, lon: 158.649992, snapDistanceM: destSnapM },
    provider: 'fake-osrm-fixture',
    builtAt: '2026-08-28T00:00:00.000Z',
    traffic: false,
    mayDisplay: true,
    mayNavigate: false,
    mayPersist: false,
  };
  return { status: 'found', route };
}

/** Обе точки привязались близко — честный found, guard пропускает как есть. */
export const fakeCarRouteProvider: CarRouteProvider = {
  async route(): Promise<CarRouteProviderResult> {
    return fixedFoundResult(KAMCHATKA_SAMPLE_DEST_SNAP_M);
  },
};

/** Цель привязалась в 8.8 км от дороги — то, что guard обязан понизить в not_found. */
export const fakeFarSnapCarRouteProvider: CarRouteProvider = {
  async route(): Promise<CarRouteProviderResult> {
    return fixedFoundResult(REMOTE_SAMPLE_DEST_SNAP_M);
  },
};
