/**
 * Planner Data Layer — all DB queries for real operator data.
 * Request-scoped cache (Map per recommendTrip call) prevents duplicate queries.
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { pool } from '@/lib/db-pool';
import type { ZoneId } from '@/lib/planner/engine';
import { rawTypesFor, normalizeActivity } from '@/lib/planner/constants';
import type { SelfSafetyRow } from '@/lib/planner/travel-style';

// ── Cache ────────────────────────────────────────────────────────────────────

export type PlannerCache = Map<string, unknown>;

export function createPlannerCache(): PlannerCache {
  return new Map();
}

function cached<T>(cache: PlannerCache, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as T | undefined;
  if (hit !== undefined) return Promise.resolve(hit);
  return fn().then(result => {
    cache.set(key, result);
    return result;
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RealTour {
  tourId: string;
  title: string;
  shortDescription: string | null;
  operatorName: string;
  operatorSlug: string;
  operatorRating: number;
  operatorReviewCount: number;
  operatorVerified: boolean;
  tourRating: number | null;
  tourReviewCount: number;
  basePrice: number;
  priceUnit: string;
  maxParticipants: number;
  minParticipants: number;
  durationHours: number | null;
  difficulty: string | null;
  weatherDependent: boolean;
  seasonStart: string | null;
  seasonEnd: string | null;
  /** Состав тура. `null` — оператор не заполнял; см. lodging-included. */
  included: string[] | null;
  lat: number;
  lng: number;
  zone: string;
  activityType: string;
}

export interface SlotInfo {
  date: string;
  availableSlots: number;
  bookedSlots: number;
  remaining: number;
  priceOverride: number | null;
}

export interface ZoneCapacityInfo {
  tourCount: number;
  totalSlots: number;
  totalBooked: number;
  utilizationPercent: number;
}

export interface AlternativeTour {
  tourId: string;
  title: string;
  basePrice: number;
  discountPercent: number;
  priority: number;
}

