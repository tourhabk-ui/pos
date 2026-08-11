/**
 * lib/routes/track.ts
 *
 * Извлечение GPS-трека маршрута из всех исторических мест хранения.
 * Единая логика для GPX-экспорта и карточки маршрута — раньше жила только
 * в export/route.ts, и карточка не умела показывать трек вовсе.
 *
 * Источники по приоритету:
 * 1. kamchatka_routes.geometry (GeoJSON LineString, [lng, lat, ele?])
 * 2. payload.geometry — legacy JSONB тех же ранних импортов
 * 3. payload.track — legacy массив {lat, lng, elevation?}
 */

import { haversineM as haversineTrackM } from '@/lib/routes/relief';

export interface TrackPoint {
  lat: number;
  lng: number;
  elevation?: number;
}

interface GeoJsonLineString {
  type?: string;
  coordinates?: number[][];
}

function fromLineString(geom: GeoJsonLineString | null | undefined): TrackPoint[] {
  if (geom?.type !== 'LineString' || !Array.isArray(geom.coordinates)) return [];
  return geom.coordinates
    .filter((c): c is number[] => Array.isArray(c) && c.length >= 2
      && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(c => ({ lng: c[0], lat: c[1], elevation: c[2] as number | undefined }));
}

export function extractTrackpoints(
  geometry: GeoJsonLineString | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): TrackPoint[] {
  const direct = fromLineString(geometry);
  if (direct.length > 0) return direct;

  const p = payload ?? {};
  const legacy = fromLineString(p.geometry as GeoJsonLineString | null);
  if (legacy.length > 0) return legacy;

  const track = p.track;
  if (Array.isArray(track)) {
    return track.filter(
      (pt): pt is TrackPoint =>
        !!pt && typeof pt === 'object'
        && Number.isFinite((pt as TrackPoint).lat)
        && Number.isFinite((pt as TrackPoint).lng),
    );
  }
  return [];
}

/**
 * Допуск упрощения, метры.
 *
 * Двадцать метров — заметно меньше точности GPS в горах (на полевом скриншоте
 * ±29 м) и заметно меньше ширины любой тропы. Всё, что упрощение сдвигает в
 * этих пределах, человек всё равно не различит; всё, что больше, — поворот,
 * и он остаётся.
 */
export const SIMPLIFY_EPSILON_M = 20;

/** Расстояние от точки до отрезка, метры. Плоскость с поправкой на широту. */
function pointToSegmentM(p: TrackPoint, a: TrackPoint, b: TrackPoint): number {
  const kLat = 111_320;
  const kLng = kLat * Math.cos((p.lat * Math.PI) / 180);
  const px = p.lng * kLng, py = p.lat * kLat;
  const ax = a.lng * kLng, ay = a.lat * kLat;
  const bx = b.lng * kLng, by = b.lat * kLat;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/**
 * Упрощение Дугласа-Пекера: какие точки оставить.
 *
 * Возвращает ИНДЕКСЫ, а не точки, — чтобы вместе с ними можно было забрать
 * накопленные расстояния полного трека и не считать их заново.
 *
 * Чем это лучше шаговой выборки. Прежнее прореживание брало каждую N-ю точку
 * и срезало вершины поворотов ПО ПОСТРОЕНИЮ: на серпантине оставались хорды,
 * а по хорде проекция человека уходит в сторону от настоящей тропы — экран
 * объявлял уход с тропы, которого нет. Дуглас-Пекер выбрасывает точки на
 * прямых участках и сохраняет ровно перегибы, то есть то, ради чего трек и
 * снимали.
 */
export function simplifyIndices(points: TrackPoint[], epsilonM = SIMPLIFY_EPSILON_M): number[] {
  if (points.length <= 2) return points.map((_, i) => i);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Явный стек вместо рекурсии: трек из десятков тысяч точек переполнил бы её.
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    let worst = 0, worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointToSegmentM(points[i], points[first], points[last]);
      if (d > worst) { worst = d; worstIdx = i; }
    }
    if (worstIdx >= 0 && worst > epsilonM) {
      keep[worstIdx] = 1;
      stack.push([first, worstIdx], [worstIdx, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Прореживание трека для карты карточки: JSON-ответ не должен раздуваться
 * из-за OSM-треков в тысячи точек. Начало и конец сохраняются всегда.
 */
export function decimateTrack(points: TrackPoint[], maxPoints = 600): TrackPoint[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/**
 * Прореженный трек ВМЕСТЕ с расстояниями в шкале ПОЛНОГО трека.
 *
 * Прореживание берёт каждую N-ю точку — значит ломаная становится короче
 * исходной, тем сильнее, чем извилистее путь. Профиль высот при этом считается
 * по полному треку и индексирован его длиной. Две шкалы, и клиент, меряющий
 * положение по прореженной ломаной, режет профиль не там: на извилистом
 * тридцатикилометровом маршруте сдвиг к началу — сотни метров.
 *
 * Ошибка того же рода, что мы чиним на этом экране: два числа об одном
 * расстоянии, посчитанные разными мерками. Лечится не выбором «чья мерка
 * правильнее», а тем, что мерка остаётся одна: вместе с точками отдаётся,
 * сколько метров ПОЛНОГО трека приходится на каждую оставленную точку.
 *
 * `dm[i]` — расстояние по полному треку до i-й оставленной точки. Между ними
 * клиент интерполирует по доле вдоль звена: на самих точках это точно, между
 * ними — линейно, и в обоих случаях в одной шкале с профилем.
 */

export function decimateTrackWithScale(
  points: TrackPoint[], maxPoints = 600,
): { points: TrackPoint[]; dm: number[] } {
  if (points.length === 0) return { points: [], dm: [] };

  // Накопленные расстояния по ПОЛНОМУ треку — та самая шкала профиля.
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversineTrackM(points[i - 1], points[i]);
  }
  if (points.length <= 2) return { points, dm: cum };

  // Потолок ВХОДА, а не выхода. Дуглас-Пекер в худшем случае квадратичен, и
  // на пилообразном треке в двадцать тысяч точек он считается шестнадцать
  // секунд — столько API висеть не может. Выше этого потолка вход прореживается
  // шагом ДО упрощения: при восьми тысячах точек на тридцать километров шаг
  // между ними меньше четырёх метров, то есть впятеро мельче допуска, и форма
  // от такого прореживания не страдает. Ниже потолка шаговой выборки нет
  // вовсе — иначе она вернула бы ровно то, от чего мы уходим.
  const MAX_DP_INPUT = 8000;
  let src = points;
  let srcCum = cum;
  if (points.length > MAX_DP_INPUT) {
    const stride = Math.ceil(points.length / MAX_DP_INPUT);
    const thinned: TrackPoint[] = [];
    const thinnedCum: number[] = [];
    for (let i = 0; i < points.length; i += stride) {
      thinned.push(points[i]);
      thinnedCum.push(cum[i]);
    }
    const lastIdx = points.length - 1;
    if (thinned[thinned.length - 1] !== points[lastIdx]) {
      thinned.push(points[lastIdx]);
      thinnedCum.push(cum[lastIdx]);
    }
    src = thinned;
    srcCum = thinnedCum;
  }

  // Форма — Дугласом-Пекером: он выбрасывает точки на прямых и сохраняет
  // перегибы. Шаговая выборка срезала бы вершины поворотов по построению.
  let idx = simplifyIndices(src);

  // Потолок ответа держится ужесточением допуска, а не шаговой выборкой
  // поверх: иначе всё, ради чего звали Дугласа-Пекера, тут же и потерялось бы.
  let eps = SIMPLIFY_EPSILON_M;
  while (idx.length > maxPoints && eps < 2000) {
    eps *= 2;
    idx = simplifyIndices(src, eps);
  }

  return {
    points: idx.map((i) => src[i]),
    // Шкала берётся из накопленных расстояний ПОЛНОГО трека — даже когда вход
    // предварительно прорежен: srcCum хранит метры исходной ломаной.
    dm: idx.map((i) => srcCum[i]),
  };
}
