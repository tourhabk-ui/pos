/**
 * lib/tourist/cabinet.ts — чтения кабинета туриста на НАСТОЯЩИХ таблицах.
 *
 * ── Почему модуль, а не запросы в роутах ───────────────────────────────────
 *
 * Прогулка туристом 10.09 (issues #1770, #1771, #1772) нашла кабинет, в
 * котором не работало ничего, кроме заголовка:
 *
 *   - «Мои бронирования» падали всегда: соединение с tour_assets по
 *     `t.id = ta.tour_id` сравнивало bigint с uuid (42883), а экран рисовал на 500
 *     «Бронирований пока нет» — человек, который бронировал, видел, что не
 *     бронировал;
 *   - статистика, профиль, поездки, достижения читали tourist_trips,
 *     tourist_reviews, tourist_achievements — таблиц, которых нет ни в одной
 *     миграции и не было на проде никогда;
 *   - рекомендации спрашивали `SELECT tour_id FROM operator_bookings` (нет
 *     такой колонки) и сравнивали bigint-id с text[] — это и /api/tools
 *     закрыл параллельный PR #1781; здесь остались бронирования и кабинет.
 *
 * Юниты этого не ловили: моки отвечают `{rowCount: 0}` на любой текст. Поэтому
 * SQL кабинета собран здесь, в функциях без HTTP, и гоняется на настоящем
 * PostgreSQL — `tests/integration/tourist-cabinet.pg.test.ts` — поверх
 * baseline прода и всех миграций. Роуты только зовут и оборачивают.
 *
 * Правило §4.0: каждая функция БРОСАЕТ при отказе базы. «Пусто» и «не смог»
 * — разные ответы, и различать их обязан роут, а не молчащий catch.
 */
import { query } from '@/lib/database';

const OP_STATUS_MAP: Record<string, string> = {
  new: 'pending', confirmed: 'confirmed',
  completed: 'completed', cancelled: 'cancelled', no_show: 'completed',
};

export interface MyBooking {
  id: string;
  date: string | Date;
  participants: number;
  totalPrice: number;
  status: string;
  paymentStatus: string | null;
  specialRequests: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  tour: {
    id: string;
    name: string;
    description: string | null;
    difficulty: string | null;
    duration: number | null;
    images: string[];
  };
  operator: { name: string | null; contact: unknown };
}

interface BookingRow {
  id: string;
  booking_date: string | Date;
  participants: number;
  final_price: string | null;
  booking_status: string;
  payment_status: string | null;
  special_requests: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  tour_id: string;
  tour_title: string;
  tour_description: string | null;
  tour_difficulty: string | null;
  duration_hours: string | null;
  tour_photos: string[] | null;
  tour_image: string | null;
  operator_name: string | null;
  operator_contact: unknown;
}

function rowToBooking(row: BookingRow, idPrefix = ''): MyBooking {
  const photos = Array.isArray(row.tour_photos) ? row.tour_photos.filter((p) => typeof p === 'string' && p) : [];
  const images = photos.length ? photos : row.tour_image ? [row.tour_image] : [];
  return {
    id: `${idPrefix}${row.id}`,
    date: row.booking_date,
    participants: row.participants,
    totalPrice: row.final_price != null ? Number(row.final_price) : 0,
    status: OP_STATUS_MAP[row.booking_status] ?? row.booking_status,
    paymentStatus: row.payment_status,
    specialRequests: row.special_requests ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tour: {
      id: row.tour_id,
      name: row.tour_title,
      description: row.tour_description ?? null,
      difficulty: row.tour_difficulty ?? null,
      duration: row.duration_hours != null ? Number(row.duration_hours) : null,
      images,
    },
    operator: { name: row.operator_name ?? null, contact: row.operator_contact ?? null },
  };
}

const BOOKING_SELECT = `
  SELECT ob.id::text AS id, ob.booking_date, ob.participants,
         COALESCE(ob.final_price, ob.base_total_price)::text AS final_price,
         ob.booking_status, ob.payment_status, ob.special_requests,
         ob.created_at, ob.updated_at,
         ot.id::text AS tour_id, ot.title AS tour_title, ot.description AS tour_description,
         ot.difficulty AS tour_difficulty, ot.duration_hours::text AS duration_hours,
         ot.photos AS tour_photos, ot.tour_image,
         p.name AS operator_name, p.contact AS operator_contact
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    LEFT JOIN partners p ON p.id = ot.operator_id`;