export interface ReviewSignal {
  avgRating: number;
  totalReviews: number;
  verifiedReviews: number;
  recentPositivePercent: number;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Fetch real operator tours for a zone+activity, sorted by rating (not random).
 *
 * ── `null` — это «не смогли спросить», и оно НЕ равно пустому списку ─────
 *
 * До 19.09 отказ запроса возвращал `[]`, то есть ровно то же, что «туров в
 * этой зоне нет». Движок читал это как факт о каталоге и собирал общий день,
 * а перепись того дня объяснила пустой план сезоном — при том что с тем же
 * исходом запрос мог просто упасть. Доказать было нечем: два разных мира
 * выглядели одинаково (§4.0).
 *
 * Теперь: `[]` — спросили, туров нет; `null` — спросить не вышло, и
 * вызывающий обязан сказать об этом словами, а не выдать за знание.
 *
 * Отказ кэшируется наравне с ответом — намеренно. Кэш живёт один вызов
 * `recommendTrip`, и долбиться в упавшую базу по разу на зону незачем.
 */
export async function fetchRealToursForZone(
  zone: ZoneId,
  activityType: string,
  limit: number,
  cache: PlannerCache
): Promise<RealTour[] | null> {
  return cached(cache, `tours:${zone}:${activityType}`, async () => {
    try {
      const { rows } = await pool.query<{
        tour_id: string;
        title: string;
        short_description: string | null;
        base_price: string;
        price_unit: string;
        max_participants: number;
        min_participants: number;
        duration_hours: number | null;
        difficulty: string | null;
        weather_dependent: boolean;
        season_start: string | null;
        season_end: string | null;
        lat: number;
        lng: number;
        zone: string | null;
        activity_type: string;
        included: string[] | null;
        tour_rating: string | null;
        tour_review_count: string;
        operator_name: string;
        operator_slug: string;
        operator_rating: string;
        operator_review_count: string;
        operator_verified: boolean;
      }>(
        `SELECT
          ot.id AS tour_id, ot.title, ot.short_description,
          ot.base_price, ot.price_unit,
          ot.max_participants, ot.min_participants, ot.duration_hours,
          ot.difficulty, ot.weather_dependent,
          ot.season_start::text, ot.season_end::text,
          ot.latitude AS lat, ot.longitude AS lng,
          ot.activity_type,
          ot.included,
          ark.zone,
          ot.rating AS tour_rating,
          COALESCE(ot.review_count, 0) AS tour_review_count,
          p.name AS operator_name, p.slug AS operator_slug,
          COALESCE(p.rating, 0) AS operator_rating,
          COALESCE(p.review_count, 0) AS operator_review_count,
          COALESCE(p.is_verified, false) AS operator_verified
        FROM operator_tours ot
        JOIN partners p ON p.id = ot.operator_id
        LEFT JOIN agent_route_knowledge ark ON ark.id = ot.agent_route_id
        WHERE (ark.zone = $1 OR $1 = 'avachinsky')
          AND ot.activity_type = ANY($2)
          AND ot.is_active = TRUE
          AND ot.is_published = TRUE
          AND ot.deleted_at IS NULL
          AND p.is_public = TRUE
        ORDER BY
          COALESCE(ot.rating, 0) DESC,
          COALESCE(p.rating, 0) DESC,
          ot.review_count DESC NULLS LAST,
          RANDOM()
        LIMIT $3`,
        [zone, rawTypesFor(activityType), limit]
      );

      return rows.map(r => ({
        tourId: r.tour_id,
        title: r.title,
        shortDescription: r.short_description,
        operatorName: r.operator_name,
        operatorSlug: r.operator_slug,
        operatorRating: parseFloat(String(r.operator_rating)) || 0,
        operatorReviewCount: parseInt(String(r.operator_review_count), 10) || 0,
        operatorVerified: r.operator_verified,
        tourRating: r.tour_rating ? parseFloat(String(r.tour_rating)) : null,
        tourReviewCount: parseInt(String(r.tour_review_count), 10) || 0,
        basePrice: parseFloat(String(r.base_price)) || 0,
        priceUnit: r.price_unit ?? 'per_person',
        maxParticipants: r.max_participants ?? 20,
        minParticipants: r.min_participants ?? 1,
        durationHours: r.duration_hours,
        difficulty: r.difficulty,
        weatherDependent: r.weather_dependent ?? false,
        seasonStart: r.season_start,
        seasonEnd: r.season_end,
        included: Array.isArray(r.included) ? r.included : null,
        lat: parseFloat(String(r.lat)) || 53.01,
        lng: parseFloat(String(r.lng)) || 158.65,
        zone: r.zone ?? zone,
        activityType: r.activity_type ?? activityType,
      }));
    } catch (err) {
      // Молчать нельзя: имя проверки и причина — в лог (§4.0). Пустой catch
      // превращал поломку в «данных нет».
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[planner] туры зоны не прочитались (${zone}/${activityType}):`, message);
      return null;
    }
  });
}

/**
 * Check slot availability for a specific tour in a date range.
 */
export async function fetchAvailabilityForTour(
  tourId: string,
  dateFrom: string,
  dateTo: string,
  cache: PlannerCache
): Promise<SlotInfo[]> {
  return cached(cache, `avail:${tourId}:${dateFrom}:${dateTo}`, async () => {
    try {
      // Занятость — из реальных броней, не из счётчика booked_slots:
      // счётчик пишет только payment-webhook («оплаченные участники»),
      // неоплаченные брони для него невидимы, и remaining завышался бы —
      // планировщик показывал бы места, по которым гейт бронь отклонит.
      // Статусы и кламп по max_participants — как в /api/tours/[id]/slots.
      const { rows } = await pool.query<{
        date: string;
        available_slots: number;
        booked_slots: number;
        remaining: number;
        price_override: number | null;
      }>(
        `SELECT
          ta.date::text,
          ta.available_slots,
          occ.taken AS booked_slots,
          GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) AS remaining,
          ta.base_price_override AS price_override
        FROM tour_availability ta
        JOIN operator_tours ot ON ot.id = ta.operator_tour_id
        CROSS JOIN LATERAL (
          ${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
        ) occ
        WHERE ta.operator_tour_id = $1
          AND ta.date BETWEEN $2::date AND $3::date
          AND ta.is_cancelled = FALSE
          AND ta.deleted_at IS NULL
          AND GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) > 0
        ORDER BY ta.date ASC`,
        [tourId, dateFrom, dateTo]
      );

      return rows.map(r => ({
        date: r.date,
        availableSlots: r.available_slots,
        bookedSlots: r.booked_slots,
        remaining: r.remaining,
        priceOverride: r.price_override,
      }));
    } catch {
      return [];
    }
  });
}

/**
 * Aggregate capacity utilization for a zone in a date range.
 */
export async function fetchZoneCapacity(
  zone: ZoneId,
  dateFrom: string,
  dateTo: string,
  cache: PlannerCache
): Promise<ZoneCapacityInfo> {
  return cached(cache, `cap:${zone}:${dateFrom}:${dateTo}`, async () => {
    try {
      const { rows } = await pool.query<{
        tour_count: string;
        total_slots: string;
        total_booked: string;
      }>(
        // Занятость зоны — из v_tour_daily_occupancy (реальные брони с
        // разворотом многодневных диапазонов, migration 140), не из
        // счётчика booked_slots (пишется только при оплате). VIEW считает
        // статусы 'new'/'confirmed' — уже гейткиперского NOT IN, но для
        // мягкого штрафа зоны (-10 при >80%) это допустимо, а multi-day
        // разворот тут важнее.
        `SELECT
          COUNT(DISTINCT ot.id) AS tour_count,
          COALESCE(SUM(ta.available_slots), 0) AS total_slots,
          COALESCE(SUM(COALESCE(occ.occupied, 0)), 0) AS total_booked
        FROM operator_tours ot
        LEFT JOIN agent_route_knowledge ark ON ark.id = ot.agent_route_id
        LEFT JOIN tour_availability ta ON ta.operator_tour_id = ot.id
          AND ta.date BETWEEN $2::date AND $3::date
          AND ta.is_cancelled = FALSE
        LEFT JOIN v_tour_daily_occupancy occ
          ON occ.operator_tour_id = ta.operator_tour_id
          AND occ.date = ta.date
        WHERE ark.zone = $1
          AND ot.is_active = TRUE
          AND ot.is_published = TRUE
          AND ot.deleted_at IS NULL`,
        [zone, dateFrom, dateTo]
      );

      const r = rows[0];
      const totalSlots = parseInt(String(r?.total_slots ?? '0'), 10);
      const totalBooked = parseInt(String(r?.total_booked ?? '0'), 10);
      return {
        tourCount: parseInt(String(r?.tour_count ?? '0'), 10),
        totalSlots,
        totalBooked,
        utilizationPercent: totalSlots > 0 ? Math.round((totalBooked / totalSlots) * 100) : 0,
      };
    } catch {
      return { tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 };
    }
  });
}

/**
 * Get contingency alternatives for a tour.
 */
export async function fetchContingencyAlternatives(
  tourId: string,
  cache: PlannerCache
): Promise<AlternativeTour[]> {
  return cached(cache, `alt:${tourId}`, async () => {
    try {
      const { rows } = await pool.query<{
        tour_id: string;
        title: string;
        base_price: string;
        discount_percent: number;
        priority: number;
      }>(
        `SELECT
          cr.alternative_tour_id AS tour_id,
          ot.title, ot.base_price,
          cr.discount_percent, cr.priority
        FROM contingency_rules cr
        JOIN operator_tours ot ON ot.id = cr.alternative_tour_id
        WHERE cr.primary_tour_id = $1
          AND cr.is_active = TRUE
          AND ot.is_active = TRUE
          AND ot.deleted_at IS NULL
        ORDER BY cr.priority ASC
        LIMIT 3`,
        [tourId]
      );

      return rows.map(r => ({
        tourId: r.tour_id,
        title: r.title,
        basePrice: parseFloat(String(r.base_price)) || 0,
        discountPercent: r.discount_percent ?? 0,
        priority: r.priority,
      }));
    } catch {
      return [];
    }
  });
}

/**
 * Get review quality signals for a tour or operator.
 */
export async function fetchReviewSignals(
  tourId: string,
  cache: PlannerCache
): Promise<ReviewSignal | null> {
  return cached(cache, `rev:${tourId}`, async () => {
    try {
      const { rows } = await pool.query<{
        avg_rating: string;
        total_reviews: string;
        verified_reviews: string;
        recent_positive_percent: string;
      }>(
        `SELECT
          COALESCE(AVG(rating), 0) AS avg_rating,
          COUNT(*) AS total_reviews,
          COUNT(*) FILTER (WHERE is_verified = TRUE) AS verified_reviews,
          COALESCE(
            COUNT(*) FILTER (WHERE rating >= 4 AND created_at > NOW() - INTERVAL '6 months') * 100.0 /
            NULLIF(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '6 months'), 0),
            0
          ) AS recent_positive_percent
        FROM reviews
        WHERE tour_id = $1`,
        [tourId]
      );

      const r = rows[0];
      if (!r) return null;
      const total = parseInt(String(r.total_reviews), 10);
      if (total === 0) return null;

      return {
        avgRating: parseFloat(String(r.avg_rating)) || 0,
        totalReviews: total,
        verifiedReviews: parseInt(String(r.verified_reviews), 10) || 0,
        recentPositivePercent: parseFloat(String(r.recent_positive_percent)) || 0,
      };
    } catch {
      return null;
    }
  });
}

/**
 * Активности, на которые в этом месяце РЕАЛЬНО есть на что записаться.
 *
 * ── Зачем (замер с прода 20.09, MCP `get_tours`) ─────────────────────────
 *
 * Семь живых туров из восьми — рыболовные, и один из них называется
 * «Осенняя рыбалка (октябрь-ноябрь)» с ближайшей датой 1 октября. А
 * `ACTIVITY_CONSTRAINTS.fishing.months` — `[6,7,8,9]`. То есть зашитая
 * таблица отвечала туристу «в октябре рыбалка не сезон» ровно тогда, когда
 * оператор её продаёт. Мы отказывались продавать единственное, что у нас
 * есть.
 *
 * Свидетель здесь — СЛОТ, а не объявленный `season_start`/`season_end`.
 * Слот значит «оператор открыл запись на этот день»: это его действие, а не
 * его описание, и устареть незаметно оно не может. Объявленный сезон мог бы
 * остаться с прошлого года.
 *
 * Таблица движка при этом НЕ отменяется: она остаётся полом (см.
 * `inSeason` в engine), а каталог может окно только расширить. Так сделано
 * потому, что таблица несёт не только коммерцию, но и безопасность — «снег
 * на тропах тает к середине июня». Расхождение между полом и каталогом
 * турист видит словами, а не разрешается молча в чью-то пользу (§4.0).
 *
 * `null` — спросить не вышло. Тогда действует один пол, и вызывающий
 * говорит об этом вслух: «не знаем» не равно «каталог пуст».
 */
export async function fetchActivitiesBookableInMonth(
  month: number,
  cache: PlannerCache,
): Promise<Set<string> | null> {
  return cached(cache, `bookable-month:${month}`, async () => {
    try {
      const { rows } = await pool.query<{ activity_type: string }>(
        `SELECT DISTINCT ot.activity_type
           FROM operator_tours ot
           JOIN partners p ON p.id = ot.operator_id
           JOIN tour_availability ta ON ta.operator_tour_id = ot.id
          WHERE ot.is_active = TRUE
            AND ot.is_published = TRUE
            AND ot.deleted_at IS NULL
            AND p.is_public = TRUE
            AND ta.available_slots > COALESCE(ta.booked_slots, 0)
            AND ta.date >= CURRENT_DATE
            AND EXTRACT(MONTH FROM ta.date) = $1`,
        [month],
      );
      // Слово оператора переводится в ключ движка здесь же: сравнивать их
      // будут с интересами туриста, а те — всегда ключи.
      return new Set(rows.map((r) => normalizeActivity(r.activity_type)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[planner] каталог за месяц ${month} не прочитался:`, message);
      return null;
    }
  });
}

