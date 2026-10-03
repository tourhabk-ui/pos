/**
 * lib/on-route/road-graph-car-provider.ts — CarRouteProvider поверх своего
 * дорожного графа (владелец 28.08, «собираем свой» — вместо bake-off
 * Yandex/2ГИС).
 *
 * Источник — не новый: миграция 760 («Дорожный граф Камчатки из OSM —
 * фундамент своего роутера», решение владельца 2026-07-20, «без внешних
 * роутинг-API, офлайн-first»), A*-ядро lib/routing/astar.ts и общая логика
 * решений lib/routing/road-graph-route.ts (та же, что уже работает на
 * `GET /api/routing/path`, — не второй независимый список причин отказа).
 * Внешнего провайдера, ключей и bake-off эта правка не заводит: весь расчёт
 * — наши данные, наша БД, трансграничной передачи нет.
 *
 * `mayNavigate: false` / `mayPersist: false` — рекомендация первого релиза,
 * не решение о лицензии (её здесь нет). Причина другая: модель скоростей в
 * astar.ts сама себя называет «стартовые оценки под камчатские дороги…
 * калибровать по полевым прогонам» — прежде чем предлагать «Начать
 * маршрут» по этой линии или сохранять её как готовый трек, разумно
 * увидеть, насколько она сходится с реальностью в поле. Оба флага — в
 * одном месте, включить позже — однострочная правка.
 */

import { roadGraphRoute } from '@/lib/routing/road-graph-route';
import type { CarRouteProvider, CarRouteProviderResult, CarRouteQuery } from '@/lib/on-route/route-provider';
import type { CalculatedCarRoute } from '@/lib/on-route/calculated-route';

export const ROAD_GRAPH_CAR_PROVIDER_LABEL = 'Ведар — свой дорожный граф Камчатки';
/**
 * Пеший режим (PR 5B-2, 03.10). Тот же граф: импорт с Overpass кладёт в него
 * и тропы (`path`, `footway`, `track`, `bridleway` — scripts/road-graph-builder.js),
 * а A* уже умел режим `foot` (lib/routing/astar.ts). Не хватало одной двери:
 * /api/routes/build отвечал «пеший путь не строим». Решение 28.08 — «пешком
 * только по известной сети троп»; тропы OSM и есть такая сеть: по ней же
 * строит MAPS.ME (скрин владельца 03.10: к «Диким озеркам» 5.3 км пешком,
 * а у нас — автопетля по дорогам). По бездорожью линия по-прежнему не
 * рисуется: точку дальше MAX_CAR_SNAP_M от сети отсекает тот же snap-guard.
 */
export const ROAD_GRAPH_FOOT_PROVIDER_LABEL = 'Ведар — тропы и дороги Камчатки (OSM)';

function makeRoadGraphProvider(mode: 'car' | 'foot', label: string): CarRouteProvider {
  return {
  async route(query: CarRouteQuery): Promise<CarRouteProviderResult> {
    let result: Awaited<ReturnType<typeof roadGraphRoute>>;
    try {
      result = await roadGraphRoute(query.originLat, query.originLon, query.destLat, query.destLon, mode);
    } catch (err) {
      return {
        status: 'error',
        retryable: true,
        message: err instanceof Error ? err.message : 'Не удалось построить путь по дорожному графу',
      };
    }

    if (!result.ok) {
      return { status: 'not_found', reason: result.message };
    }

    const route: CalculatedCarRoute = {
      kind: 'calculated_car',
      // findPath отдаёт [lat,lng]; контракт CalculatedCarRoute — GeoJSON
      // [lng,lat] (RFC 7946). Единственное место конвертации на сервере,
      // симметричное calculatedCarToLeafletCoordinates на клиенте, которая
      // переворачивает координаты обратно для Leaflet.
      geometry: {
        type: 'LineString',
        coordinates: result.geometry.map(([lat, lng]) => [lng, lat]),
      },
      distanceM: result.distanceM,
      durationS: result.durationS,
      // Снапнутая ТОЧКА НА ГРАФЕ, не исходная координата запроса — контракт
      // пинов «Старт/Цель на дороге» на клиенте ждёт именно точку привязки.
      originSnapped: { lat: result.start.lat, lon: result.start.lng, snapDistanceM: result.start.snapM },
      destinationSnapped: { lat: result.goal.lat, lon: result.goal.lng, snapDistanceM: result.goal.snapM },
      provider: label,
      travelMode: mode,
      builtAt: new Date().toISOString(),
      // Граф статический — живого трафика нет и не будет, пока не появится
      // отдельный источник; врать «пробки учтены» нельзя.
      traffic: false,
      mayDisplay: true,
      mayNavigate: false,
      mayPersist: false,
    };

    return { status: 'found', route };
  },
  };
}

export const roadGraphCarProvider: CarRouteProvider = makeRoadGraphProvider('car', ROAD_GRAPH_CAR_PROVIDER_LABEL);
export const roadGraphFootProvider: CarRouteProvider = makeRoadGraphProvider('foot', ROAD_GRAPH_FOOT_PROVIDER_LABEL);