/**
 * Брони туриста: по user_id (бронь из кабинета) и по metadata->>'user_id'
 * (гостевая бронь, привязанная позже). Фото тура — из самого тура
 * (`photos`/`tour_image`); таблица tour_assets принадлежит старой `tours` и
 * ключуется uuid, к operator_tours она не присоединяется.
 */
export async function listMyBookings(userId: string): Promise<MyBooking[]> {
  const own = await query<BookingRow>(
    `${BOOKING_SELECT}
     WHERE ob.user_id = $1 AND ob.deleted_at IS NULL
     ORDER BY ob.booking_date DESC
     LIMIT 100`,
    [userId],
  );
  // Один и тот же id — двумя параметрами: в первом сравнении он uuid, во
  // втором text, а один параметр двух типов PostgreSQL не выведет (это и
  // поймал tourist-cabinet.pg.test.ts при первом же прогоне).
  const linked = await query<BookingRow>(
    `${BOOKING_SELECT}
     WHERE ob.user_id IS DISTINCT FROM $1::uuid
       AND ob.metadata->>'user_id' = $2::text
       AND ob.deleted_at IS NULL
     ORDER BY ob.booking_date DESC
     LIMIT 100`,
    [userId, userId],
  );
  return [...own.rows.map((r) => rowToBooking(r)), ...linked.rows.map((r) => rowToBooking(r, 'op-'))]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export interface TravelStats {
  total_trips: number;
  completed_trips: number;
  upcoming_trips: number;
  active_trips: number;
  total_spent: number;
  total_reviews: number;
  average_rating_given: number | null;
  total_achievements: number;
  wishlist_count: number;
}

/**
 * Сводка поездок — из operator_bookings (что реально бронировали),
 * operator_tour_reviews (что реально написали), user_achievements и
 * tourist_wishlist. `average_rating_given` — null, когда отзывов нет: ноль
 * здесь был бы выдуманной оценкой (§4.0).
 */
export async function touristTravelStats(userId: string, touristProfileId: string | null): Promise<TravelStats> {
  const b = await query<{ total: string; completed: string; upcoming: string; active: string; spent: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE booking_status IN ('completed', 'no_show'))::text AS completed,
            COUNT(*) FILTER (WHERE booking_status IN ('new', 'confirmed') AND booking_date > CURRENT_DATE)::text AS upcoming,
            COUNT(*) FILTER (WHERE booking_status = 'confirmed' AND booking_date = CURRENT_DATE)::text AS active,
            COALESCE(SUM(COALESCE(final_price, base_total_price)) FILTER (WHERE payment_status = 'paid'), 0)::text AS spent
       FROM operator_bookings
      WHERE user_id = $1 AND deleted_at IS NULL AND booking_status <> 'cancelled'`,
    [userId],
  );
  const r = await query<{ n: string; avg: string | null }>(
    `SELECT COUNT(*)::text AS n, AVG(rating)::text AS avg
       FROM operator_tour_reviews WHERE user_id = $1 AND is_hidden = FALSE`,
    [userId],
  );
  const a = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM user_achievements WHERE user_id = $1`,
    [userId],
  );
  const w = touristProfileId
    ? await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tourist_wishlist WHERE tourist_id = $1`, [touristProfileId])
    : { rows: [{ n: '0' }] };
  const bk = b.rows[0]!;
  return {
    total_trips: Number(bk.total),
    completed_trips: Number(bk.completed),
    upcoming_trips: Number(bk.upcoming),
    active_trips: Number(bk.active),
    total_spent: Number(bk.spent),
    total_reviews: Number(r.rows[0]?.n ?? 0),
    average_rating_given: r.rows[0]?.avg != null ? Number(r.rows[0].avg) : null,
    total_achievements: Number(a.rows[0]?.n ?? 0),
    wishlist_count: Number(w.rows[0]?.n ?? 0),
  };
}

export interface TimelineRow { month: string; trips_count: number; total_spent: number }
export interface CategoryRow { trip_type: string; count: number; avg_spent: number }
export interface RecentReview { id: string; tour_id: string; tour_name: string; rating: number; comment: string; created_at: string | Date }
export interface UpcomingTrip { id: string; title: string; status: string; start_date: string | Date | null; end_date: string | Date | null }

/** Помесячно: сколько поездок состоялось и сколько на них потрачено. */
export async function tripsTimeline(userId: string): Promise<TimelineRow[]> {
  const res = await query<{ month: string; trips_count: string; total_spent: string }>(
    `SELECT to_char(date_trunc('month', booking_date), 'YYYY-MM-01') AS month,
            COUNT(*)::text AS trips_count,
            COALESCE(SUM(COALESCE(final_price, base_total_price)), 0)::text AS total_spent
       FROM operator_bookings
      WHERE user_id = $1 AND deleted_at IS NULL AND booking_status IN ('completed', 'no_show')
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    [userId],
  );
  return res.rows.map((r) => ({ month: r.month, trips_count: Number(r.trips_count), total_spent: Number(r.total_spent) }));
}

