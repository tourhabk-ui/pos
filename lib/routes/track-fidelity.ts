/**
 * lib/routes/track-fidelity.ts
 *
 * Трек ли это или линия между точками.
 *
 * У части маршрутов geometry построена миграцией 168 — прямыми отрезками от
 * точки к точке. В её собственном комментарии сказано честно: «This gives a
 * rough visual track on the map». Но до экрана эта оговорка не доезжала:
 * ломаная приходила в том же поле `track`, рисовалась тем же зелёным в четыре
 * пикселя и ничем не отличалась от снятого GPS-трека.
 *
 * В поле разница решающая. По снятому треку можно идти. Прямая между двумя
 * точками на камчатском рельефе проходит через каньон, стену и реку — и
 * выглядит на карте ровно так же уверенно.
 *
 * Флага в данных нет: миграция ничего не проставила. Поэтому различаем по
 * свойству самой геометрии — плотности точек на километр. Снятый трек это
 * десятки точек на километр (даже после прореживания до 600 точек на карту —
 * единицы). Ломаная по путевым точкам — доли точки на километр.
 *
 * Порог намеренно занижен: ошибаться можно только в сторону «назвали
 * наброском то, что на самом деле трек». Обратная ошибка отправляет человека
 * по прямой через распадок.
 */

export type TrackFidelity = 'surveyed' | 'sketch' | 'unknown';

/** Точка трека: [широта, долгота]. */
export type LatLng = [number, number];

const KM_PER_DEG_LAT = 111.32;

/** Длина ломаной в километрах. */
export function trackLengthKm(points: LatLng[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const [aLat, aLng] = points[i - 1];
    const [bLat, bLng] = points[i];
    const kmLng = KM_PER_DEG_LAT * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
    km += Math.hypot((bLat - aLat) * KM_PER_DEG_LAT, (bLng - aLng) * kmLng);
  }
  return km;
}

/**
 * Ниже этого числа точек на километр линия считается наброском.
 *
 * Снятый трек в сто километров, прорезанный сервером до 600 точек, даёт
 * шесть на километр. Ломаная из migration 168 — три точки на двадцать
 * километров, то есть 0.15. Между этими величинами сорокакратный зазор, и
 * единица лежит ближе к наброску: сомнение трактуем в пользу осторожности.
 */
export const SKETCH_MAX_POINTS_PER_KM = 1;

/**
 * Короткий маршрут судить по плотности нельзя.
 *
 * На дистанции в километр даже честный трек даёт мало точек, а деление на
 * малое число превращает оценку в шум. Ниже этого порога отвечаем «unknown»
 * — и экран говорит «происхождение линии неизвестно», а не выдумывает.
 */
export const MIN_KM_TO_JUDGE = 2;

export function trackFidelity(points: LatLng[] | null | undefined): TrackFidelity {
  if (!points || points.length < 2) return 'unknown';
  const km = trackLengthKm(points);
  if (km < MIN_KM_TO_JUDGE) return 'unknown';
  const perKm = points.length / km;
  return perKm < SKETCH_MAX_POINTS_PER_KM ? 'sketch' : 'surveyed';
}

/** Как назвать линию человеку. Пустая строка — подписи не нужно. */
export function trackFidelityLabel(f: TrackFidelity): string {
  switch (f) {
    case 'sketch':
      // Прямо и без смягчения: по этой линии идти нельзя.
      return 'Линия между точками, а не тропа — по ней нельзя идти напрямую';
    case 'unknown':
      return 'Происхождение линии неизвестно — сверяйтесь с местностью';
    default:
      return '';
  }
}

/**
 * Как её рисовать.
 *
 * Сплошная зелёная в четыре пикселя — обещание тропы. Набросок обязан
 * выглядеть наброском: тоньше, пунктиром и приглушённым цветом, чтобы
 * разница читалась без подписи.
 */
export function trackFidelityStyle(f: TrackFidelity): {
  color: string; weight: number; dashArray?: string;
} {
  if (f === 'surveyed') return { color: '#4ade80', weight: 4 };
  return { color: '#9A9590', weight: 2, dashArray: '6 8' };
}
