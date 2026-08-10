/**
 * lib/routes/collect-signals.ts
 *
 * Сбор сигналов для вердикта: зоны маршрута → предупреждения, коридор →
 * коды вулканов.
 *
 * Здесь живёт единственное различение, ради которого всё затевалось:
 *
 *   `null` — НЕ СМОГЛИ УЗНАТЬ (запрос упал, зоны неизвестны);
 *   `[]`   — УЗНАЛИ, И ТАМ НИЧЕГО НЕТ.
 *
 * Первое запрещает зелёный вердикт, второе разрешает. Весь сегодняшний день
 * был про то, как эти два состояния сливаются в одно: `catch` возвращал
 * пустой массив, и отказ базы становился неотличим от спокойного дня.
 *
 * Поэтому каждый источник берётся отдельным запросом со своим `catch`, и
 * `catch` возвращает `null`. Ни одна ветка здесь не имеет права вернуть `[]`
 * по ошибке — за этим следит тест, а не дисциплина.
 *
 * Зависимости внедряются: запрос и месяц приходят снаружи. Так различение
 * проверяется юнит-тестом без базы, а не остаётся обещанием в комментарии.
 */

import { pool } from '@/lib/db-pool';
import type { RouteSignals, Acc } from '@/lib/routes/go-verdict';

/** Минимальный контракт запроса — ровно то, что нужно сборщику. */
export type QueryFn = <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;

export interface CollectDeps {
  query: QueryFn;
  /** Месяц 1..12. Приходит снаружи: обращение к часам ломает воспроизводимость. */
  month: number;
}

/**
 * Радиус, в котором вулкан считается «на коридоре».
 *
 * Не про геологию, а про то, что видно и слышно с маршрута: пеплопад,
 * газовый шлейф, перекрытые подходы. Двадцать пять километров — расстояние,
 * на котором оранжевый код меняет решение идти.
 */
export const CORRIDOR_VOLCANO_KM = 25;

const KM_PER_DEG_LAT = 111.32;

/** Месяцы, в которые маршрут считается сезонным. */
export function isInSeason(season: string | null, month: number): boolean | null {
  if (!season) return null; // сезон в данных не задан — судить не по чему
  const s = season.toLowerCase();
  if (s.includes('all') || s.includes('круглогод')) return true;
  const summer = month >= 6 && month <= 9;
  if (s.includes('summer') || s.includes('лет')) return summer;
  if (s.includes('winter') || s.includes('зим')) return !summer;
  return null;
}

interface RouteRow { zone: string | null; season: string | null; lat: string | null; lng: string | null }
interface PointRow { zone: string | null; lat: string | null; lng: string | null }
interface AlertRow { title: string; severity: number | null }
interface VolcanoRow { name: string; acc: string }

/** Опорные точки маршрута: он сам плюс его путевые точки. */
interface RouteShape {
  zones: string[];
  season: string | null;
  points: Array<{ lat: number; lng: number }>;
}

async function loadRouteShape(routeId: string, q: QueryFn): Promise<RouteShape | null> {
  try {
    const [route, points] = await Promise.all([
      q<RouteRow>(
        `SELECT zone, season, lat::text, lng::text FROM kamchatka_routes WHERE id = $1`,
        [routeId],
      ),
      q<PointRow>(
        `SELECT DISTINCT p.zone, p.lat::text, p.lng::text
           FROM route_waypoints rw
           JOIN places p ON p.id = rw.place_id
          WHERE rw.route_id = $1`,
        [routeId],
      ),
    ]);
    const r = route.rows[0];
    if (!r) return null; // маршрута нет — это не «пустые зоны», это незнание

    const zones = new Set<string>();
    if (r.zone) zones.add(r.zone);
    for (const p of points.rows) if (p.zone) zones.add(p.zone);

    const coords: Array<{ lat: number; lng: number }> = [];
    const push = (lat: string | null, lng: string | null) => {
      // `Number(null)` — это 0, а не NaN. Пустить сюда пустую координату
      // значило бы поставить опорную точку маршрута в Гвинейский залив и
      // спросить, какие вулканы рядом: ответ «никаких» пришёл бы уверенно.
      if (lat === null || lng === null || lat === '' || lng === '') return;
      const a = Number(lat), b = Number(lng);
      if (Number.isFinite(a) && Number.isFinite(b)) coords.push({ lat: a, lng: b });
    };
    push(r.lat, r.lng);
    for (const p of points.rows) push(p.lat, p.lng);

    return { zones: [...zones], season: r.season, points: coords };
  } catch {
    // Форма маршрута неизвестна — значит неизвестно и всё, что от неё зависит.
    return null;
  }
}

/**
 * Важность предупреждения, у которого важность не проставлена.
 *
 * Ноль здесь был бы ровно тем дефектом, который мы ловим весь день:
 * `Number(null) || 0` превращает «неизвестно, насколько опасно» в «безопасно»,
 * и алерт с пустым severity молча выпадает из вердикта. Предупреждение,
 * которое кто-то счёл нужным завести, — как минимум повод сказать
 * «Осторожно». Классификатор МЧС важность проставляет всегда, так что это
 * пол для редкого случая, а не источник желтизны.
 */
