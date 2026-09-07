import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { semanticSearch } from '@/lib/ai/embeddings';
import { getRouteSearchCache, setRouteSearchCache } from '@/lib/ai/route-knowledge';
import { lineGradeForList, type PassportGrade } from '@/lib/routes/passport';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q: z.string().min(1).max(100),
});

interface RouteRow {
  id: string;
  title: string;
  distance_km: string | null;
  difficulty_level: string | null;
  elevation_gain_m: number | null;
  zone: string | null;
  waypoint_names: string[] | null;
  /**
   * Настоящая личность путевых точек — id/координаты places, не только
   * имя (владелец 27.08: домен `Destination = place | coordinate` требует
   * `id/lat/lon` места, а не строку текста). Параллельны waypoint_names
   * (тот же FILTER/ORDER BY в SQL) — элемент i одного массива относится
   * к элементу i остальных.
   */
  waypoint_ids: string[] | null;
  waypoint_lats: string[] | null;
  waypoint_lngs: string[] | null;
  has_line: boolean;
  geometry_source: string | null;
  similarity?: number;
}

/** Род данных для бейджа в списке выбора — до фиксации маршрута. */
function withLineGrade(rows: RouteRow[]): Array<RouteRow & { line_grade: PassportGrade }> {
  return rows.map(r => ({
    ...r,
    line_grade: lineGradeForList(r.has_line, r.geometry_source, (r.waypoint_names?.length ?? 0) > 0),
  }));
}