/**
 * Данные безопасности кандидатов в самостоятельный день (стиль «Сам» и
 * подмена тура в стиле «С оператором»; правила — `lib/planner/travel-style`).
 *
 * Кандидаты приходят из `agent_route_knowledge`, где id маршрута — это
 * `COALESCE(ark_id, id)`, а id места — `places.ark_id`. Поэтому ищем по
 * обеим таблицам сразу: маршрут — в `kamchatka_routes`, место — его
 * профиль в `location_safety_profile` (`agent_route_id = places.ark_id`).
 *
 * `null` — спросить не вышло. Вызывающий обязан считать это «не знаем» и
 * НЕ ставить самостоятельный день (§4.0): отказ запроса здесь — не повод
 * разрешить человеку идти одному. Id без строки в ответе — тоже «не знаем».
 */
export async function fetchSelfSafety(
  ids: string[],
  cache: PlannerCache,
): Promise<Map<string, SelfSafetyRow> | null> {
  if (ids.length === 0) return new Map();
  const key = `self-safety:${[...ids].sort().join(',')}`;
  return cached(cache, key, async () => {
    try {
      const { rows } = await pool.query<{
        id: string;
        is_route: boolean;
        route_difficulty: string | null;
        mchs_registration_required: boolean | null;
        route_registration_required: boolean | null;
        has_profile: boolean;
        sat_communicator_required: boolean | null;
        place_registration_required: boolean | null;
      }>(
        `SELECT ids.id::text                         AS id,
                (r.id IS NOT NULL)                   AS is_route,
                r.difficulty                         AS route_difficulty,
                r.mchs_registration_required,
                r.registration_required              AS route_registration_required,
                (lsp.id IS NOT NULL)                 AS has_profile,
                lsp.sat_communicator_required,
                lsp.registration_required            AS place_registration_required
           FROM unnest($1::uuid[]) AS ids(id)
           LEFT JOIN kamchatka_routes r
             ON COALESCE(r.ark_id, r.id) = ids.id AND r.merged_into_id IS NULL
           LEFT JOIN location_safety_profile lsp
             ON lsp.agent_route_id = ids.id`,
        [ids],
      );
      const out = new Map<string, SelfSafetyRow>();
      for (const r of rows) {
        const prev = out.get(r.id);
        // Две строки маршрута на один id (дубль ark_id) сводятся строже:
        // запрет любой из них — запрет.
        out.set(r.id, {
          isRoute: (prev?.isRoute ?? false) || r.is_route,
          routeDifficulty: r.route_difficulty ?? prev?.routeDifficulty ?? null,
          mchsRegistrationRequired: prev?.mchsRegistrationRequired === true ? true : r.mchs_registration_required,
          routeRegistrationRequired: prev?.routeRegistrationRequired === true ? true : r.route_registration_required,
          hasProfile: (prev?.hasProfile ?? false) || r.has_profile,
          satCommunicatorRequired: prev?.satCommunicatorRequired === true ? true : r.sat_communicator_required,
          placeRegistrationRequired: prev?.placeRegistrationRequired === true ? true : r.place_registration_required,
        });
      }
      return out;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'unknown';
      console.error(`[planner] данные безопасности мест не прочитаны, SQLSTATE ${code} — самостоятельные дни не ставим`);
      return null;
    }
  });
}