const SEVERITY_WHEN_UNSET = 1;

/**
 * Предупреждения, накрывающие зоны маршрута.
 *
 * Алерт без зон (`affected_zones` пуст) считается общерегиональным — это та же
 * договорённость, по которой живёт `location_real_time_status`. Иначе
 * предупреждение, у которого зона не распозналась, не дошло бы ни до кого.
 *
 * Бессрочный алерт (`expires_at IS NULL`) — действующий. Так же его читают
 * Кузьмич и guardian-context; условие «expires_at > NOW()» в одиночку молча
 * выкидывает целый класс записей.
 */
async function loadAlerts(zones: string[], q: QueryFn): Promise<Array<{ title: string; severity: number }> | null> {
  try {
    const { rows } = await q<AlertRow>(
      `SELECT title, severity::int AS severity
         FROM external_alerts
        WHERE (expires_at IS NULL OR expires_at > NOW())
          AND (
            affected_zones IS NULL
            OR affected_zones = '{}'
            OR affected_zones && $1::text[]
          )
        ORDER BY severity DESC NULLS LAST, created_at DESC
        LIMIT 50`,
      [zones],
    );
    return rows.map((r) => ({
      title: r.title,
      severity: Number.isFinite(Number(r.severity)) && r.severity !== null
        ? Number(r.severity)
        : SEVERITY_WHEN_UNSET,
    }));
  } catch {
    return null;
  }
}

/**
 * Коды KVERT вулканов на коридоре.
 *
 * Ищутся не только вулканы-путевые точки: маршрут может идти мимо горы, не
 * заходя на неё, и оранжевый код от этого не перестаёт значить. Отбор по
 * расстоянию от любой опорной точки маршрута.
 *
 * Известное ограничение, названное здесь прямо, чтобы не выглядеть полнотой:
 * сводка KVERT покрывает и Курилы, и строка без `place_ark_id` координат не
 * имеет — такой вулкан на коридор не положить ничем, кроме имени. Отбор идёт
 * по расстоянию, а не по совпадению названий: похожее имя дало бы уверенный
 * ответ там, где его нет. Правильное лечение — связать имена KVERT с
 * `places` при синке, и оно живёт отдельной задачей.
 */
async function loadVolcanoes(
  points: Array<{ lat: number; lng: number }>,
  q: QueryFn,
): Promise<Array<{ name: string; acc: Acc }> | null> {
  if (points.length === 0) return null; // не от чего мерить — значит не знаем
  try {
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const { rows } = await q<VolcanoRow>(
      `WITH anchor AS (
         SELECT unnest($1::float8[]) AS lat, unnest($2::float8[]) AS lng
       )
       SELECT DISTINCT p.name, vs.aviation_color_code AS acc
         FROM volcano_status vs
         JOIN places p ON p.ark_id = vs.place_ark_id
        WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM anchor a
             WHERE 2 * 6371 * asin(sqrt(
                     power(sin(radians((p.lat - a.lat) / 2)), 2)
                     + cos(radians(a.lat)) * cos(radians(p.lat))
                       * power(sin(radians((p.lng - a.lng) / 2)), 2)
                   )) <= $3
          )`,
      [lats, lngs, CORRIDOR_VOLCANO_KM],
    );
    const allowed: Acc[] = ['green', 'yellow', 'orange', 'red', 'unassigned'];
    return rows.map((r) => ({
      name: r.name,
      // Неизвестный код не выдаём за зелёный: у него своё значение.
      acc: (allowed as string[]).includes(r.acc) ? (r.acc as Acc) : 'unassigned',
    }));
  } catch {
    return null;
  }
}

/**
 * Собрать сигналы по маршруту.
 *
 * Погода намеренно не собирается: опасная погода доезжает до нас
 * предупреждением МЧС (циклон 10.08 пришёл именно так), а собственный прогноз
 * не является источником запрета. `weather: null` для вердикта не критично —
 * см. lib/routes/go-verdict.
 */
export async function collectRouteSignals(
  routeId: string,
  deps?: Partial<CollectDeps>,
): Promise<RouteSignals> {
  const q: QueryFn = deps?.query ?? ((sql, params) => pool.query(sql, params) as never);
  const month = deps?.month ?? new Date().getMonth() + 1;

  const shape = await loadRouteShape(routeId, q);

  // Форма неизвестна — неизвестно ВСЁ, что от неё зависит. Подставить сюда
  // пустые массивы значило бы сказать «узнали, там чисто».
  if (!shape) {
    return { alerts: null, volcanoes: null, inSeason: null, weather: null };
  }

  const [alerts, volcanoes] = await Promise.all([
    loadAlerts(shape.zones, q),
    loadVolcanoes(shape.points, q),
  ]);

  return {
    alerts,
    volcanoes,
    inSeason: isInSeason(shape.season, month),
    weather: null,
  };
}