// Колонка сложности в kamchatka_routes называется difficulty (миграция 056);
// difficulty_level здесь — имя поля ответа. Обращение r.difficulty_level
// роняло endpoint 500-кой на КАЖДЫЙ запрос (вскрылось навигаторным выбором
// маршрута по месту, 2026-07-19).
// id отдаётся в пространстве VIEW agent_route_knowledge — COALESCE(ark_id, id):
// этим id потребители (планер) идут в /api/routes/{id}, который ищет по VIEW.
// Голый r.id у маршрута с заполненным ark_id там не находился (404), а
// semantic-ветка (ids из VIEW) не проходила фильтр по r.id и молча теряла
// такие маршруты. Одно пространство id на весь путь выбора.
const ENRICH_SQL = `
  SELECT
    COALESCE(r.ark_id, r.id) AS id,
    r.title,
    r.distance_km,
    r.difficulty AS difficulty_level,
    r.elevation_gain_m,
    r.zone,
    (r.geometry IS NOT NULL) AS has_line,
    r.geometry->>'source' AS geometry_source,
    -- link_kind = 'nearby' — «это рядом, загляните», НЕ точка пути (§4.1,
    -- lib/routes/link-kind.ts). Без этого фильтра поиск по месту находил
    -- чужой маршрут, к которому это место лежит просто близко, и открывал
    -- ЕГО трек, выдавая за путь к месту, которое маршрут не посещает
    -- (владелец 07.09: «Дикие озерки» открывали трек «Зеленовские озерки»).
    ARRAY_AGG(p.name ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_names,
    ARRAY_AGG(p.id ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_ids,
    ARRAY_AGG(p.lat ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_lats,
    ARRAY_AGG(p.lng ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_lngs
  FROM kamchatka_routes r
  LEFT JOIN route_waypoints rw ON rw.route_id = r.id
  LEFT JOIN places p ON p.id = rw.place_id
  WHERE (r.id = ANY($1::uuid[]) OR r.ark_id = ANY($1::uuid[]))
    -- Живая запись — is_visible И не слита: одной видимости мало. Запись,
    -- слитую 15.08 и ошибочно возвращённую на витрину restore'ом, поиск
    -- показывал месяц — аудит и миграции её при этом живой не считали
    -- (проба 109, migrations/887_merged_rows_leave_showcase.sql).
    AND r.is_visible = TRUE AND r.merged_into_id IS NULL
  GROUP BY r.id, r.title, r.distance_km, r.difficulty, r.elevation_gain_m, r.zone
`;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({ q: searchParams.get('q') ?? '' });
  if (!parsed.success) return NextResponse.json({ routes: [], semantic: false });

  const rawQ = parsed.data.q.trim();

  // Семантический поиск для запросов ≥ 3 символов
  if (rawQ.length >= 3) {
    const cached = getRouteSearchCache(rawQ) as { routes: RouteRow[]; semantic: boolean } | null;
    if (cached) {
      return NextResponse.json({ ...cached, cache_hit: true });
    }

    try {
      const t0 = Date.now();
      const semanticResults = await semanticSearch(rawQ, 15);
      const latency_ms = Date.now() - t0;
      console.info('[search] semantic', { query_length: rawQ.length, result_count: semanticResults.length, latency_ms });

      if (semanticResults.length > 0) {
        const ids = semanticResults.map(r => r.id);
        const { rows } = await query<RouteRow>(ENRICH_SQL, [ids]);

        // Обогащаем SQL-данными, сохраняем порядок по схожести
        const byId = Object.fromEntries(rows.map(r => [r.id, r]));
        const ordered = withLineGrade(semanticResults
          .filter(r => byId[r.id])
          .map(r => ({ ...byId[r.id], similarity: r.similarity })));

        setRouteSearchCache(rawQ, { routes: ordered, semantic: true });
        return NextResponse.json({ routes: ordered, semantic: true });
      }
    } catch (err) {
      console.error('[search] semantic error', { query_length: rawQ.length, error: err instanceof Error ? err.message : String(err) });
      // Семантический поиск упал → ILIKE фоллбэк ниже
    }
  }

  // ILIKE фоллбэк: по названию маршрута ИЛИ по названию места на нём —
  // навигаторный выбор ищет именно место («Авачинский» → все маршруты через него)
  const like = `%${rawQ}%`;
  try {
    const result = await query<RouteRow>(
      `SELECT
         COALESCE(r.ark_id, r.id) AS id,
         r.title,
         r.distance_km,
         r.difficulty AS difficulty_level,
         r.elevation_gain_m,
         r.zone,
         (r.geometry IS NOT NULL) AS has_line,
         r.geometry->>'source' AS geometry_source,
         -- link_kind = 'nearby' исключается тем же способом и по той же
         -- причине, что в ENRICH_SQL выше — см. её комментарий.
         ARRAY_AGG(p.name ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_names,
         ARRAY_AGG(p.id ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_ids,
         ARRAY_AGG(p.lat ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_lats,
         ARRAY_AGG(p.lng ORDER BY rw.position) FILTER (WHERE p.name IS NOT NULL AND p.is_visible = TRUE AND COALESCE(rw.link_kind, 'unknown') <> 'nearby') AS waypoint_lngs
       FROM kamchatka_routes r
       LEFT JOIN route_waypoints rw ON rw.route_id = r.id
       LEFT JOIN places p ON p.id = rw.place_id
       WHERE r.is_visible = TRUE
         -- Не слита: см. комментарий у ENRICH_SQL (887).
         AND r.merged_into_id IS NULL
         AND (
           r.title ILIKE $1
           OR EXISTS (
             -- Поиск ПО МЕСТУ находит маршрут, только если место — точка
             -- ЕГО пути, а не просто соседствует с ним (см. комментарий выше).
             SELECT 1 FROM route_waypoints rw2
             JOIN places p2 ON p2.id = rw2.place_id
             WHERE rw2.route_id = r.id AND p2.is_visible = TRUE AND p2.name ILIKE $1
               AND COALESCE(rw2.link_kind, 'unknown') <> 'nearby'
           )
         )
         -- Компактность вейпоинтов (bbox ≤ ~55 км) ЛИБО их отсутствие:
         -- мега-сборники «35 мест по всему краю» — не проходимые треки,
         -- их синтетическая геометрия рисуется паутиной (полевой скрин 20.07).
         -- nearby-точки не входят в замер — иначе случайное «рядом» на другом
         -- конце края расширило бы bbox маршрута, которого он не заслуживает.
         AND COALESCE(
           (SELECT (MAX(p3.lat) - MIN(p3.lat)) <= 0.5 AND (MAX(p3.lng) - MIN(p3.lng)) <= 0.8
            FROM route_waypoints rw3
            JOIN places p3 ON p3.id = rw3.place_id
            WHERE rw3.route_id = r.id AND p3.lat IS NOT NULL AND p3.lng IS NOT NULL
              AND COALESCE(rw3.link_kind, 'unknown') <> 'nearby'),
           TRUE
         )
       GROUP BY r.id, r.title, r.distance_km, r.difficulty, r.elevation_gain_m, r.zone
       ORDER BY r.title
       LIMIT 15`,
      [like],
    );
    return NextResponse.json({ routes: withLineGrade(result.rows), semantic: false });
  } catch (err) {
    // В поле лучше пустой список, чем 500 — UI покажет «ничего не нашлось»
    console.error('[search] fallback error', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ routes: [], semantic: false });
  }
}
