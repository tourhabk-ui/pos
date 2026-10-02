/**
 * Данные карточки парка — один загрузчик для страницы /park/[slug] и для
 * GET /api/parks/[slug].
 *
 * До 01.10 страница была пустой оболочкой: всё содержимое клиент тянул из
 * API уже в браузере, и поисковик видел 12–13 слов без единого заголовка
 * (аудит vedarai.ru 01.10). Теперь сервер отдаёт карточку целиком, а API
 * читает тот же загрузчик — два места не разойдутся контрактом.
 *
 * Справочник — таблица parks (migration 712). Номер МЧС отсюда НЕ отдаётся:
 * региональный номер берётся из lib/safety/emergency-numbers.ts (15.09,
 * сторож tests/unit/park-emergency-number.test.ts).
 */
import { pool } from '@/lib/db-pool';

export const PARK_SLUG_RE = /^[a-z0-9-]{1,64}$/;

export interface ParkRoute {
  /** id в пространстве карточки маршрута: COALESCE(ark_id, id). */
  id: string;
  /** ЧПУ маршрута; null — ссылка по id. */
  slug: string | null;
  title: string;
  description: string | null;
  distance_km: string | null;
  elevation_gain_m: number | null;
  duration_hours: string | null;
  difficulty: string | null;
  season: string | null;
  mchs_registration_required: boolean | null;
  hazards: string[];
}

export interface ParkPermitChannels {
  email: string | null;
  officeAddress: string | null;
  officeHours: string | null;
  gosuslugiUrl: string | null;
  onlineUrl: string | null;
}

export interface ParkPageData {
  slug: string;
  displayName: string;
  description: string | null;
  zone: string | null;
  permit_url: string | null;
  /** Каналы получения разрешения (issue #367); NULL — данных нет. */
  permitChannels: ParkPermitChannels;
  routes: ParkRoute[];
  /** Маршруты не прочитались — «маршрутов нет» и «не смогли спросить» разные ответы (§4.0). */
  routesFailed: boolean;
}

interface ParkRow {
  slug: string;
  display_name: string;
  description: string | null;
  zone: string | null;
  permit_url: string | null;
  permit_email: string | null;
  permit_office_address: string | null;
  permit_office_hours: string | null;
  permit_gosuslugi_url: string | null;
  permit_online_url: string | null;
  search_term: string;
}

/**
 * null — такого парка нет (или slug не той формы). Бросает, если не ответила
 * сама база: решать, что показать, — вызывающему.
 */
export async function loadParkPage(slug: string): Promise<ParkPageData | null> {
  if (!PARK_SLUG_RE.test(slug)) return null;

  const parkResult = await pool.query<ParkRow>(
    `SELECT slug, display_name, description, zone, permit_url,
            permit_email, permit_office_address, permit_office_hours,
            permit_gosuslugi_url, permit_online_url, search_term
     FROM parks
     WHERE slug = $1 AND is_active = true
     LIMIT 1`,
    [slug]
  );
  const park = parkResult.rows[0];
  if (!park) return null;

  // Связь с маршрутами через ILIKE: park_name в kamchatka_routes заполнен
  // свободным текстом из visitkamchatka.ru. id — в пространстве карточки
  // маршрута (COALESCE(ark_id, id)): голый kr.id у записи с ark_id карточка
  // не находит, и ссылка без slug отвечала бы 404.
  let routes: ParkRoute[] = [];
  let routesFailed = false;
  try {
    const { rows } = await pool.query<Omit<ParkRoute, 'hazards'> & { hazards: string[] | null }>(`
      SELECT COALESCE(ark_id, id)::text AS id, slug, title, description,
             distance_km::text, elevation_gain_m,
             duration_hours::text, difficulty, season,
             mchs_registration_required,
             COALESCE(hazards, ARRAY[]::TEXT[]) AS hazards
      FROM kamchatka_routes
      WHERE park_name ILIKE $1
        AND is_visible = TRUE
      ORDER BY view_count DESC NULLS LAST, title
      LIMIT 12
    `, [`%${park.search_term}%`]);
    routes = rows.map((r) => ({ ...r, slug: r.slug ?? null, hazards: r.hazards ?? [] }));
  } catch (e) {
    // Маршруты не критичны для карточки — парк отдаётся без них, но отказ виден.
    const err = e as { code?: string; message?: string };
    console.error('[parks] маршруты парка не прочитаны:', slug, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    routesFailed = true;
  }

  return {
    slug: park.slug,
    displayName: park.display_name,
    description: park.description,
    zone: park.zone,
    permit_url: park.permit_url,
    permitChannels: {
      email: park.permit_email,
      officeAddress: park.permit_office_address,
      officeHours: park.permit_office_hours,
      gosuslugiUrl: park.permit_gosuslugi_url,
      onlineUrl: park.permit_online_url,
    },
    routes,
    routesFailed,
  };
}
