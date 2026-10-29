/**
 * ПОИСК · персональные рекомендации туров.
 * 3 стратегии: Similar Users, Tour Content, Eco-Optimized. Чистый SQL.
 *
 * Часть движка «Поиск» (`lib/search`). Консолидация июль 2026: перемещено из
 * `lib/recommendations/engine.ts` без изменения поведения.
 *
 * Рекомендуемый тур — тур ВИТРИНЫ: каждая стратегия отбирает кандидатов
 * шлюзом `publicTourSql` (находка аудита 15.10 P1-04). Своя копия держала
 * `is_active` и `deleted_at`, но не `is_published` — снятый с витрины тур
 * (миграции 807/808/837 снимают именно этим флагом) рекомендовался туристу,
 * а его карточка отвечала 404. Чтения истории самого туриста (профиль
 * предпочтений по его броням) шлюз не спрашивают: это его прошлое, а не
 * предложение.
 *
 * Порядок внутри стратегии (правило 1в, слово владельца 29.10): балл
 * совпадения с историей туриста — релевантность, он остаётся первым ключом;
 * ничья — правило платформы (свободная дата по ближайшему выезду, остальные —
 * жребием дня), а не рейтинг тура и не новизна. Потолок стратегии — после
 * порядка, ближайшие даты читаются одним батчем на все стратегии. Туриста без
 * истории встречают туры по правилу платформы, а не «топ по рейтингу».
 */

import { query } from '@/lib/database';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { loadNearestFreeDates } from '@/lib/tours/nearest-free-date';
import { compareTourOffers, offerOrderDay } from '@/lib/tours/offer-order';

// ── Типы ──────────────────────────────────────────────────────
export type RecommendationStrategy =
  | 'SIMILAR_USERS'
  | 'TOUR_CONTENT'
  | 'ECO_OPTIMIZED';

export interface RecommendedTour {
  id: string;
  /** Адрес карточки (ЧПУ, миграция 1114); null — ссылка по числу. */
  slug: string | null;
  title: string;
  description: string;
  price: number;
  difficulty?: string;
  duration?: number;
  category?: string;
  location?: string;
  rating?: number;
  images?: string[];
  eco_points_reward?: number;
  strategy: RecommendationStrategy;
  strategyLabel: string;
}

/** Кандидат стратегии: балл совпадения — релевантность, больше — выше. */
type Candidate = Omit<RecommendedTour, 'strategy' | 'strategyLabel'> & { match_score?: number | string | null };

/**
 * Балл совпадения DESC, ничья — правило 1в. Чистая функция, со сторожем
 * (tests/unit/tour-recommend-order.test.ts).
 */
