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
import { TOURIST_BAN_SQL } from '@/lib/services/safety/tourist-ban';
import { ALERT_MATCH_SQL, ALERT_ZONAL_ONLY_SQL } from '@/lib/services/safety/alert-place-scope';
import { CORRIDOR_VOLCANO_KM } from '@/lib/safety/corridor';

/** Минимальный контракт запроса — ровно то, что нужно сборщику. */
export type QueryFn = <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;

export interface CollectDeps {
  query: QueryFn;
  /** Месяц 1..12. Приходит снаружи: обращение к часам ломает воспроизводимость. */
  month: number;
}

export { CORRIDOR_VOLCANO_KM };

/*
 * Кого из маршрутов накрывает предупреждение — то же правило, что у мест
 * (`ALERT_MATCH_SQL`, lib/services/safety/alert-place-scope), а не своё.
 *
 * До 03.10 здесь жила своя редакция: всё с координатой — в 60 км от любой
 * опорной точки, всё без координаты — по зоне. Правило мест за это время
 * ушло вперёд решениями владельца, а маршрут остался на старом:
 *
 *   15.09 — дорожное ограничение судится в 30 км от своей точки;
 *   27.09 — дорога, пожар, извержение и закрытие парка, не привязанные к
 *           месту, не красят никого: «не установлено» ≠ «везде»;
 *   03.10 — землетрясение судится силой сотрясения, а не зоной (#2195).
 *
 * Скрин владельца 03.10, маршрут «Гора Замок», блок «Осторожно · на
 * сегодня»: «Халактырский пляж: дорога со стороны Дальнего перекрыта» (пляж
 * в 40 км, по другую сторону города) и «Вилючинский перевал: проезд по
 * пропускам» (привязки нет вовсе — висел зоной). Карточка места «Гора Замок»
 * обоих уже не показывала, карточка маршрута к ней — показывала. Две копии
 * одного правила разошлись молча, ровно как предупреждает шапка
 * alert-place-scope.
 *
 * Поэтому здесь нет ни своего радиуса, ни своей ветки зоны: маршрут
 * предъявляется предикату как набор «мест» — каждая опорная точка с каждой
 * зоной маршрута, — и предупреждение относится к маршруту, если относится
 * хоть к одной.
 */

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
        // «Рядом» не опора маршрута (§4.1): место в 15 км от центра (миграция
        // 167) расширяло коридор, по которому меряются вулканы и тревоги, на
        // то, куда маршрут не ходит. Тем же приёмом, что закрытия ниже.
        `SELECT DISTINCT p.zone, p.lat::text, p.lng::text
           FROM route_waypoints rw
           JOIN places p ON p.id = rw.place_id
          WHERE rw.route_id = $1
            AND COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'`,
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
 *
 * С 03.10 отбор — предикатом мест (`ALERT_MATCH_SQL`), см. шапку файла.
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
      // Маршрут предъявляется предикату мест как набор псевдо-мест `ark`:
      // каждая опорная точка × каждая зона маршрута. Нет опорных точек —
      // одна строка без координаты (зональные тревоги доходят, привязанные к
      // месту — нет: мерить нечем, и это то же «не установлено ≠ везде»,
      // что у мест). Нет зон — зона NULL, зональная ветка молчит (17.09).
      //
      // `id` — в пространстве VIEW (COALESCE(ark_id, id)): так закрытие
      // парка находит маршрут по park_name тем же условием, что у мест.
      `WITH anchor AS (
         SELECT unnest($2::float8[]) AS lat, unnest($3::float8[]) AS lng
       ),
       ark AS (
         -- location_type NULL: маршрут не место, и правило «морская тревога
         -- не висит на горных местах» (#2293) его не трогает.
         SELECT kr.view_id AS id, kr.title, z.zone, a.lat, a.lng, NULL::text AS location_type
           FROM (SELECT COALESCE(ark_id, id) AS view_id, title
                   FROM kamchatka_routes WHERE id::text = $4) kr
          CROSS JOIN unnest(
                 CASE WHEN cardinality($1::text[]) > 0 THEN $1::text[] ELSE ARRAY[NULL]::text[] END
               ) AS z(zone)
          CROSS JOIN (
                 SELECT lat, lng FROM anchor
                 UNION ALL
                 SELECT NULL::float8, NULL::float8 WHERE NOT EXISTS (SELECT 1 FROM anchor)
               ) a
       )
       SELECT ea.title, ea.severity::int AS severity, ea.alert_type,
              -- Пришёл ли алерт к маршруту только по зоне (решение владельца
              -- 03.10, #2195): такой уровня 2 даёт «Осторожно», а не «нет».
              -- Прямой запрет туристам зональным не считается. Признак тот
              -- же, что у статуса места (safety-ingest).
              bool_and(COALESCE(${ALERT_ZONAL_ONLY_SQL} AND NOT ${TOURIST_BAN_SQL}, false)) AS zonal
         FROM external_alerts ea
         JOIN ark ON (${ALERT_MATCH_SQL})
        WHERE (ea.expires_at IS NULL OR ea.expires_at > NOW())
        GROUP BY ea.id, ea.title, ea.severity, ea.alert_type, ea.created_at
        ORDER BY severity DESC NULLS LAST, ea.created_at DESC
        LIMIT 50`,
      [zones, lats, lngs, routeId],
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
