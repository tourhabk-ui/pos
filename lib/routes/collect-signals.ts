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
import { BAN_AUDIENCE, BAN_VERB } from '@/lib/services/safety/tourist-ban';

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

/**
 * Радиус, в котором событие С КООРДИНАТОЙ считается относящимся к маршруту.
 *
 * ── Откуда взялся ─────────────────────────────────────────────────────────
 *
 * 19.09 владелец прислал карточку «Ночное восхождение на Авачинский вулкан».
 * В блоке «Осторожно · на сегодня» первой строкой стояло: «Термоточки
 * (возможен пожар): 2 очаг(ов), 54.61°N 160.30°E». Это 178 км от Авачинского
 * — другой конец Ключевской группы, другая дорога, другой день пути.
 *
 * Дошло оно так: у термоточек зона считается функцией `zonesFor`
 * (lib/services/safety/wildfire-firms.ts), и её последняя ветка — `return
 * ['avachinsky']` без условия. То есть «авачинская зона» работает ОСТАТКОМ:
 * всё, что не север и не восток, объявляется окрестностями города. При длине
 * полуострова больше тысячи километров туда проваливается его середина.
 *
 * Зональный отбор сам по себе не виноват: у большинства предупреждений МЧС
 * координаты нет вовсе, и зона — единственное, чем их можно привязать.
 * Виновата пара «грубая зона» + «точная координата, которую никто не
 * спросил»: у термоточки lat/lng ЕСТЬ, и расстояние можно было измерить.
 *
 * Поэтому правило здесь такое: есть координата — меряем; нет координаты —
 * судим по зоне, как раньше. Это не ужесточение и не послабление, а отказ
 * гадать там, где можно знать.
 *
 * Шире вулканного коридора намеренно: пожар, перекрытая дорога и паводок
 * меняют решение с большего расстояния, чем газовый шлейф. Но не «весь край»:
 * предупреждение, до которого сутки пути, на карточке маршрута — шум, а шум
 * учит не читать предупреждения вовсе.
 */
export const CORRIDOR_ALERT_KM = 60;

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
interface AlertRow { title: string; severity: number | null; alert_type: string | null; zonal: boolean | null }
interface VolcanoRow { name: string; acc: string }
interface ClosureRow { name: string; reason: string | null }

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
 * Алерт без зон (`affected_zones` пуст или NULL) НЕ накрывает ни один маршрут
 * (17.09) — та же договорённость, по которой с этого дня живёт
 * `location_real_time_status` (safety-ingest). Прежняя редакция читала
 * пустоту как «общерегиональное», чтобы нераспознанное «дошло хоть до
 * кого-то», — и оно доходило до всех: паводок на западном побережье висел на
 * маршрутах Авачинской группы. «Не установлено» ≠ «везде» (§4.0): такое
 * предупреждение остаётся в общекраевой ленте, а тексты, которые сами
 * говорят «по краю», получают все зоны в mchs_zones. Сторож обоих
 * предикатов — tests/unit/alert-zone-unknown.test.ts.
 *
 * Бессрочный алерт (`expires_at IS NULL`) — действующий. Так же его читают
 * Кузьмич и guardian-context; условие «expires_at > NOW()» в одиночку молча
 * выкидывает целый класс записей.
 */
/**
 * Отпечаток для дедупликации.
 *
 * Один и тот же документ приходит дважды, когда у поста нет заголовка и он
 * достраивается из тела: проба 10.08 показала на маршруте две копии новости о
 * переправе — с severity 2 и 1, у второй к заголовку приклеен кусок текста.
 * Сравнение по полному заголовку их не сводит, сравнение по началу — сводит.
 */
function alertFingerprint(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60);
}

