/**
 * lib/services/data-inventory.ts
 *
 * Инвентаризация географических данных после импортов (idilesom, OSM,
 * visitkamchatka). Владелец посмотрел idilesom: одно место под разными
 * именами, маршруты и статьи вперемешку с локациями — нужен честный срез
 * того, что реально лежит в наших master-таблицах.
 *
 * READ-ONLY: только SELECT'ы, ничего не меняет. Запускается через
 * /api/cron/data-inventory (workflow печатает отчёт целиком).
 */

import { pool } from '@/lib/db-pool';

// Заголовки, похожие на статьи/коммерцию, а не на географические имена.
// Паттерны зеркалят isArticleOrCommercial из idilesom-importer + типовые
// коммерческие слова: у мест таких имён быть не должно.
const SUSPECT_NAME_SQL = `(
  name ~* '^(пока |когда |как |где |что |зачем |почему |лучш|топ |топ-|интересн|секрет|совет|история|всё что|для тех кто|маршрут |поход |подъём|путеводит|восхождение|путешествие|прогулка|экскурси|гонка|забег|тур |тур-|однодневн|многодневн)'
  OR name ~* '(глазами|километров до|дремлют|начинается россия)'
  OR length(name) > 70
)`;

export interface InventorySection {
  id: string;
  title: string;
  rows: Array<Record<string, unknown>>;
  error?: string;
}

export interface DataInventoryResult {
  generated_at: string;
  duration_ms: number;
  sections: InventorySection[];
}

interface SectionQuery {
  id: string;
  title: string;
  sql: string;
}

