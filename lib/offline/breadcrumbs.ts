/**
 * След пути — крошки, по которым возвращаются.
 *
 * Единственная функция навигатора, которая работает, когда отказало всё
 * остальное: карта не скачана, связи нет, точки маршрута кончились, а человек
 * не там, где рассчитывал. Свой след — это то, откуда он точно пришёл.
 *
 * До 09.08 след жил в памяти тридцать минут и был нужен только для расчёта
 * темпа. Любая перезагрузка страницы — а телефон на морозе перезагружается
 * сам — стирала его без следа. Здесь он ложится на диск.
 *
 * Дисциплина записи диктуется не красотой, а квотой: браузер даёт немного, и
 * тратить её на пятьдесят точек в минуту, когда человек стоит у ручья,
 * нельзя. Точка пишется, когда пройдено расстояние, а не когда прошло время.
 */

export interface Crumb {
  /** Широта, округлена до пяти знаков — метровая точность, дальше шум GPS. */
  lat: number;
  lng: number;
  /** Время фикса, мс. */
  t: number;
}

/** Ближе этого новую крошку не пишем: стояние на месте — не путь. */
export const CRUMB_MIN_STEP_M = 25;
/**
 * Потолок числа крошек. При шаге 25 м это около полутораста километров пути —
 * больше любого однодневного и почти любого многодневного маршрута.
 */
export const CRUMB_MAX = 6000;
/** Ключ хранения: след привязан к маршруту, чужой не подмешиваем. */
export function crumbsKey(routeId: string): string {
  return `trail_crumbs_${routeId}`;
}

const R_EARTH = 6371000;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Добавить точку к следу, если она добавляет знание.
 *
 * Возвращает НОВЫЙ массив, когда точка принята, и прежний — когда нет. По
 * различию ссылок вызывающий понимает, надо ли сохранять на диск: писать в
 * хранилище на каждый тик GPS значит тратить квоту и батарею впустую.
 */
export function addCrumb(
  crumbs: Crumb[],
  point: { lat: number; lng: number; t: number },
  minStepM = CRUMB_MIN_STEP_M,
): Crumb[] {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return crumbs;
  const next: Crumb = { lat: round5(point.lat), lng: round5(point.lng), t: point.t };
  const last = crumbs[crumbs.length - 1];
  if (last && metersBetween(last, next) < minStepM) return crumbs;

  const out = [...crumbs, next];
  // Переполнение режем с начала: ближний хвост следа важнее дальнего — по
  // нему возвращаются в первую очередь.
  return out.length > CRUMB_MAX ? out.slice(out.length - CRUMB_MAX) : out;
}

/** Разбор сохранённого следа. Мусор в хранилище — это пустой след, не падение. */
export function parseCrumbs(raw: string | null): Crumb[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Crumb[] = [];
    for (const c of parsed) {
      if (!Array.isArray(c) || c.length < 3) continue;
      const [lat, lng, t] = c.map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(t)) {
        out.push({ lat, lng, t });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Сериализация. Массив троек вместо объектов: втрое короче при том же смысле,
 * а квота хранилища у нас не резиновая.
 */
export function serializeCrumbs(crumbs: Crumb[]): string {
  return JSON.stringify(crumbs.map(c => [c.lat, c.lng, c.t]));
}

/** Длина следа в километрах — сколько человек реально прошёл. */
export function crumbsDistanceKm(crumbs: Crumb[]): number {
  let m = 0;
  for (let i = 1; i < crumbs.length; i++) m += metersBetween(crumbs[i - 1], crumbs[i]);
  return m / 1000;
}