async function loadAlerts(
  zones: string[], points: Array<{ lat: number; lng: number }>, routeId: string, q: QueryFn,
): Promise<Array<{ title: string; severity: number; type: string | null; zonal: boolean }> | null> {
  try {
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const { rows } = await q<AlertRow>(
      // Зона отбирает как раньше. Координата, если она у события ЕСТЬ,
      // добавляет второе условие: расстояние до ближайшей опорной точки
      // маршрута. Событие без координаты этим условием не отсекается —
      // мерить нечем, и «не смогли измерить» не равно «далеко» (§4.0).
      //
      // Форма расстояния та же, что у вулканов ниже: haversine прямо в
      // запросе. Своей копии формулы здесь нет.
      `WITH anchor AS (
         SELECT unnest($2::float8[]) AS lat, unnest($3::float8[]) AS lng
       )
       SELECT title, severity::int AS severity, alert_type,
              -- Пришёл ли алерт к маршруту только по зоне (решение владельца
              -- 03.10, #2195): без координаты рядом с маршрутом, не закрытие
              -- парка и не прямой запрет туристам. Такой алерт уровня 2 даёт
              -- «Осторожно», а не «нет» — то же правило, что у статуса места.
              (
                (ea.lat IS NULL OR ea.lng IS NULL OR NOT EXISTS (SELECT 1 FROM anchor))
                AND ea.alert_type IS DISTINCT FROM 'park_closure'
                -- Прямой запрет туристам — те же шаблоны, что у классификатора
                -- (lib/services/safety/tourist-ban), параметрами $6 и $7.
                AND NOT (
                  lower(COALESCE(ea.title, '') || ' ' || COALESCE(ea.description, '')) ~ $6
                  AND lower(COALESCE(ea.title, '') || ' ' || COALESCE(ea.description, '')) ~ $7
                )
              ) AS zonal
         FROM external_alerts ea
        WHERE (ea.expires_at IS NULL OR ea.expires_at > NOW())
          AND ((
            ea.affected_zones && $1::text[]
            AND (
              ea.lat IS NULL OR ea.lng IS NULL
              OR NOT EXISTS (SELECT 1 FROM anchor)
              OR EXISTS (
                SELECT 1 FROM anchor a
                 WHERE 2 * 6371 * asin(sqrt(
                         power(sin(radians((ea.lat::float8 - a.lat) / 2)), 2)
                         + cos(radians(a.lat)) * cos(radians(ea.lat::float8))
                           * power(sin(radians((ea.lng::float8 - a.lng) / 2)), 2)
                       )) <= $4
              )
            )
          ) OR (
            -- Закрытие парка (#2133) — по парку маршрута, не по зоне: у такой
            -- тревоги зон нет вовсе. Правило то же, что у мест
            -- (PARK_SCOPED_SQL): park_name маршрута против parks.search_term.
            ea.alert_type = 'park_closure'
            AND ea.affected_parks IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM parks pk
                JOIN kamchatka_routes kr ON kr.id::text = $5
               WHERE pk.slug = ANY(ea.affected_parks)
                 AND kr.park_name ILIKE '%' || pk.search_term || '%'
            )
          ))
        ORDER BY severity DESC NULLS LAST, created_at DESC
        LIMIT 50`,
      [zones, lats, lngs, CORRIDOR_ALERT_KM, routeId, BAN_AUDIENCE.source, BAN_VERB.source],
    );
    // Порядок из запроса (важность, затем свежесть) сохраняется, поэтому
    // первой остаётся самая тяжёлая копия дубля, а не случайная.
    const seen = new Set<string>();
    const out: Array<{ title: string; severity: number; type: string | null; zonal: boolean }> = [];
    for (const r of rows) {
      const key = alertFingerprint(r.title);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: r.title,
        severity: Number.isFinite(Number(r.severity)) && r.severity !== null
          ? Number(r.severity)
          : SEVERITY_WHEN_UNSET,
        type: r.alert_type,
        // «Не установлено» не равно «зональное»: без ответа сервера алерт
        // судится как свой, то есть строже (§4.0).
        zonal: r.zonal === true,
      });
    }
    return out;
  } catch (err) {
    // «Не смогли узнать» возвращается вызывающему как null — и это верно.
    // Но молчать при этом нельзя: пустой catch превращает поломку в «данных
    // нет», и отказ проверки читается как её успех (§4.0).
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[collect-signals] предупреждения по маршруту не прочитаны, SQLSTATE ${code}:`, err);
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
 * Закрытые точки пути маршрута (issue #2079).
 *
 * `is_open = false` в `location_real_time_status` ставит администратор
 * (PATCH /api/admin/places/[id]/status). Связи рода `nearby` не судят:
 * через «рядом» не идут. `to_jsonb(rw)->>'link_kind'` — тем же приёмом, что
 * карточка маршрута: чтение переживает базу без колонки (миграция 874).
 * Сообщение точки берётся, только пока оно действует.
 *
 * Пустой массив — узнали, закрытых нет; null — не смогли узнать (§4.0).
 */
async function loadClosures(
  routeId: string, q: QueryFn,
): Promise<Array<{ place: string; reason: string | null }> | null> {
  try {
    const { rows } = await q<ClosureRow>(
      `SELECT p.name,
              CASE WHEN rs.alert_expires_at IS NULL OR rs.alert_expires_at > NOW()
                   THEN NULLIF(btrim(rs.alert_message), '') END AS reason
         FROM route_waypoints rw
         JOIN places p ON p.id = rw.place_id
         JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
        WHERE rw.route_id = $1
          AND p.is_visible = TRUE
          AND p.merged_into_id IS NULL
          AND COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'
          AND rs.is_open = FALSE
        ORDER BY rw.position`,
      [routeId],
    );
    return rows.map((r) => ({ place: r.name, reason: r.reason }));
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[collect-signals] закрытые точки маршрута не прочитаны, SQLSTATE ${code}:`, err);
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
    return { alerts: null, volcanoes: null, inSeason: null, weather: null, closures: null };
  }

  const [alerts, volcanoes, closures] = await Promise.all([
    loadAlerts(shape.zones, shape.points, routeId, q),
    loadVolcanoes(shape.points, q),
    loadClosures(routeId, q),
  ]);

  return {
    alerts,
    volcanoes,
    inSeason: isInSeason(shape.season, month),
    weather: null,
    closures,
  };
}
