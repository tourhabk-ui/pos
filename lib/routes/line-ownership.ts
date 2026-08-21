/**
 * Чья это линия и что с ней не так — судья с четырьмя исходами.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Вопрос владельца 21.08: «как мне понять, какая из них верная, чтоб не
 * удалились правильные треки, которые есть в базе». Перепись до этого дня
 * сортировала линии ОДНИМ числом — размахом габаритов: 25 км и больше,
 * значит подозрительна. Но размах не порок сам по себе: у кольца вокруг
 * Толбачика он законно велик, а у чужой линии в двух километрах от места
 * он мал. Сито, принятое за приговор, удаляет правильное.
 *
 * Судья спрашивает не «велика ли линия», а «её ли она» — и отвечает
 * фактами, каждый из которых проверяем:
 *
 *   свои ли у неё концы   — подходит ли линия к собственной точке записи
 *   свои ли у неё места   — проходит ли она рядом со своими путевыми точками
 *   где начинается        — не влит ли в путь подъезд от посёлка
 *
 * ── Почему четыре исхода, а не два ─────────────────────────────────────────
 *
 * `own`             линия подходит к своей точке — это её путь
 * `own_with_approach` подходит, но начинается за десятки километров: в путь
 *                   влита дорога подъезда. Линия НЕ чужая, и трогать её
 *                   целиком нельзя — врёт не она, а число километров
 * `foreign`         не подходит к своей точке вовсе — линия не отсюда
 * `unclear`         судить нечем: нет своей точки, нет линии, либо
 *                   расстояние между порогами
 *
 * `unclear` — не вежливость и не «скорее да». Это отдельный исход: он
 * означает «человек смотрит глазами», и приравнивать его к любому из
 * знающих значило бы выдать незнание за знание (§4.0).
 *
 * Судья НИКОГДА не предписывает удаление. Он сортирует; решает человек,
 * а вернуть решённое даёт триггер архива (миграция 901).
 */

export type LineOwnershipVerdict = 'own' | 'own_with_approach' | 'foreign' | 'unclear';

/** Ближе этого линия считается подошедшей к своей точке. */
export const NEAR_OWN_KM = 3;
/**
 * Дальше этого линия признаётся чужой. Между порогами — `unclear`:
 * промежуток намеренно широк, потому что ошибка в сторону «чужая»
 * стоит правильного трека, а в сторону «не разобрать» — только взгляда.
 */
export const FAR_OWN_KM = 10;
/** Дальше этого конец линии от своей точки — влитый подъезд, а не путь. */
export const APPROACH_TAIL_KM = 8;

export interface LineOwnershipInput {
  /** Точка самой записи; null — у записи нет координат. */
  routePoint: { lat: number; lng: number } | null;
  /** Вершины линии в порядке GeoJSON: [lng, lat, ...]. */
  coords: number[][] | null | undefined;
  /** Путевые места записи (link_kind = 'waypoint'). «Рядом» сюда не входят. */
  waypoints?: ReadonlyArray<{ lat: number; lng: number }>;
}

export interface LineOwnership {
  verdict: LineOwnershipVerdict;
  /** Насколько близко линия подходит к своей точке, км; null — не посчитать. */
  nearestKm: number | null;
  /** Дальний конец линии от своей точки, км; null — не посчитать. */
  tailKm: number | null;
  /** Худший промах мимо собственного путевого места, км; null — мест нет. */
  worstWaypointKm: number | null;
  /** Словами: на чём основан вердикт. Пусто не бывает. */
  reasons: string[];
}

const R_KM = 6371;

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Расстояние от точки до ОТРЕЗКА, а не до его концов.
 *
 * Разница не косметическая: у линии в 253 вершины ближайшая ВЕРШИНА может
 * стоять в километре от точки, мимо которой линия проходит вплотную, — и
 * судья по вершинам объявил бы своим чужое, а чужим своё. На таких широтах
 * плоское приближение честно: сотни метров ошибки на километрах порогов.
 */
function distanceToSegmentKm(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const kx = 111.32 * Math.cos((pLat * Math.PI) / 180);
  const ky = 110.57;
  const ax = (aLng - pLng) * kx, ay = (aLat - pLat) * ky;
  const bx = (bLng - pLng) * kx, by = (bLat - pLat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt(ax * ax + ay * ay);
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

function nearestKmToLine(lat: number, lng: number, coords: number[][]): number | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) return haversine(lat, lng, coords[0][1], coords[0][0]);
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distanceToSegmentKm(
      lat, lng,
      coords[i][1], coords[i][0],
      coords[i + 1][1], coords[i + 1][0],
    );
    if (d < best) best = d;
  }
  return best;
}

export function lineOwnership(i: LineOwnershipInput): LineOwnership {
  const coords = Array.isArray(i.coords) ? i.coords.filter(
    c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]),
  ) : [];

  if (coords.length < 2) {
    return {
      verdict: 'unclear', nearestKm: null, tailKm: null, worstWaypointKm: null,
      reasons: ['В линии меньше двух точек — судить не о чем'],
    };
  }
  if (i.routePoint === null) {
    return {
      verdict: 'unclear', nearestKm: null, tailKm: null, worstWaypointKm: null,
      reasons: ['У записи нет своей координаты — не с чем сличать линию'],
    };
  }

  const { lat, lng } = i.routePoint;
  const nearestKm = nearestKmToLine(lat, lng, coords);
  const ends = [coords[0], coords[coords.length - 1]];
  const tailKm = Math.max(...ends.map(c => haversine(lat, lng, c[1], c[0])));

  const wps = i.waypoints ?? [];
  const worstWaypointKm = wps.length === 0
    ? null
    : Math.max(...wps.map(w => nearestKmToLine(w.lat, w.lng, coords) ?? Infinity));

  const reasons: string[] = [];
  const near = nearestKm === null ? Infinity : nearestKm;
  const round = (v: number) => Math.round(v * 10) / 10;

  if (near > FAR_OWN_KM) {
    reasons.push(`Линия не подходит к точке записи ближе ${round(near)} км`);
    if (worstWaypointKm !== null && worstWaypointKm > FAR_OWN_KM) {
      reasons.push(`И мимо собственных путевых мест — до ${round(worstWaypointKm)} км`);
    }
    return { verdict: 'foreign', nearestKm, tailKm, worstWaypointKm, reasons };
  }

  if (near > NEAR_OWN_KM) {
    reasons.push(
      `Линия подходит к точке записи на ${round(near)} км — между порогами ` +
      `${NEAR_OWN_KM} и ${FAR_OWN_KM} км, решать глазами`,
    );
    return { verdict: 'unclear', nearestKm, tailKm, worstWaypointKm, reasons };
  }

  reasons.push(`Линия подходит к точке записи на ${round(near)} км — это её путь`);

  if (tailKm > APPROACH_TAIL_KM) {
    reasons.push(
      `Но конец линии стоит в ${round(tailKm)} км от записи — в путь влит подъезд. ` +
      `Врёт не линия, а число километров: длина считается по всей ломаной`,
    );
    return { verdict: 'own_with_approach', nearestKm, tailKm, worstWaypointKm, reasons };
  }

  if (worstWaypointKm !== null && worstWaypointKm > FAR_OWN_KM) {
    reasons.push(`Мимо собственного путевого места на ${round(worstWaypointKm)} км`);
    return { verdict: 'unclear', nearestKm, tailKm, worstWaypointKm, reasons };
  }

  return { verdict: 'own', nearestKm, tailKm, worstWaypointKm, reasons };
}