/** По типу активности тура: что человек ездит чаще всего. */
export async function categoryStats(userId: string): Promise<CategoryRow[]> {
  const res = await query<{ trip_type: string | null; count: string; avg_spent: string | null }>(
    `SELECT ot.activity_type AS trip_type, COUNT(*)::text AS count,
            AVG(COALESCE(ob.final_price, ob.base_total_price))::text AS avg_spent
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ob.user_id = $1 AND ob.deleted_at IS NULL AND ob.booking_status IN ('completed', 'no_show')
      GROUP BY ot.activity_type ORDER BY COUNT(*) DESC`,
    [userId],
  );
  return res.rows.map((r) => ({ trip_type: r.trip_type ?? 'other', count: Number(r.count), avg_spent: r.avg_spent != null ? Number(r.avg_spent) : 0 }));
}

/** Последние отзывы туриста — из operator_tour_reviews, с названием тура. */
export async function recentReviews(userId: string, limit = 5): Promise<RecentReview[]> {
  const res = await query<RecentReview>(
    `SELECT r.id::text AS id, r.tour_id::text AS tour_id, ot.title AS tour_name,
            r.rating, r.comment, r.created_at
       FROM operator_tour_reviews r
       JOIN operator_tours ot ON ot.id = r.tour_id
      WHERE r.user_id = $1 AND r.is_hidden = FALSE
      ORDER BY r.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return res.rows;
}

/** Ближайшие поездки — из user_trips (планер), не из выдуманной tourist_trips. */
export async function upcomingTrips(userId: string, limit = 5): Promise<UpcomingTrip[]> {
  const res = await query<{ id: string; title: string; arrival_date: string | null; departure_date: string | null }>(
    `SELECT id::text AS id, title, arrival_date::text AS arrival_date, departure_date::text AS departure_date
       FROM user_trips
      WHERE user_id = $1 AND deleted_at IS NULL
        AND (departure_date IS NULL OR departure_date >= CURRENT_DATE)
      ORDER BY arrival_date ASC NULLS LAST LIMIT $2`,
    [userId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.arrival_date && r.arrival_date <= new Date().toISOString().slice(0, 10) ? 'active' : 'upcoming',
    start_date: r.arrival_date,
    end_date: r.departure_date,
  }));
}

export interface Achievement { id: string; achievement_type: string; achievement_name: string; description: string | null; points: number; earned_at: string | Date }

/** Достижения — из эко-реестра (user_achievements × eco_achievements). */
export async function touristAchievements(userId: string): Promise<Achievement[]> {
  const res = await query<Achievement>(
    `SELECT ea.id::text AS id, ea.id::text AS achievement_type, ea.name AS achievement_name,
            ea.description, ea.points, ua.unlocked_at AS earned_at
       FROM user_achievements ua
       JOIN eco_achievements ea ON ea.id = ua.achievement_id
      WHERE ua.user_id = $1
      ORDER BY ua.unlocked_at DESC`,
    [userId],
  );
  return res.rows;
}
