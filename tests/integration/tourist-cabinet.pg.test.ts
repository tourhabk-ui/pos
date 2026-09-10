/**
 * Кабинет туриста на настоящем PostgreSQL — поверх схемы прода.
 *
 * ── Почему этот файл существует ─────────────────────────────────────────
 *
 * Прогулка туристом 10.09 (issues #1769–#1773) нашла кабинет, в котором не
 * работало ничего, кроме заголовка: «Мои бронирования» падали на JOIN
 * bigint = uuid, рекомендации — на text[] против bigint-id и на колонке,
 * которой нет, статистика и профиль читали таблицы, которых не было ни в
 * одной миграции. Полный юнит-прогон был зелёным: моки отвечают
 * `{rowCount: 0}` на любой текст запроса. Форму SQL доказывает только
 * сервер (§4.0 «судить статикой запрещено») — и он здесь.
 *
 * Схема — не рукописный DDL, а тот же путь, что у деплоя: baseline прода
 * (`scripts/bootstrap-from-baseline.js`) плюс все миграции новее него
 * (`lib/database/migrate.ts`). Значит запрос, проходящий здесь, проходит на
 * проде; расхождение с прод-схемой ловит `GET /api/cron/schema-drift`.
 *
 * Своя база `tourist_cabinet_test`: модули кабинета пишут через пул
 * приложения (`@/lib/db-pool`), который теряет параметры строки соединения,
 * поэтому изолироваться схемой нельзя — только именем базы (тот же приём, что
 * у alert-dedup.pg.test.ts).
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tourist-cabinet.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'tourist_cabinet_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = '863';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

if (PG_URL) {
  process.env.DATABASE_URL = withDatabase(PG_URL, TEST_DB);
  process.env.DATABASE_SSL = 'false';
}

type Cabinet = typeof import('@/lib/tourist/cabinet');
type Recommend = typeof import('@/lib/search/tour-recommend');

withPg('кабинет туриста на настоящем PostgreSQL', () => {
  let cabinet: Cabinet;
  let recommend: Recommend;
  let pool: import('pg').Pool;
  let userId = '';
  let otherUserId = '';
  let profileId = '';
  let operatorId = '';
  let tourId = 0;
  let secondTourId = 0;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    // Каждый прогон — с чистого листа: схема прода обязана собираться из
    // baseline и миграций, а не жить от прогона к прогону.
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    await pool.query(`DELETE FROM _migrations WHERE name >= $1`, [FIRST_AFTER_BASELINE]);
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    // Посев: два туриста, оператор, два тура, брони, отзыв, поездка планера.
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('cab-a@example.com', 'Турист А', 'x', 'tourist') RETURNING id`,
    );
    userId = u.rows[0].id;
    const u2 = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('cab-b@example.com', 'Турист Б', 'x', 'tourist') RETURNING id`,
    );
    otherUserId = u2.rows[0].id;
    const pr = await pool.query<{ id: string }>(
      `INSERT INTO tourist_profiles (user_id, full_name) VALUES ($1, 'Турист А') RETURNING id`, [userId],
    );
    profileId = pr.rows[0].id;
    const op = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Оператор кабинета', 'operator', '{"phone":"+70000000000"}', TRUE, TRUE, 'cab-op') RETURNING id`,
    );
    operatorId = op.rows[0].id;
    const t1 = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty, photos, duration_hours)
       VALUES ($1, 'Тур кабинета', 5000, 10, TRUE, TRUE, 'hiking', 'easy', ARRAY['/images/a.jpg'], 6) RETURNING id`, [operatorId],
    );
    tourId = Number(t1.rows[0].id);
    const t2 = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty, duration_hours)
       VALUES ($1, 'Второй тур', 7000, 10, TRUE, TRUE, 'hiking', 'medium', 8) RETURNING id`, [operatorId],
    );
    secondTourId = Number(t2.rows[0].id);

    // Бронь А на тур 1 (завершена, оплачена); бронь Б на тур 1 и тур 2 —
    // «похожие пользователи» для рекомендаций.
    await pool.query(
      `INSERT INTO operator_bookings (operator_tour_id, user_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, tourist_name)
       VALUES ($1, $2, CURRENT_DATE - 30, 2, 10000, 10000, 'completed', 'paid', 'Турист А'),
              ($1, $3, CURRENT_DATE - 20, 1, 5000, 5000, 'confirmed', 'paid', 'Турист Б'),
              ($4, $3, CURRENT_DATE + 10, 1, 7000, 7000, 'confirmed', 'pending', 'Турист Б')`,
      [tourId, userId, otherUserId, secondTourId],
    );
    await pool.query(
      `INSERT INTO operator_tour_reviews (tour_id, author_name, rating, comment, user_id) VALUES ($1, 'Турист А', 5, 'Отлично', $2)`,
      [tourId, userId],
    );
    await pool.query(
      `INSERT INTO user_trips (user_id, title, arrival_date, departure_date) VALUES ($1, 'Поездка планера', CURRENT_DATE + 5, CURRENT_DATE + 9)`,
      [userId],
    );

    cabinet = await import('@/lib/tourist/cabinet');
    recommend = await import('@/lib/search/tour-recommend');
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
    await bootstrap.end().catch(() => undefined);
  });

  it('«Мои бронирования» возвращают бронь с туром, оператором и фото (#1770)', async () => {
    const list = await cabinet.listMyBookings(userId);
    expect(list).toHaveLength(1);
    expect(list[0].tour.name).toBe('Тур кабинета');
    expect(list[0].tour.images).toEqual(['/images/a.jpg']);
    expect(list[0].operator.name).toBe('Оператор кабинета');
    expect(list[0].totalPrice).toBe(10000);
    expect(list[0].status).toBe('completed');
  });

  it('сводка считается по настоящим таблицам, средняя оценка — из отзывов, а не 0 (#1771)', async () => {
    const s = await cabinet.touristTravelStats(userId, profileId);
    expect(s.completed_trips).toBe(1);
    expect(s.total_spent).toBe(10000);
    expect(s.total_reviews).toBe(1);
    expect(s.average_rating_given).toBe(5);
    expect(s.wishlist_count).toBe(0);
    const empty = await cabinet.touristTravelStats(otherUserId, null);
    expect(empty.average_rating_given).toBeNull();
  });

  it('таймлайн, категории, отзывы и ближайшие поездки не падают и отражают посев', async () => {
    expect(await cabinet.tripsTimeline(userId)).toHaveLength(1);
    expect((await cabinet.categoryStats(userId))[0]?.trip_type).toBe('hiking');
    expect((await cabinet.recentReviews(userId))[0]?.tour_name).toBe('Тур кабинета');
    const up = await cabinet.upcomingTrips(userId);
    expect(up).toHaveLength(1);
    expect(up[0].title).toBe('Поездка планера');
    expect(await cabinet.touristAchievements(userId)).toEqual([]);
  });

  it('избранное: миграция 949 даёт таблицу, INSERT … ON CONFLICT роута работает', async () => {
    const ins = await pool.query(
      `INSERT INTO tourist_wishlist (tourist_id, item_type, item_id, priority, notes, notify_on_discount, notify_on_availability)
       VALUES ($1, 'tour', $2, 'medium', NULL, FALSE, FALSE)
       ON CONFLICT (tourist_id, item_type, item_id) DO UPDATE SET priority = EXCLUDED.priority
       RETURNING id`, [profileId, String(tourId)],
    );
    expect(ins.rowCount).toBe(1);
    expect((await cabinet.touristTravelStats(userId, profileId)).wishlist_count).toBe(1);
    const prefs = await pool.query(
      `INSERT INTO tourist_notification_preferences (tourist_id) VALUES ($1) RETURNING push_recommendations, language`, [profileId],
    );
    expect(prefs.rows[0].language).toBe('ru');
  });

  it('рекомендации выполняются: bigint-id против bigint[] (#1772)', async () => {
    // Турист А бронировал тур 1; Б бронировал тур 1 и тур 2 → «похожие» дают тур 2.
    const recs = await recommend.getRecommendations(userId, 6);
    expect(recs.some((r) => String(r.id) === String(secondTourId))).toBe(true);
    // Ни одна стратегия не должна вернуть уже забронированный тур.
    expect(recs.some((r) => String(r.id) === String(tourId))).toBe(false);
  });

  it('каталог инструментов: запрос категорий выполняется (#1773)', async () => {
    const r = await pool.query(
      `SELECT category, count(*)::text AS cnt FROM external_tools WHERE verified = TRUE GROUP BY category ORDER BY count(*) DESC`,
    );
    expect(Array.isArray(r.rows)).toBe(true);
  });
});