const SECTIONS: SectionQuery[] = [
  // ── PLACES ──────────────────────────────────────────────────────────────
  {
    id: 'places_total',
    title: 'Места: всего / видимых / с координатами',
    sql: `SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE is_visible)::int AS visible,
                 COUNT(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int AS with_coords
          FROM places`,
  },
  {
    id: 'places_by_source',
    title: 'Места: по источникам',
    sql: `SELECT COALESCE(source_name,'(без источника)') AS source, COUNT(*)::int AS n
          FROM places GROUP BY 1 ORDER BY n DESC LIMIT 15`,
  },
  {
    id: 'places_suspect_names',
    title: 'Места с именами-статьями/коммерцией (кандидаты на выпил или перенос в маршруты)',
    sql: `SELECT id, name, source_name FROM places
          WHERE ${SUSPECT_NAME_SQL}
          ORDER BY name LIMIT 100`,
  },
  {
    id: 'places_name_dupes',
    title: 'Места-дубли по нормализованному имени (ё=е, без регистра)',
    sql: `SELECT lower(translate(name,'Ёё','Ее')) AS norm_name,
                 COUNT(*)::int AS n,
                 array_agg(id ORDER BY id) AS ids,
                 array_agg(name ORDER BY id) AS names
          FROM places
          GROUP BY 1 HAVING COUNT(*) > 1
          ORDER BY n DESC, norm_name LIMIT 100`,
  },
  {
    id: 'places_coord_dupes',
    title: 'Места-дубли по координатам (< ~300 м, разные записи)',
    sql: `SELECT a.id AS id_a, a.name AS name_a, b.id AS id_b, b.name AS name_b,
                 round((sqrt(power((a.lat-b.lat)*111.32,2)+power((a.lng-b.lng)*63.5,2)))::numeric, 2) AS km
          FROM places a
          JOIN places b ON b.id > a.id
            AND b.lat BETWEEN a.lat - 0.003 AND a.lat + 0.003
            AND b.lng BETWEEN a.lng - 0.005 AND a.lng + 0.005
          WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
          ORDER BY km LIMIT 100`,
  },
  {
    id: 'places_thin',
    title: 'Места без контента: короткое описание / нет фото / нет safety-профиля',
    sql: `SELECT
            COUNT(*) FILTER (WHERE length(COALESCE(description,'')) < 300)::int AS short_description,
            COUNT(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM ai_route_images img WHERE img.route_id = places.ark_id))::int AS no_photo,
            COUNT(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM location_safety_profile sp WHERE sp.agent_route_id = places.ark_id))::int AS no_safety
          FROM places WHERE is_visible`,
  },

  // ── ROUTES / TRACKS ─────────────────────────────────────────────────────
  {
    id: 'routes_total',
    title: 'Маршруты: всего / видимых',
    sql: `SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE is_visible)::int AS visible
          FROM kamchatka_routes`,
  },
  {
    id: 'routes_by_source',
    title: 'Маршруты: по источникам',
    sql: `SELECT COALESCE(source_name,'(без источника)') AS source, COUNT(*)::int AS n
          FROM kamchatka_routes GROUP BY 1 ORDER BY n DESC LIMIT 15`,
  },
  {
    id: 'routes_geometry',
    title: 'Маршруты: происхождение geometry',
    sql: `SELECT COALESCE(geometry->>'source',
                   CASE WHEN geometry IS NULL THEN '(нет трека)' ELSE '(без метки: синтетика/vk)' END) AS geom_source,
                 COUNT(*)::int AS n
          FROM kamchatka_routes GROUP BY 1 ORDER BY n DESC`,
  },
  {
    id: 'routes_place_links',
    title: 'Треки: привязка к местам (metadata.place_ark_id) по источникам',
    sql: `SELECT COALESCE(source_name,'(без источника)') AS source,
                 COUNT(*) FILTER (WHERE metadata->>'place_ark_id' IS NOT NULL)::int AS linked,
                 COUNT(*) FILTER (WHERE metadata->>'place_ark_id' IS NULL AND geometry IS NOT NULL)::int AS unlinked_with_track
          FROM kamchatka_routes GROUP BY 1 ORDER BY linked DESC LIMIT 15`,
  },
  {
    id: 'routes_name_dupes',
    title: 'Маршруты-дубли по нормализованному названию',
    sql: `SELECT lower(translate(title,'Ёё','Ее')) AS norm_title,
                 COUNT(*)::int AS n,
                 array_agg(COALESCE(source_name,'?') ORDER BY id) AS sources
          FROM kamchatka_routes
          GROUP BY 1 HAVING COUNT(*) > 1
          ORDER BY n DESC, norm_title LIMIT 100`,
  },
  {
    id: 'routes_hidden',
    title: 'Скрытые маршруты (is_visible=false) по источникам — очередь на ревью',
    sql: `SELECT COALESCE(source_name,'(без источника)') AS source, COUNT(*)::int AS n
          FROM kamchatka_routes WHERE NOT is_visible GROUP BY 1 ORDER BY n DESC`,
  },

  // ── CROSS ───────────────────────────────────────────────────────────────
  {
    id: 'links_to_review',
    title: 'Привязки трек->место с сильно разными названиями (выборочная проверка руками)',
    sql: `SELECT k.title AS track, p.name AS place, k.source_name AS source
          FROM kamchatka_routes k
          JOIN places p ON p.ark_id::text = k.metadata->>'place_ark_id'
          WHERE lower(translate(k.title,'Ёё','Ее')) <> lower(translate(p.name,'Ёё','Ее'))
            AND substr(lower(translate(k.title,'Ёё','Ее')),1,5) <> substr(lower(translate(p.name,'Ёё','Ее')),1,5)
          ORDER BY k.title LIMIT 100`,
  },
  {
    id: 'places_multi_tracks',
    title: 'Места с несколькими привязанными треками',
    sql: `SELECT p.name AS place, COUNT(*)::int AS tracks
          FROM kamchatka_routes k
          JOIN places p ON p.ark_id::text = k.metadata->>'place_ark_id'
          GROUP BY p.name HAVING COUNT(*) > 1
          ORDER BY tracks DESC LIMIT 50`,
  },
];

export async function runDataInventory(): Promise<DataInventoryResult> {
  const t0 = Date.now();
  const results = await Promise.allSettled(SECTIONS.map(s => pool.query(s.sql)));
  const sections: InventorySection[] = SECTIONS.map((s, i) => {
    const r = results[i];
    return r.status === 'fulfilled'
      ? { id: s.id, title: s.title, rows: r.value.rows as Array<Record<string, unknown>> }
      : { id: s.id, title: s.title, rows: [], error: (r.reason as Error).message.slice(0, 200) };
  });
  return {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    sections,
  };
}
