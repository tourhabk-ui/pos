/**
 * lib/on-route/calculated-route.ts — нормализованная форма посчитанного
 * автомобильного пути (владелец 28.08, продолжение PR 5B-1).
 *
 * PR 5B-1 (инфраструктура) сознательно НЕ добавил `found`/`not_found` в
 * контракт провайдера: форма найденного пути зависит от конкретного
 * источника (Yandex Router API / 2ГИС / OSRM — у каждого свои единицы,
 * своя кодировка геометрии), а сунуть её в `RouteOption` без плана было
 * бы выдумкой. Владелец провёл региональный тест трёх кандидатов
 * (публичный демо-OSRM, реальные координаты Камчатки) и зафиксировал
 * нормализованную форму — этот файл её реализует.
 *
 * `CalculatedCarRoute` — НЕ `RouteOption` каталога и НЕ снятый трек:
 * третий род линии, для которого нет места в существующей таксономии
 * `lib/map/line-standard.ts` (§12 CLAUDE.md). Приписывать ему `lineGrade`
 * значило бы соврать о происхождении — поле остаётся `null` у варианта,
 * несущего `calculated`. Отображение геометрии на карте — отдельный
 * вопрос (нужна новая категория линии, не решённая здесь).
 */

export interface SnappedPoint {
  lat: number;
  lon: number;
  /** Расстояние от исходной точки до её проекции на дорожный граф, метры. */
  snapDistanceM: number;
}

export interface CalculatedCarRoute {
  kind: 'calculated_car';
  /**
   * GeoJSON LineString, порядок [lng, lat] (RFC 7946) — НЕ [lat, lng], как
   * у остального кода платформы (LeafletMap, RoutePreview). Конвертация —
   * забота потребителя геометрии, не этого типа: смешивать порядки внутри
   * контракта опаснее, чем один раз явно сконвертировать на границе.
   */
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distanceM: number;
  durationS: number;
  originSnapped: SnappedPoint;
  destinationSnapped: SnappedPoint;
  provider: string;
  builtAt: string;
  /** Учитывался ли трафик при расчёте — влияет на то, насколько устареет durationS. */
  traffic: boolean;
  mayDisplay: boolean;
  mayNavigate: boolean;
  mayPersist: boolean;
}

/**
 * Порог привязки к дороге — улика происхождения, не приговор о
 * проходимости. Региональный тест владельца 28.08 на публичном демо-OSRM:
 * без ограничения радиуса точка в тысячах километров от Камчатки молча
 * снапилась на ближайшую дорогу (8.8 км) и вернула `Ok` — маршрутизатор
 * НЕ отказал, просто дорисовал то, чего нет. С `radius=1000` та же точка
 * честно отвечает `NoSegment`. 1 км — запас для грунтовых дорог Камчатки,
 * не карт-бланш «где-то рядом есть хоть какая-то дорога».
 */
export const MAX_CAR_SNAP_M = 1000;

/** Обе точки — origin и destination — обязаны привязаться в пределах порога. */
export function withinSnapTolerance(
  route: Pick<CalculatedCarRoute, 'originSnapped' | 'destinationSnapped'>,
): boolean {
  return route.originSnapped.snapDistanceM <= MAX_CAR_SNAP_M
    && route.destinationSnapped.snapDistanceM <= MAX_CAR_SNAP_M;
}

/**
 * Единственная граница, где `[lng, lat]` (GeoJSON, RFC 7946) становится
 * `[lat, lng]` (Leaflet). Порядок осей ФИКСИРОВАН по контракту типа —
 * функция не угадывает его по диапазону значений: угадывание по диапазону
 * подменило бы честную ошибку неверной интерпретации в тех редких случаях,
 * где обе оси лежат в пределах друг друга (§4.0 CLAUDE.md — третье
 * состояние). При любой некорректной форме — `null`: линия не рисуется,
 * вызывающий код обязан показать честное сообщение и завести диагностику,
 * а не молча промолчать или нарисовать что попало.
 */
export function calculatedCarToLeafletCoordinates(
  route: Pick<CalculatedCarRoute, 'geometry'>,
): [number, number][] | null {
  const coordinates = route?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const leafletCoords: [number, number][] = [];
  for (const pair of coordinates) {
    if (!Array.isArray(pair) || pair.length < 2) {
      return null;
    }
    const [lng, lat] = pair;
    if (
      typeof lng !== 'number' || typeof lat !== 'number'
      || !Number.isFinite(lng) || !Number.isFinite(lat)
    ) {
      return null;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }
    leafletCoords.push([lat, lng]);
  }

  return leafletCoords;
}