export function orderByScoreThenRule<T extends { id: string | number; match_score?: number | string | null }>(
  rows: readonly T[],
  dates: ReadonlyMap<string, string | null>,
  day: string,
): T[] {
  const rule = compareTourOffers(day);
  const score = (r: T) => {
    const n = Number(r.match_score ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return [...rows].sort((a, b) => score(b) - score(a) || rule(
    { id: a.id, nearestFreeDate: dates.get(String(a.id)) ?? null },
    { id: b.id, nearestFreeDate: dates.get(String(b.id)) ?? null },
  ));
}

const STRATEGY_LABELS: Record<RecommendationStrategy, string> = {
  SIMILAR_USERS: 'Популярно среди похожих путешественников',
  TOUR_CONTENT: 'На основе вашей истории',
  ECO_OPTIMIZED: 'Максимум эко-баллов',
};

// ── Стратегия 1: Похожие пользователи ────────────────────────
/**
 * "Пользователи, купившие те же туры, также покупали..."
 * Находит юзеров с 2+ общими бронированиями → берёт их другие туры
 */
async function getSimilarUsersRecommendations(
  userId: string,
  bookedTourIds: string[],
  category?: string
): Promise<Candidate[]> {
  if (bookedTourIds.length === 0) return [];

  try {
    const result = await query<Candidate>(
      `SELECT DISTINCT
         t.id, t.slug, t.title, t.description,
         t.base_price                  AS price,
         t.difficulty,
         t.duration_hours              AS duration,
         t.activity_type               AS category,
         t.location_name               AS location,
         t.rating,
         t.photos AS images,
         COUNT(DISTINCT b2.user_id)::int AS match_score
       FROM operator_bookings b1
       JOIN operator_bookings b2 ON b2.operator_tour_id = b1.operator_tour_id
                                AND b2.user_id != $1
                                AND b2.booking_status IN ('confirmed', 'completed')
                                AND b2.deleted_at IS NULL
       JOIN operator_bookings b3 ON b3.user_id = b2.user_id
                                AND b3.booking_status IN ('confirmed', 'completed')
                                AND b3.deleted_at IS NULL
       JOIN operator_tours t ON t.id = b3.operator_tour_id
                            AND t.id != ALL($2::bigint[])
                            AND ${publicTourSql('t')}
                            AND ($3::text IS NULL OR t.activity_type = $3)
       WHERE b1.user_id = $1
         AND b1.booking_status IN ('confirmed', 'completed')
         AND b1.deleted_at IS NULL
       GROUP BY t.id, t.slug, t.title, t.description, t.base_price, t.difficulty,
                t.duration_hours, t.activity_type, t.location_name, t.rating,
                t.photos
       HAVING COUNT(DISTINCT b2.user_id) >= 1`,
      [userId, bookedTourIds, category ?? null]
    );

    return result.rows;
  } catch (err) {
    // Пустой catch превращал отказ в «похожих нет»: запрос джойнился по
    // фантомной operator_bookings.tour_id и падал на каждом вызове, а наружу
    // это выглядело как честный пустой ответ (§4.0). Ловим, но не молчим.
    console.error(
      '[tour-recommend] SIMILAR_USERS не выполнен:',
      err instanceof Error ? err.message : err,
      (err as { code?: string })?.code ?? '',
    );
    return [];
  }
}

// ── Стратегия 2: Content-based (по содержимому туров) ─────────
/**
 * "Потому что вам понравился [тур], вы можете оценить..."
 * Похожая категория, цена ±30%, схожая сложность
 */
async function getContentBasedRecommendations(
  bookedTourIds: string[],
  category?: string
): Promise<Candidate[]> {
  if (bookedTourIds.length === 0) return [];

  try {
    // Получаем профиль предпочтений из забронированных туров
    const profile = await query<{
      avg_price: number;
      top_category: string;
      top_difficulty: string;
    }>(
      `SELECT
         AVG(base_price)                                          AS avg_price,
         MODE() WITHIN GROUP (ORDER BY activity_type)            AS top_category,
         MODE() WITHIN GROUP (ORDER BY difficulty)               AS top_difficulty
       FROM operator_tours
       WHERE id = ANY($1::bigint[])
         AND deleted_at IS NULL`,
      [bookedTourIds]
    );

    if (profile.rows.length === 0) return [];

    const { avg_price, top_category, top_difficulty } = profile.rows[0];
    const minPrice = Math.round(avg_price * 0.7);
    const maxPrice = Math.round(avg_price * 1.3);

    const result = await query<Candidate>(
      `SELECT
         id, slug, title, description,
         base_price      AS price,
         difficulty,
         duration_hours  AS duration,
         activity_type   AS category,
         location_name   AS location,
         rating,
         photos AS images,
         (CASE WHEN activity_type = $2 THEN 3 ELSE 0 END +
          CASE WHEN difficulty = $3 THEN 2 ELSE 0 END +
          CASE WHEN base_price BETWEEN $4 AND $5 THEN 1 ELSE 0 END) AS match_score
       FROM operator_tours
       WHERE id != ALL($1::bigint[])
         AND ${publicTourSql('')}
         AND (
           activity_type = $2
           OR difficulty = $3
           OR (base_price BETWEEN $4 AND $5)
         )
         AND ($6::text IS NULL OR activity_type = $6)`,
      [bookedTourIds, top_category, top_difficulty, minPrice, maxPrice, category ?? null]
    );

    return result.rows;
  } catch (err) {
    // Ловим, но не молчим (§4.0): text[] против bigint падало на каждом вызове.
    console.error('[tour-recommend] TOUR_CONTENT не выполнен:',
      err instanceof Error ? err.message : err,
      (err as { code?: string })?.code ?? '');
    return [];
  }
}

// ── Стратегия 3: Eco-Optimized ────────────────────────────────
/**
 * "Максимизируй эко-баллы с этими турами"
 * Туры с наибольшим eco_points_reward в предпочитаемых категориях
 */
async function getEcoOptimizedRecommendations(
  bookedTourIds: string[],
  category?: string
): Promise<Candidate[]> {
  try {
    // category — явный выбор режима похода, всегда $2 (стабильная позиция)
    const params: (string | number | string[] | null)[] = [bookedTourIds, category ?? null];

    // Топ категории пользователя (если есть история) — отдельный, необязательный фильтр
    let categoryFilter = '';
    if (bookedTourIds.length > 0) {
      const cats = await query<{ category: string }>(
        `SELECT DISTINCT activity_type AS category FROM operator_tours WHERE id = ANY($1::bigint[]) AND activity_type IS NOT NULL AND deleted_at IS NULL LIMIT 3`,
        [bookedTourIds]
      );
      if (cats.rows.length > 0) {
        const categories = cats.rows.map((r) => r.category);
        categoryFilter = `AND activity_type = ANY($3::text[])`;
        params.push(categories);
      }
    }

    const result = await query<Candidate>(
      `SELECT
         id, slug, title, description,
         base_price      AS price,
         difficulty,
         duration_hours  AS duration,
         activity_type   AS category,
         location_name   AS location,
         rating,
         photos AS images, eco_points_reward,
         eco_points_reward AS match_score
       FROM operator_tours
       WHERE id != ALL($1::bigint[])
         AND ${publicTourSql('')}
         AND eco_points_reward IS NOT NULL
         AND eco_points_reward > 0
         AND ($2::text IS NULL OR activity_type = $2)
         ${categoryFilter}`,
      params
    );

    return result.rows;
  } catch (err) {
    // Колонки operator_tours.eco_points_reward нет в схеме ВООБЩЕ — ни в
    // baseline, ни в миграциях. Стратегия падала на каждом вызове, а пустой
    // catch выдавал это за «эко-туров нет». Пустой список остаётся (остальные
    // стратегии работать должны), но отказ обязан называться: чинится
    // миграцией, а не здесь.
    console.error('[tour-recommend] эко-стратегия не выполнилась:',
      err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Основная функция ──────────────────────────────────────────
export async function getRecommendations(
  userId: string,
  limit: number = 6,
  category?: string
): Promise<RecommendedTour[]> {
  // Получаем последние 5 бронирований пользователя
  // operator_tour_id, не tour_id: колонки tour_id у operator_bookings нет, и
  // рекомендации падали до первой стратегии (#1772). Id — bigint, pg отдаёт
  // строкой; ниже он всегда приводится к bigint[], не к text[].
  const bookingsResult = await query<{ tour_id: string }>(
    `SELECT operator_tour_id AS tour_id FROM operator_bookings
     WHERE user_id = $1
       AND booking_status IN ('confirmed', 'completed')
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId]
  );

  const bookedTourIds = bookingsResult.rows.map((r) => r.tour_id);

  // Запускаем все 3 стратегии параллельно
  const perStrategy = Math.ceil(limit / 3);
  const [similarAll, contentAll, ecoAll] = await Promise.all([
    getSimilarUsersRecommendations(userId, bookedTourIds, category),
    getContentBasedRecommendations(bookedTourIds, category),
    getEcoOptimizedRecommendations(bookedTourIds, category),
  ]);

  // Ближайшие свободные даты — одним батчем на все стратегии. Отказ уже в
  // логе (nearest-free-date), туры тогда идут жребием дня (§4.0).
  const day = offerOrderDay();
  const nearest = await loadNearestFreeDates([...similarAll, ...contentAll, ...ecoAll].map((r) => String(r.id)));
  const dates: ReadonlyMap<string, string | null> = nearest.state === 'ok' ? nearest.byId : new Map();
  const top = (rows: Candidate[], strategy: RecommendationStrategy): RecommendedTour[] =>
    orderByScoreThenRule(rows, dates, day).slice(0, perStrategy).map(({ match_score: _score, ...r }) => ({
      ...r,
      strategy,
      strategyLabel: STRATEGY_LABELS[strategy],
    }));
  const similar = top(similarAll, 'SIMILAR_USERS');
  const content = top(contentAll, 'TOUR_CONTENT');
  const eco = top(ecoAll, 'ECO_OPTIMIZED');

  // Дедупликация по id
  const seen = new Set<string>();
  const merged: RecommendedTour[] = [];

  for (const tour of [...similar, ...content, ...eco]) {
    if (!seen.has(tour.id) && merged.length < limit) {
      seen.add(tour.id);
      merged.push(tour);
    }
  }

  // История пустая — туры витрины по правилу платформы (с учётом category,
  // если задан), а не «топ по рейтингу»: рейтинг в порядок не входит (1в).
  if (merged.length === 0) {
    const fallback = await query<Candidate>(
      `SELECT id, slug, title, description,
              base_price     AS price,
              difficulty,
              duration_hours AS duration,
              activity_type  AS category,
              location_name  AS location,
              rating, photos AS images
       FROM operator_tours
       WHERE ${publicTourSql('')}
         AND ($1::text IS NULL OR activity_type = $1)`,
      [category ?? null]
    );
    const fbDates = await loadNearestFreeDates(fallback.rows.map((r) => String(r.id)));
    return orderByScoreThenRule(fallback.rows, fbDates.state === 'ok' ? fbDates.byId : new Map(), day)
      .slice(0, limit)
      .map(({ match_score: _score, ...r }) => ({
        ...r,
        strategy: 'TOUR_CONTENT' as const,
        strategyLabel: 'Туры платформы: сначала со свободными местами',
      }));
  }

  return merged;
}

// ── Кэширование в PostgreSQL ─────────────────────────────────
export async function getCachedRecommendations(
  userId: string
): Promise<RecommendedTour[] | null> {
  try {
    const result = await query<{
      recommendations: RecommendedTour[];
      recommended_at: Date;
    }>(
      `SELECT recommendations, recommended_at FROM users
       WHERE id = $1
         AND recommended_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );

    if (result.rows.length > 0 && result.rows[0].recommendations) {
      return result.rows[0].recommendations;
    }
  } catch {
    // Колонка может не существовать
  }
  return null;
}

export async function saveRecommendationsCache(
  userId: string,
  recommendations: RecommendedTour[]
): Promise<void> {
  try {
    await query(
      `UPDATE users
       SET recommendations = $1::jsonb, recommended_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(recommendations), userId]
    );
  } catch {
    // Не критично
  }
}
