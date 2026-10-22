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
 * (`lib/database/migrate.ts`), собранные один раз в шаблон
 * (`tests/helpers/pg-schema.ts`). Значит запрос, проходящий здесь, проходит на
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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createTestDatabase, withDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tourist-cabinet.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

// Вход в роут беседы (P2-02) — от имени туриста посева, в кабинет оператора
// (отмена брони с причиной, #2327) — от имени оператора. Остальное из
// middleware настоящее: подменяется только проверка JWT; права в команде
// оператора (operatorAccess) проверяются по настоящей базе.
const authAs = vi.hoisted(() => ({ userId: '', role: 'tourist' }));
vi.mock('@/lib/auth/middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/middleware')>()),
  requireAuth: async () => ({ ...authAs }),
  requireOperator: async () => ({ ...authAs }),
  // Стирание карточки CRM по обращению (#2327, круг 10) — от имени администратора.
  requireAdmin: async () => (authAs.role === 'admin'
    ? { ...authAs }
    : (await import('next/server')).NextResponse.json({ success: false }, { status: 403 })),
}));
// Роут отмены брони туристом проверяет вход сам (verifyAuth) — тот же человек.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  verifyAuth: async () => ({ userId: authAs.userId, role: authAs.role, email: null, isAuthenticated: true }),
}));

const TEST_DB = 'tourist_cabinet_test';

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
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

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

  it('отзыв о МЕСТЕ записывается: триггеры рейтинга из baseline сняты (обход 26.09)', async () => {
    // Прогулка туристом 26.09: POST /api/places/<id>/reviews отвечал 500
    // `record "new" has no field "operator_id"`. Падал не INSERT, а триггер
    // `update_partner_rating_trigger` из baseline: функция читает
    // NEW.operator_id, которой у `reviews` нет. Значит отзыв о месте не
    // сохранялся НИ РАЗУ, а пустой блок отзывов читался как «никто не
    // оценил» (§4.0). Миграция 1037 снимает оба легаси-триггера.
    //
    // Сторож стоит здесь, а не в юнитах, намеренно: поля записи PL/pgSQL
    // проверяет на исполнении, статикой этого не видно — судит сервер.
    const ark = '0f2d5c7a-1b44-4e9c-9a31-8c6e5d2f7b10';
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, is_visible)
       VALUES ('place-review-probe', 'Место для отзыва', 53.1, 158.2, $1, 'volcano', TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [ark],
    );
    const ins = await pool.query(
      `INSERT INTO reviews (place_id, rating, comment, author_name, is_verified)
       VALUES ($1, 5, 'Тропа читается, на кромке сильный ветер.', 'Турист', FALSE)
       RETURNING id`,
      [ark],
    );
    expect(ins.rowCount).toBe(1);

    const left = await pool.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'reviews'::regclass
         AND NOT t.tgisinternal
         AND p.proname IN ('update_partner_rating', 'update_tour_rating')`,
    );
    expect(left.rows.map((r) => r.tgname)).toEqual([]);
  });

  it('миграция 1100 узнаёт шаблон 070 и не трогает то, чего не доказала', async () => {
    // Обход 26.09: опасности, лимит и сложность у мест выведены миграцией 070
    // из location_type, а карточка печатала их как факты. Прятать можно только
    // ДОКАЗАННУЮ выдумку, поэтому 1033 сверяет отпечаток по пяти полям сразу.
    //
    // Тест исполняет СОБСТВЕННЫЙ запрос миграции, а не его пересказ: правило,
    // написанное дважды, — это два правила, и они расходятся (§12).
    const sql = readFileSync(
      join(process.cwd(), 'migrations/1100_safety_profile_source.sql'),
      'utf-8',
    );
    const start = sql.indexOf('WITH k AS (');
    const end = sql.indexOf('AND lsp.profile_source IS NULL;', start);
    expect(start, 'в миграции 1100 не найден запрос разметки').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const classify = sql.slice(start, end + 'AND lsp.profile_source IS NULL;'.length);

    const templ = 'a1a1a1a1-0000-4000-8000-000000000001';
    const hand = 'a1a1a1a1-0000-4000-8000-000000000002';
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, is_visible)
       VALUES ('place-template-probe', 'Вулкан шаблонный', 53.2, 158.3, $1, 'volcano', TRUE),
              ('place-hand-probe',     'Озеро с записью',  53.3, 158.4, $2, 'lake',    TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [templ, hand],
    );
    // Ровно то, что писал шаблон 070 для вулкана.
    await pool.query(
      `INSERT INTO location_safety_profile
         (agent_route_id, capacity_per_day, optimal_group_size, difficulty_level, terrain_type, hazard_types)
       VALUES ($1, 30, 6, 4, 'mountain', ARRAY['avalanche','rockfall','thermal','altitude']::TEXT[])`,
      [templ],
    );
    // Тронуто человеком: одно поле отличается от шаблона для типа lake.
    await pool.query(
      `INSERT INTO location_safety_profile
         (agent_route_id, capacity_per_day, optimal_group_size, difficulty_level, terrain_type, hazard_types)
       VALUES ($1, 12, 8, 2, 'forest', ARRAY['bears']::TEXT[])`,
      [hand],
    );
    await pool.query(
      `UPDATE location_safety_profile SET profile_source = NULL WHERE agent_route_id IN ($1, $2)`,
      [templ, hand],
    );

    await pool.query(classify);

    const got = await pool.query<{ agent_route_id: string; profile_source: string | null }>(
      `SELECT agent_route_id::text AS agent_route_id, profile_source
         FROM location_safety_profile WHERE agent_route_id IN ($1, $2)`,
      [templ, hand],
    );
    const bySource = new Map(got.rows.map((r) => [r.agent_route_id, r.profile_source]));
    expect(bySource.get(templ)).toBe('type_template');
    expect(bySource.get(hand)).toBe('unknown');
  });

  it('«Написать оператору» с карточки тура открывает беседу: id тура не пишется в ссылку на tours (P2-02)', async () => {
    // Аудит 15.10, P2-02. На проде conversations.tour_id — uuid с внешним
    // ключом на запрещённую `tours` (baseline; 714 через IF NOT EXISTS её не
    // тронула), а кнопка шлёт operator_tours.id (bigint). Прежний INSERT
    // писал его туда и падал 22P02 «invalid input syntax for type uuid» —
    // беседа с карточки тура не открывалась ни разу. Мок пула ответил бы на
    // любую форму; тип колонки знает только сервер.
    const opUser = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('cab-chat-op@example.com', 'Оператор чата', 'x', 'operator') RETURNING id`,
    );
    const chatPartner = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, user_id)
       VALUES ('Оператор чата', 'operator', '{"phone":"+70000000001"}', TRUE, TRUE, 'cab-chat-op', $1) RETURNING id`,
      [opUser.rows[0].id],
    );
    authAs.userId = userId;
    authAs.role = 'tourist';

    const { POST } = await import('@/app/api/chat/conversations/route');
    const res = await POST(
      new Request('http://localhost/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Ровно тело components/marketplace/MessageOperatorButton.tsx.
        body: JSON.stringify({ operatorPartnerId: chatPartner.rows[0].id, tourId, subject: 'Тур кабинета' }),
      }) as unknown as NextRequest,
    );
    const json = (await res.json()) as { data?: { conversationId: string; created: boolean }; details?: string };
    expect(res.status, json.details ?? '').toBe(201);

    const conv = await pool.query<{ subject: string | null; tour_id: string | null; booking_id: string | null }>(
      `SELECT subject, tour_id::text AS tour_id, booking_id::text AS booking_id FROM conversations WHERE id = $1`,
      [json.data?.conversationId],
    );
    expect(conv.rows).toEqual([{ subject: 'Тур кабинета', tour_id: null, booking_id: null }]);
    const members = await pool.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY role`,
      [json.data?.conversationId],
    );
    expect(members.rows.map((r) => r.user_id).sort()).toEqual([opUser.rows[0].id, userId].sort());
  });

  it('каталог инструментов: запрос категорий выполняется (#1773)', async () => {
    const r = await pool.query(
      `SELECT category, count(*)::text AS cnt FROM external_tools WHERE verified = TRUE GROUP BY category ORDER BY count(*) DESC`,
    );
    expect(Array.isArray(r.rows)).toBe(true);
  });

  // ── Удаление аккаунта и отзыв согласия (152-ФЗ, аудит кабинета 20.10) ──
  // Своя пара туристов: стирание необратимо, общий посев не трогаем.
  async function freshTourist(tag: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, phone, telegram_id)
       VALUES ($1, 'Стираемый ' || $2, 'x', 'tourist', '+79990000000', $3) RETURNING id`,
      [`erase-${tag}@example.com`, tag, 900000 + Math.floor(Math.random() * 99999)],
    );
    return r.rows[0].id;
  }
  async function callDelete(uid: string, body: Record<string, unknown>) {
    authAs.userId = uid;
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/user/delete/route');
    const res = await POST(new NextRequest('http://localhost/api/user/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as unknown as NextRequest);
    authAs.userId = userId;
    return {
      status: res.status,
      json: await res.json() as {
        success: boolean; error?: string; blockers?: string[]; message?: string;
        kept?: Array<{ category: string; why: string; count: number }>;
        unchecked?: Array<{ category: string; why: string }>;
        crm?: { cards: number; partners: number };
      },
    };
  }

  it('удаление: без слова-подтверждения — 422, ничего не стёрто', async () => {
    const uid = await freshTourist('nophrase');
    const r = await callDelete(uid, { confirm: true, phrase: 'да' });
    expect(r.status).toBe(422);
    const u = await pool.query(`SELECT email FROM users WHERE id = $1`, [uid]);
    expect(u.rows[0].email).toBe('erase-nophrase@example.com');
  });

  it('удаление: предстоящая заявка блокирует (409), прошедшая — обезличивается', async () => {
    const uid = await freshTourist('booked');
    const b = await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, tourist_email, booking_status)
       VALUES ($1, CURRENT_DATE + 10, 2, $2, 'Иван', '+79991112233', 'ivan@example.com', 'confirmed') RETURNING id`,
      [tourId, uid],
    );
    const blocked = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(blocked.status).toBe(409);
    expect(blocked.json.blockers).toEqual(['upcoming_booking']);

    await pool.query(`UPDATE operator_bookings SET booking_date = CURRENT_DATE - 30, booking_status = 'completed' WHERE id = $1`, [b.rows[0].id]);
    await pool.query(`INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, 'erase-token', NOW() + interval '1 day')`, [uid]);
    await pool.query(`INSERT INTO tourist_profiles (user_id, full_name, emergency_contact_name, emergency_contact_phone) VALUES ($1, 'Иван', 'Мама', '+79990001122')`, [uid]);
    const ok = await callDelete(uid, { confirm: true, phrase: 'удалить', mode: 'revoke_consent' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    const bk = await pool.query(`SELECT tourist_name, tourist_phone, tourist_email, booking_status, user_id::text AS uid FROM operator_bookings WHERE id = $1`, [b.rows[0].id]);
    expect(bk.rows[0]).toEqual({ tourist_name: 'Удалённый пользователь', tourist_phone: null, tourist_email: null, booking_status: 'completed', uid });
    const u = await pool.query(`SELECT email, name, phone, telegram_id, is_active, pd_consent_given, metadata->>'erase_reason' AS why FROM users WHERE id = $1`, [uid]);
    expect(u.rows[0]).toEqual({
      email: `deleted-${uid}@deleted.invalid`, name: 'Удалённый пользователь', phone: null, telegram_id: null,
      is_active: false, pd_consent_given: false, why: 'consent_revoked',
    });
    expect((await pool.query(`SELECT 1 FROM user_sessions WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM tourist_profiles WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
  });

  it('удаление: незакрытая регистрация маршрута блокирует (409)', async () => {
    const uid = await freshTourist('route');
    await pool.query(
      `INSERT INTO route_registrations (user_id, route_name, start_date, end_date, group_size, leader_name, leader_phone, emergency_contact_name, emergency_contact_phone)
       VALUES ($1, 'Авачинский', CURRENT_DATE, CURRENT_DATE + 1, 1, 'Иван', '+7999', 'Мама', '+7998')`, [uid],
    );
    const r = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(r.status).toBe(409);
    expect(r.json.blockers).toEqual(['active_route_registration']);
  });

  it('удаление: документы, участники группы, заказ мест, заявка в операторы и медицинское в отказе стираются (#2327)', async () => {
    // Хвост #2612: эти строки пережили удаление, хотя ответ говорил «стёрты».
    // Документы ссылаются на анкету без внешнего ключа (903) и после DELETE
    // анкеты оставались ничьими; спутники и медицинское — в строках брони.
    // Запроса мест здесь нет: бронь из него заводится без user_id
    // (lib/seat-requests/service.ts), и по человеку его не найти — это
    // запись tour_seat_requests в ERASE_KEEP, а не шаг стирания.
    const uid = await freshTourist('tail');
    const prof = await pool.query<{ id: string }>(
      `INSERT INTO tourist_profiles (user_id, full_name) VALUES ($1, 'Иван') RETURNING id`, [uid],
    );
    await pool.query(
      `INSERT INTO tourist_documents (tourist_id, document_type, document_number, file_url)
       VALUES ($1, 'passport', '4510 123456', 'https://example.com/doc.jpg')`, [prof.rows[0].id],
    );
    await pool.query(
      `INSERT INTO tourist_wishlist (tourist_id, item_type, item_id, notes) VALUES ($1, 'tour', '1', 'с женой в июле')`,
      [prof.rows[0].id],
    );
    // Чужой документ и чужой спутник — контроль: стирается только своё.
    const foreignDoc = await pool.query<{ id: string }>(
      `INSERT INTO tourist_documents (tourist_id, document_type, document_number)
       VALUES ($1, 'passport', '4510 999999') RETURNING id`, [profileId],
    );
    const b = await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, booking_status,
         notes, special_requests, pd_consent_ip)
       VALUES ($1, CURRENT_DATE - 20, 2, $2, 'Иван', '+79991112233', 'completed',
         'Telegram: @ivan_k, просил трансфер', 'диабет, нужна остановка', '203.0.113.7') RETURNING id`,
      [tourId, uid],
    );
    const bookingId = b.rows[0].id;
    const member = await pool.query<{ id: number }>(
      `INSERT INTO booking_group_members (booking_id, full_name, phone, passport_number, passport_encrypted,
         emergency_contact_name, emergency_contact_phone, dietary_restrictions, medical_notes, medical_encrypted,
         consent_given_at, mchs_reference)
       VALUES ($1, 'Пётр Спутник', '+79990002233', '4510 654321', '\\x01'::bytea,
         'Жена Петра', '+79990003344', 'без глютена', 'астма', '\\x02'::bytea, NOW(), 'МЧС-77') RETURNING id`,
      [bookingId],
    );
    const otherBooking = await pool.query<{ id: string }>(
      `SELECT id FROM operator_bookings WHERE user_id = $1 ORDER BY id LIMIT 1`, [otherUserId],
    );
    const foreignMember = await pool.query<{ id: number }>(
      `INSERT INTO booking_group_members (booking_id, full_name, phone) VALUES ($1, 'Чужой Спутник', '+79995556677') RETURNING id`,
      [otherBooking.rows[0].id],
    );
    await pool.query(
      `INSERT INTO booking_waivers (booking_id, user_id, signer_name, risks_acknowledged, fit_to_participate,
         medical_conditions, allergies, emergency_contact_name, emergency_contact_phone)
       VALUES ($1, $2, 'Иван', TRUE, TRUE, 'диабет', 'пенициллин', 'Мама', '+79990001122')`,
      [bookingId, uid],
    );
    const vehicle = await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Вахтовка', 20) RETURNING id`,
      [operatorId],
    );
    const trip = await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, status)
       VALUES ($1, CURRENT_DATE - 20, 'Петропавловск', 'Мутновский', 20, 'completed') RETURNING id`,
      [vehicle.rows[0].id],
    );
    const seat = await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status, contact_phone, comment)
       VALUES ($1, $2, 2, 'confirmed', '+79991112233', 'возьмём рюкзаки') RETURNING id`,
      [trip.rows[0].id, uid],
    );
    const app = await pool.query<{ id: string }>(
      `INSERT INTO operator_applications (partner_id, user_id, company_name, contact_phone, contact_email, inn)
       VALUES ($1, $2, 'ИП Иванов', '+79991112233', 'ivan-op@example.com', '410100000000') RETURNING id`,
      [operatorId, uid],
    );
    // Заметки о нём как о клиенте: карточка оператора (с ником в Telegram)
    // удаляется; карточка CRM с его аккаунтом, без чужих записей и без
    // записей партнёра — его и стирается (с записями партнёра — нет,
    // тест (а'') круга 10).
    await pool.query(
      `INSERT INTO operator_client_notes (operator_id, user_id, tags, telegram) VALUES ($1, $2, ARRAY['vip'], '@ivan_k')`,
      [operatorId, uid],
    );
    const crm = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (partner_id, user_id, display_name, phone, origin, pd_consent_at, pd_consent_ip)
       VALUES ($1, $2, 'Иван', '+79991112233', 'operator_booking', NOW(), '203.0.113.7') RETURNING id`,
      [operatorId, uid],
    );
    await pool.query(
      `INSERT INTO user_ai_memory (user_id, travel_style, ai_notes) VALUES ($1, 'активный', 'боится высоты')`, [uid],
    );
    // Он же менеджер в команде оператора с привязанными чатами.
    const member2 = await pool.query<{ id: string }>(
      `INSERT INTO operator_members (partner_id, user_id, status, accepted_at, max_chat_id, telegram_chat_id, channel_bound_at)
       VALUES ($1, $2, 'active', NOW(), 5551001, 5551002, NOW()) RETURNING id`,
      [operatorId, uid],
    );

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    expect((await pool.query(`SELECT 1 FROM tourist_documents WHERE tourist_id = $1`, [prof.rows[0].id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM tourist_wishlist WHERE tourist_id = $1`, [prof.rows[0].id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT document_number FROM tourist_documents WHERE id = $1`, [foreignDoc.rows[0].id])).rows)
      .toEqual([{ document_number: '4510 999999' }]);

    expect((await pool.query(
      `SELECT notes, special_requests, pd_consent_ip, booking_status FROM operator_bookings WHERE id = $1`, [bookingId],
    )).rows).toEqual([{ notes: null, special_requests: null, pd_consent_ip: null, booking_status: 'completed' }]);
    const m = await pool.query(
      `SELECT full_name, phone, passport_number, passport_encrypted, emergency_contact_name, emergency_contact_phone,
              dietary_restrictions, medical_notes, medical_encrypted, consent_given_at IS NOT NULL AS consent_kept, mchs_reference
         FROM booking_group_members WHERE id = $1`, [member.rows[0].id],
    );
    expect(m.rows[0]).toEqual({
      full_name: 'Удалённый пользователь', phone: null, passport_number: null, passport_encrypted: null,
      emergency_contact_name: null, emergency_contact_phone: null, dietary_restrictions: null,
      medical_notes: null, medical_encrypted: null, consent_kept: true, mchs_reference: 'МЧС-77',
    });
    expect((await pool.query(`SELECT full_name, phone FROM booking_group_members WHERE id = $1`, [foreignMember.rows[0].id])).rows)
      .toEqual([{ full_name: 'Чужой Спутник', phone: '+79995556677' }]);

    expect((await pool.query(
      `SELECT signer_name, medical_conditions, allergies, emergency_contact_phone FROM booking_waivers WHERE booking_id = $1`, [bookingId],
    )).rows).toEqual([{ signer_name: 'Удалённый пользователь', medical_conditions: null, allergies: null, emergency_contact_phone: '' }]);
    expect((await pool.query(
      `SELECT contact_phone, comment, seats, status FROM transfer_seat_bookings WHERE id = $1`, [seat.rows[0].id],
    )).rows).toEqual([{ contact_phone: null, comment: null, seats: 2, status: 'confirmed' }]);
    expect((await pool.query(
      `SELECT contact_phone, contact_email, company_name FROM operator_applications WHERE id = $1`, [app.rows[0].id],
    )).rows).toEqual([{ contact_phone: null, contact_email: null, company_name: 'ИП Иванов' }]);
    expect((await pool.query(`SELECT 1 FROM operator_client_notes WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
    expect((await pool.query(
      `SELECT display_name, phone, notes, pd_consent_ip, pd_consent_at IS NOT NULL AS consent_kept FROM crm_contacts WHERE id = $1`,
      [crm.rows[0].id],
    )).rows).toEqual([{ display_name: 'Удалённый пользователь', phone: null, notes: null, pd_consent_ip: null, consent_kept: true }]);
    expect((await pool.query(`SELECT 1 FROM user_ai_memory WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
    expect((await pool.query(
      `SELECT status, revoked_at IS NOT NULL AS revoked, max_chat_id, telegram_chat_id, channel_bound_at FROM operator_members WHERE id = $1`,
      [member2.rows[0].id],
    )).rows).toEqual([{ status: 'revoked', revoked: true, max_chat_id: null, telegram_chat_id: null, channel_bound_at: null }]);
  });

  it('удаление: переписка с Кузьмичом в Telegram и MAX стирается по id в мессенджере, чужая — нет (#2327)', async () => {
    // Ключ к переписке — id в мессенджере, и живёт он только в users: шаг
    // tg_conversations обязан пройти ДО обнуления users.telegram_id и
    // max_user_id. Telegram: chat_id лички = id человека, user_id — тоже он;
    // MAX: chat_id диалога в users не записан, ищется по user_id.
    const uid = await freshTourist('chat');
    const { rows: [u] } = await pool.query<{ tg: string }>(
      `UPDATE users SET max_user_id = $2, telegram_chat_id = telegram_id WHERE id = $1 RETURNING telegram_id::text AS tg`,
      [uid, 770000 + Math.floor(Math.random() * 9999)],
    );
    const tg = Number(u.tg);
    const maxUser = (await pool.query<{ m: string }>(`SELECT max_user_id::text AS m FROM users WHERE id = $1`, [uid])).rows[0].m;
    const maxChat = 880000 + Math.floor(Math.random() * 9999);
    await pool.query(
      `INSERT INTO tg_conversations (chat_id, mode, role, content, user_id, user_name, platform) VALUES
         ($1, 'tourist', 'user', 'Как добраться до Мутновского?', $1, 'Иван', 'telegram'),
         ($1, 'tourist', 'assistant', 'Через Вилючинск, на вахтовке', $1, NULL, 'telegram'),
         ($2, 'max', 'user', 'Я на перевале, связь плохая', $3, 'Иван', 'max'),
         ($2, 'max', 'assistant', 'Понял, держитесь тропы', $3, NULL, 'max')`,
      [tg, maxChat, maxUser],
    );
    // Контроль: чужой чат Telegram и чужой человек MAX с тем же числом id,
    // что у нашего в Telegram — пространства чисел у мессенджеров разные.
    await pool.query(
      `INSERT INTO tg_conversations (chat_id, mode, role, content, user_id, platform) VALUES
         ($1, 'tourist', 'user', 'чужой вопрос', $1, 'telegram'),
         ($2, 'max', 'user', 'чужой в MAX', $3, 'max')`,
      [tg + 1, maxChat + 1, tg],
    );
    await pool.query(
      `INSERT INTO max_login_sessions (nonce, status, max_user_id, max_name, max_username, expires_at)
       VALUES ($1, 'authenticated', $2, 'Иван', 'ivan_max', NOW() + interval '1 hour')`,
      [`erase-${uid}`, maxUser],
    );

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    const left = await pool.query<{ content: string }>(
      `SELECT content FROM tg_conversations WHERE chat_id IN ($1, $2, $3, $4) ORDER BY content`,
      [tg, maxChat, tg + 1, maxChat + 1],
    );
    expect(left.rows.map((r) => r.content)).toEqual(['чужой в MAX', 'чужой вопрос']);
    expect((await pool.query(`SELECT 1 FROM max_login_sessions WHERE nonce = $1`, [`erase-${uid}`])).rows).toHaveLength(0);
    expect((await pool.query(
      `SELECT telegram_id, telegram_chat_id, max_user_id FROM users WHERE id = $1`, [uid],
    )).rows).toEqual([{ telegram_id: null, telegram_chat_id: null, max_user_id: null }]);
  });

  it('удаление: веб-чат и Telegram в chat_sessions, спутники и точка регистрации, текст обращений и SOS стираются; чужое — нет (#2327, третий круг)', async () => {
    // Ревью второго круга: после «стёрты» на настоящей базе оставались
    // переписка с Кузьмичом в chat_sessions (с телефоном и диагнозом) и
    // спутники в route_registrations.group_members (имя и телефон ребёнка).
    // Признак ПД по имени их не видел — теперь их видит вторая перепись, а
    // этот тест держит само стирание.
    const uid = await freshTourist('chat2');
    const tg = Number((await pool.query<{ tg: string }>(`SELECT telegram_id::text AS tg FROM users WHERE id = $1`, [uid])).rows[0].tg);
    const web = await pool.query<{ id: string }>(
      `INSERT INTO chat_sessions (session_id, user_id, messages, interests_encrypted)
       VALUES ($1, $2, '[{"role":"user","content":"мой телефон +79991112233, у меня диабет"}]', 'enc:вулканы') RETURNING id`,
      [`web-${uid}`, uid],
    );
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'у меня диабет, нужен лёгкий маршрут')`,
      [web.rows[0].id],
    );
    await pool.query(
      `INSERT INTO chat_sessions (session_id, messages) VALUES ($1, '[{"role":"user","content":"я Иван, +79991112233"}]')`,
      [`tg_${tg}`],
    );
    // Контроль: чужой Telegram и разговор без входа — не его по ключу.
    await pool.query(
      `INSERT INTO chat_sessions (session_id, messages) VALUES ($1, '[{"role":"user","content":"чужой"}]'), ($2, '[{"role":"user","content":"без входа"}]')`,
      [`tg_${tg + 1}`, `anon-${uid}`],
    );

    // Прошедший и закрытый контроль: он отметил возвращение. Открытый
    // (completed_at пуст) держит удаление — тест «открытый контроль маршрута».
    const reg = await pool.query<{ id: string }>(
      `INSERT INTO route_registrations (user_id, route_name, route_description, start_date, end_date, group_size, group_members,
         leader_name, leader_phone, emergency_contact_name, emergency_contact_phone, checkin_confirmed_at,
         last_position_lat, last_position_lng, last_position_at, last_position_source, completed_at, closed_reason)
       VALUES ($1, 'Авачинский', 'иду с дочкой Машей, ей 9', CURRENT_DATE - 10, CURRENT_DATE - 9, 2,
         '[{"name":"Маша","phone":"+79990004455","birth_year":2016}]',
         'Иван', '+79991112233', 'Мама', '+79990001122', NOW() - interval '9 days',
         53.255, 158.830, NOW() - interval '9 days', 'phone', NOW() - interval '9 days', 'returned') RETURNING id`,
      [uid],
    );
    const note = await pool.query<{ id: string }>(
      `INSERT INTO notifications (user_id, type, title, message) VALUES ($1, 'booking', 'Бронь', 'Иван, ваша бронь подтверждена') RETURNING id`,
      [uid],
    );
    await pool.query(`INSERT INTO notification_log (notification_id, channel, metadata) VALUES ($1, 'in_app', '{"to":"ivan"}')`, [note.rows[0].id]);
    await pool.query(`INSERT INTO notification_preferences (user_id, prefs) VALUES ($1, '{"email":false}')`, [uid]);
    await pool.query(`INSERT INTO user_trips (user_id, party) VALUES ($1, '{"adults":1,"kids":[{"name":"Маша","age":9}]}')`, [uid]);
    const ticket = await pool.query<{ id: string }>(
      `INSERT INTO support_tickets (user_id, subject, messages, resolution)
       VALUES ($1, 'Не пришло письмо Ивану', '[{"from":"user","text":"мой телефон +79991112233"}]', 'выслали Ивану повторно') RETURNING id`,
      [uid],
    );
    const sos = await pool.query<{ id: string }>(
      `INSERT INTO sos_events (user_id, lat, lng, status, tourist_name, tourist_phone, message)
       VALUES ($1, 53.3, 158.7, 'resolved', 'Иван', '+79991112233', 'сломал ногу, я диабетик') RETURNING id`,
      [uid],
    );
    const conv = await pool.query<{ id: string }>(`INSERT INTO conversations (created_by) VALUES ($1) RETURNING id`, [uid]);
    const cmsg = await pool.query<{ id: string }>(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'мой телефон +79991112233') RETURNING id`,
      [conv.rows[0].id, uid],
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (partner_id, user_id, display_name, origin) VALUES ($1, $2, 'Иван', 'operator_booking') RETURNING id`,
      [operatorId, uid],
    );
    // Заголовок касания и задачи партнёр пишет руками («Напишите, что
    // произошло»). Карточка с ними — не доказанно его (круг 10): о ком
    // «Звонил Иван, у мамы диабет», по строке не различить, и удаление
    // аккаунта их не трогает, а ответ это называет. Стирает их по обращению
    // администратор (eraseCrmContactOnRequest): заголовок, который пишет
    // человек, становится подписью рода, заголовки кода — остаются.
    const ev = await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title, payload)
       VALUES ($1, $2, 'call', 'partner_user', 'Звонил Иван, у мамы диабет, просил трансфер',
               '{"details":"просил трансфер для мамы","channel":"phone"}') RETURNING id`,
      [operatorId, contact.rows[0].id],
    );
    const evByKuzmich = await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title)
       VALUES ($1, $2, 'note', 'kuzmich', 'Иван боится высоты, едет с женой') RETURNING id`,
      [operatorId, contact.rows[0].id],
    );
    const evMeeting = await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title)
       VALUES ($1, $2, 'meeting', 'mcp', 'Встретились с Иваном у гостиницы «Петропавловск»') RETURNING id`,
      [operatorId, contact.rows[0].id],
    );
    const evTaskDone = await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title)
       VALUES ($1, $2, 'task_done', 'partner_user', 'Перезвонить Ивану про диабет') RETURNING id`,
      [operatorId, contact.rows[0].id],
    );
    const evStatus = await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title, payload)
       VALUES ($1, $2, 'status_change', 'system', 'Бронь тура: ждёт ответа → подтверждена', '{"from":"new","to":"confirmed"}') RETURNING id`,
      [operatorId, contact.rows[0].id],
    );
    const task = await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, contact_id, title, details, due_at)
       VALUES ($1, $2, 'Перезвонить Ивану про диабет мамы', 'спросить про диабет', NOW() + interval '1 day') RETURNING id`,
      [operatorId, contact.rows[0].id],
    );
    // Контроль: касание и задача по ЧУЖОМУ клиенту того же партнёра не трогаются.
    const foreignContact = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (partner_id, user_id, display_name, origin) VALUES ($1, $2, 'Турист Б', 'operator_booking') RETURNING id`,
      [operatorId, otherUserId],
    );
    const foreignEv = await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title)
       VALUES ($1, $2, 'call', 'partner_user', 'Звонил Пётр, просил скидку') RETURNING id`,
      [operatorId, foreignContact.rows[0].id],
    );
    const foreignTask = await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, contact_id, title, due_at)
       VALUES ($1, $2, 'Написать Петру', NOW() + interval '1 day') RETURNING id`,
      [operatorId, foreignContact.rows[0].id],
    );
    const fb = await pool.query<{ id: string }>(
      `INSERT INTO ai_actions_log (action_type, metadata)
       VALUES ('agent_feedback', jsonb_build_object('rating', -1, 'comment', 'не понял про мою дочь', 'author_user_id', $1::text))
       RETURNING id`,
      [uid],
    );
    const psr = await pool.query<{ id: string }>(
      `INSERT INTO place_safety_reports (place_id, user_id, is_ok, note, reporter_lat, reporter_lng)
       VALUES ('p-erase-geo', $1, FALSE, 'мост смыло', 53.11, 158.42) RETURNING id`,
      [uid],
    );
    const bk = await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, booking_status, metadata)
       VALUES ($1, CURRENT_DATE - 15, 1, $2, 'Иван', 'completed', jsonb_build_object('tg_chat_id', $3::bigint, 'platform', 'tg'))
       RETURNING id`,
      [tourId, uid, tg],
    );

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    const sessions = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM chat_sessions WHERE session_id = ANY($1::text[]) ORDER BY session_id`,
      [[`web-${uid}`, `tg_${tg}`, `tg_${tg + 1}`, `anon-${uid}`]],
    );
    expect(sessions.rows.map((r) => r.session_id)).toEqual([`anon-${uid}`, `tg_${tg + 1}`].sort());
    expect((await pool.query(`SELECT 1 FROM chat_messages WHERE session_id = $1`, [web.rows[0].id])).rows).toHaveLength(0);

    expect((await pool.query(
      `SELECT route_name, leader_name, group_members, route_description, last_position_lat, last_position_lng,
              last_position_at, last_position_source, group_size
         FROM route_registrations WHERE id = $1`, [reg.rows[0].id],
    )).rows).toEqual([{
      route_name: 'Авачинский', leader_name: 'Удалённый пользователь', group_members: null, route_description: null,
      last_position_lat: null, last_position_lng: null, last_position_at: null, last_position_source: null, group_size: 2,
    }]);
    expect((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM notification_log WHERE notification_id = $1`, [note.rows[0].id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM notification_preferences WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM user_trips WHERE user_id = $1`, [uid])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT subject, messages, resolution FROM support_tickets WHERE id = $1`, [ticket.rows[0].id])).rows)
      .toEqual([{ subject: '', messages: [], resolution: null }]);
    expect((await pool.query(
      `SELECT message, tourist_phone, lat::float8 AS lat, lng::float8 AS lng FROM sos_events WHERE id = $1`, [sos.rows[0].id],
    )).rows).toEqual([{ message: null, tourist_phone: null, lat: 53.3, lng: 158.7 }]);
    expect((await pool.query(`SELECT content, is_deleted FROM conversation_messages WHERE id = $1`, [cmsg.rows[0].id])).rows)
      .toEqual([{ content: '', is_deleted: true }]);
    // Удаление аккаунта: касания и задача целы, ответ называет записи партнёра.
    expect((await pool.query(`SELECT title, payload FROM crm_events WHERE id = $1`, [ev.rows[0].id])).rows)
      .toEqual([{ title: 'Звонил Иван, у мамы диабет, просил трансфер', payload: { details: 'просил трансфер для мамы', channel: 'phone' } }]);
    expect((await pool.query(`SELECT title FROM crm_tasks WHERE id = $1`, [task.rows[0].id])).rows)
      .toEqual([{ title: 'Перезвонить Ивану про диабет мамы' }]);
    expect(ok.json.crm).toEqual({ cards: 1, partners: 1 });
    expect(ok.json.message).toContain('записи партнёра о клиенте');
    // По обращению администратор стирает карточку.
    const { eraseCrmContactOnRequest } = await import('@/lib/account/erase');
    expect(await eraseCrmContactOnRequest(pool, contact.rows[0].id)).toEqual({ partnerId: operatorId, events: 5, tasks: 1 });
    expect((await pool.query(`SELECT title, payload FROM crm_events WHERE id = $1`, [ev.rows[0].id])).rows)
      .toEqual([{ title: 'Звонок', payload: { channel: 'phone' } }]);
    const titleOf = async (id: string) =>
      (await pool.query<{ title: string }>(`SELECT title FROM crm_events WHERE id = $1`, [id])).rows[0]?.title;
    expect(await titleOf(evByKuzmich.rows[0].id)).toBe('Заметка');
    expect(await titleOf(evMeeting.rows[0].id)).toBe('Встреча');
    expect(await titleOf(evTaskDone.rows[0].id)).toBe('Задача выполнена');
    expect(await titleOf(evStatus.rows[0].id)).toBe('Бронь тура: ждёт ответа → подтверждена');
    expect(await titleOf(foreignEv.rows[0].id)).toBe('Звонил Пётр, просил скидку');
    expect((await pool.query(`SELECT title, details FROM crm_tasks WHERE id = $1`, [task.rows[0].id])).rows)
      .toEqual([{ title: 'Задача', details: null }]);
    expect((await pool.query(`SELECT title FROM crm_tasks WHERE id = $1`, [foreignTask.rows[0].id])).rows)
      .toEqual([{ title: 'Написать Петру' }]);
    expect((await pool.query(`SELECT metadata FROM ai_actions_log WHERE id = $1`, [fb.rows[0].id])).rows)
      .toEqual([{ metadata: { rating: -1 } }]);
    expect((await pool.query(`SELECT note, reporter_lat, reporter_lng FROM place_safety_reports WHERE id = $1`, [psr.rows[0].id])).rows)
      .toEqual([{ note: 'мост смыло', reporter_lat: null, reporter_lng: null }]);
    expect((await pool.query(`SELECT metadata FROM operator_bookings WHERE id = $1`, [bk.rows[0].id])).rows)
      .toEqual([{ metadata: { platform: 'tg' } }]);

    // Что осталось — названо, и «стёрты» не сказано: наблюдение о месте и место сигнала SOS.
    expect(ok.json.unchecked).toEqual([]);
    expect(ok.json.kept?.map((k) => k.category).sort()).toEqual([
      'место и время ваших сигналов SOS — без имени, телефона и текста',
      'ваши наблюдения о состоянии мест',
    ].sort());
    expect(ok.json.message).not.toContain('персональные данные стёрты');
    expect(ok.json.message).toContain('Разговоры с Кузьмичом без входа в аккаунт');
  });

  it('удаление: разговор с Кузьмичом, начатый без входа и продолженный после входа, — его и стирается (#2327, ревью третьего круга)', async () => {
    // Ревью: строка, вставленная анонимно, оставалась с user_id NULL и после
    // входа, а в ней — телефон и диагноз, названные уже вошедшим человеком.
    // Удаление искало по user_id и не находило её, ответ говорил «стёрты».
    // Запись — та же функция, что зовут оба роута чата.
    const { saveChatSession } = await import('@/lib/kuzmich/chat-session-save');
    const uid = await freshTourist('anon-chat');
    const sid = `anon-then-in-${uid}`;
    const owner = async () => (await pool.query<{ user_id: string | null; is_authenticated: boolean }>(
      `SELECT user_id::text AS user_id, is_authenticated FROM chat_sessions WHERE session_id = $1`, [sid],
    )).rows[0];
    await saveChatSession({
      sessionId: sid, userId: null, role: 'tourist', userMessageCount: 1, isAuthenticated: false, interestsEncrypted: null,
      messages: [{ role: 'user', content: 'Какая погода на Авачинском?' }],
    });
    expect(await owner()).toEqual({ user_id: null, is_authenticated: false });
    await saveChatSession({
      sessionId: sid, userId: uid, role: 'tourist', userMessageCount: 2, isAuthenticated: true, interestsEncrypted: null,
      messages: [{ role: 'user', content: 'Какая погода на Авачинском?' }, { role: 'user', content: 'я Иван, +79991234567, диабет' }],
    });
    expect(await owner()).toEqual({ user_id: uid, is_authenticated: true });
    // Записанного хозяина запись не меняет: роут другого вошедшего сюда не
    // пустит (isForeignSession), но и запрос сам хозяина не перепишет.
    await saveChatSession({
      sessionId: sid, userId: otherUserId, role: 'tourist', userMessageCount: 3, isAuthenticated: true, interestsEncrypted: null,
      messages: [{ role: 'user', content: 'я Иван, +79991234567, диабет' }],
    });
    expect((await owner()).user_id).toBe(uid);
    // Контроль: разговор без входа, не продолженный после него, — ничей и остаётся.
    const lone = `anon-only-${uid}`;
    await saveChatSession({
      sessionId: lone, userId: null, role: 'tourist', userMessageCount: 1, isAuthenticated: false, interestsEncrypted: null,
      messages: [{ role: 'user', content: 'без входа' }],
    });

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await pool.query(`SELECT 1 FROM chat_sessions WHERE session_id = $1`, [sid])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT user_id FROM chat_sessions WHERE session_id = $1`, [lone])).rows).toEqual([{ user_id: null }]);
    // Не продолженный после входа разговор ответ называет словами.
    expect(ok.json.message).toContain('в том числе начатые до входа и не продолженные после него');
  });

  it('удаление: брони, принятые Кузьмичом в Telegram до привязки аккаунта, — его: предстоящая держит, прошедшая стирается; MAX и чужие не тронуты (#2327, ревью третьего круга)', async () => {
    // Бронь из чата до привязки лежит без user_id с меткой tg_chat_id = его
    // id в Telegram, и Кузьмич считает её его (loadUserSituation). Удаление
    // искало только по user_id: имя, телефон, аллергия и метка оставались.
    const uid = await freshTourist('tg-book');
    const tg = Number((await pool.query<{ tg: string }>(`SELECT telegram_id::text AS tg FROM users WHERE id = $1`, [uid])).rows[0].tg);
    const chatBooking = async (date: string, status: string, meta: Record<string, unknown>, phone: string) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone,
           booking_status, special_requests, metadata)
         VALUES ($1, ${date}, 1, NULL, 'Иван из чата', $2, $3, 'аллергия на орехи', $4::jsonb) RETURNING id`,
        [tourId, phone, status, JSON.stringify(meta)],
      )).rows[0].id;
    const past = await chatBooking('CURRENT_DATE - 20', 'completed', { tg_chat_id: tg, platform: 'tg' }, '+79991230001');
    const upcoming = await chatBooking('CURRENT_DATE + 7', 'confirmed', { tg_chat_id: tg }, '+79991230002');
    // Контроль: MAX с тем же числом (другое пространство id) и чужой Telegram.
    const maxSame = await chatBooking('CURRENT_DATE - 20', 'completed', { tg_chat_id: tg, platform: 'max' }, '+79991230003');
    const foreignTg = await chatBooking('CURRENT_DATE - 20', 'completed', { tg_chat_id: tg + 1, platform: 'tg' }, '+79991230004');
    const member = await pool.query<{ id: string }>(
      `INSERT INTO booking_group_members (booking_id, full_name, phone) VALUES ($1, 'Маша', '+79990004455') RETURNING id`, [past],
    );
    // Рабочая заметка оператора к запросу изменения брони — в ERASE_KEEP:
    // счёт после стирания обязан найти её и по такой брони, иначе ответ
    // скажет «стёрты».
    await pool.query(
      `INSERT INTO booking_change_requests (partner_id, booking_id, new_tour_id, new_date, notes)
       VALUES ($1, $2, $3, CURRENT_DATE - 19, 'перенос на день позже, группа согласна')`, [operatorId, past, tourId],
    );
    // Комментарий журнала статусов по такой брони стирается шагом booking_logs
    // (его находит та же дорога HIS_BOOKINGS).
    const log = (await pool.query<{ id: string }>(
      `INSERT INTO booking_logs (booking_id, from_status, to_status, comment) VALUES ($1, 'confirmed', 'completed', 'группа вернулась') RETURNING id`, [past],
    )).rows[0].id;

    const blocked = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(blocked.status).toBe(409);
    // Своим отказом (круг 10): совет «отмените» здесь неисполним — роут отмены
    // туриста такую бронь не находит, кабинет её не показывает.
    expect(blocked.json.blockers).toEqual(['upcoming_unlinked_booking']);
    expect(blocked.json.error).toContain('отменить её сами вы не можете');
    expect(blocked.json.error).toContain('попросите оператора');
    expect(blocked.json.error).not.toContain('Отмените её');
    {
      const { NextRequest } = await import('next/server');
      const { POST: cancel } = await import('@/app/api/bookings/[id]/cancel/route');
      authAs.userId = uid;
      const res = await cancel(new NextRequest(`http://localhost/api/bookings/${upcoming}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }) as unknown as NextRequest, { params: Promise.resolve({ id: String(upcoming) }) });
      authAs.userId = userId;
      expect(res.status).toBe(404);
    }
    expect((await pool.query(`SELECT tourist_phone FROM operator_bookings WHERE id = $1`, [past])).rows)
      .toEqual([{ tourist_phone: '+79991230001' }]);

    await pool.query(`UPDATE operator_bookings SET booking_status = 'cancelled' WHERE id = $1`, [upcoming]);
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    const row = async (id: string) => (await pool.query(
      `SELECT user_id::text AS uid, tourist_name, tourist_phone, special_requests, metadata FROM operator_bookings WHERE id = $1`, [id],
    )).rows[0];
    for (const id of [past, upcoming]) {
      const r = await row(id);
      expect(r, id).toMatchObject({ uid, tourist_name: 'Удалённый пользователь', tourist_phone: null, special_requests: null });
      expect(r.metadata?.tg_chat_id, id).toBeUndefined();
    }
    expect((await pool.query(`SELECT full_name, phone FROM booking_group_members WHERE id = $1`, [member.rows[0].id])).rows)
      .toEqual([{ full_name: 'Удалённый пользователь', phone: null }]);
    expect(await row(maxSame)).toMatchObject({
      uid: null, tourist_phone: '+79991230003', special_requests: 'аллергия на орехи', metadata: { tg_chat_id: tg, platform: 'max' },
    });
    expect(await row(foreignTg)).toMatchObject({ uid: null, tourist_phone: '+79991230004', metadata: { tg_chat_id: tg + 1 } });

    const { ERASED_COMMENT } = await import('@/lib/account/erase');
    expect((await pool.query(`SELECT comment FROM booking_logs WHERE id = $1`, [log])).rows).toEqual([{ comment: ERASED_COMMENT }]);
    expect(ok.json.unchecked).toEqual([]);
    expect(ok.json.kept?.map((k) => k.category)).toContain('рабочие заметки оператора, гида и перевозчика к вашим поездкам');
    expect(ok.json.message).not.toContain('персональные данные стёрты');
    expect(ok.json.message).toContain('Брони, которые Кузьмич принял в MAX');
  });

  it('удаление: владелец партнёра, к которому идут заявки туристов (карточка или виджет, туры, жильё, брони, заявки на жильё), — отказ (409), каналы партнёра не тронуты', async () => {
    // Брони с именем и телефоном туриста уходят в мессенджеры партнёра
    // (lib/partners/reach.ts) — после удаления аккаунта они шли бы человеку,
    // который с платформой простился. Что делать с карточкой — решает
    // владелец платформы, поэтому удаление здесь отказывает, а не чистит.
    const uid = await freshTourist('owner');
    const partner = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, user_id, telegram_chat_id)
       VALUES ('Оператор-владелец', 'operator', '{}', TRUE, TRUE, $2, $1, 5552001) RETURNING id`,
      [uid, `erase-owner-${uid.slice(0, 8)}`],
    );
    const tour = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published)
       VALUES ($1, 'Тур владельца', 5000, 10, TRUE, TRUE) RETURNING id`,
      [partner.rows[0].id],
    );
    const live = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(live.status).toBe(409);
    expect(live.json.blockers).toEqual(['partner_live_business']);
    // Обещает только то, что есть: передавать брони платформа не умеет.
    expect(live.json.error).toContain('поможет владелец платформы');
    expect(live.json.error).not.toMatch(/переда/);

    // Тур снят с витрины, но на него есть предстоящая бронь туриста — всё ещё отказ.
    await pool.query(`UPDATE operator_tours SET is_published = FALSE WHERE id = $1`, [tour.rows[0].id]);
    const b = await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, booking_status)
       VALUES ($1, CURRENT_DATE + 5, 1, $2, 'Турист Б', '+79995556677', 'new') RETURNING id`,
      [tour.rows[0].id, otherUserId],
    );
    const booked = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(booked.status).toBe(409);
    expect(booked.json.blockers).toEqual(['partner_live_business']);

    // Бронь отменена, тура на витрине нет, но сама карточка на витрине:
    // форма «Написать оператору» (app/api/leads) берёт партнёра с
    // is_public OR widget_enabled и шлёт телефон туриста в его мессенджер.
    await pool.query(`UPDATE operator_bookings SET booking_status = 'cancelled' WHERE id = $1`, [b.rows[0].id]);
    const isPublic = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(isPublic.status).toBe(409);
    expect(isPublic.json.blockers).toEqual(['partner_live_business']);

    // Межсезонье: туров нет, карточка скрыта, но окно чата Ведара стоит на
    // его сайте — заявки из виджета идут ему. Отказ (ревью третьего круга).
    await pool.query(`UPDATE partners SET is_public = FALSE, widget_enabled = TRUE WHERE id = $1`, [partner.rows[0].id]);
    const widget = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(widget.status).toBe(409);
    expect(widget.json.blockers).toEqual(['partner_live_business']);
    // То же — публичная карточка без туров и с виджетом.
    await pool.query(`UPDATE partners SET is_public = TRUE WHERE id = $1`, [partner.rows[0].id]);
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);

    // Жильё: объявление на витрине, затем скрытое — но с предстоящей бронью
    // жилья, затем без брони — но с заявкой на будущие даты. Всё это идёт
    // владельцу в мессенджер (reachForPartner) — отказ.
    await pool.query(`UPDATE partners SET is_public = FALSE, widget_enabled = FALSE WHERE id = $1`, [partner.rows[0].id]);
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, is_active, moderation_status)
       VALUES ($1, 'Гостевой дом владельца', 'guesthouse', '{"lat":53.0,"lng":158.6}', TRUE, 'approved') RETURNING id`,
      [partner.rows[0].id],
    );
    const accLive = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(accLive.status).toBe(409);
    expect(accLive.json.blockers).toEqual(['partner_live_business']);

    await pool.query(`UPDATE accommodations SET is_active = FALSE WHERE id = $1`, [acc.rows[0].id]);
    const stayBooking = await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status)
       VALUES ($1, $2, CURRENT_DATE + 3, CURRENT_DATE + 5, 2, 1, 3000, 6000, 'confirmed') RETURNING id`,
      [acc.rows[0].id, otherUserId],
    );
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);

    await pool.query(`UPDATE accommodation_bookings SET status = 'cancelled' WHERE id = $1`, [stayBooking.rows[0].id]);
    const stayReq = await pool.query<{ id: string }>(
      `INSERT INTO stay_requests (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone,
         pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, CURRENT_DATE + 10, CURRENT_DATE + 12, 2, 'Гость', '+79994443322', NOW(), '203.0.113.9', 'form', 'v1') RETURNING id`,
      [acc.rows[0].id],
    );
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);

    // Даты заявки прошли — живого дела нет, удаление проходит; карточку
    // партнёра оно не трогает (решение владельца), а канал карточки — не его
    // id в Telegram (5552001 — чужой чат) — остаётся и назван в ответе.
    await pool.query(
      `UPDATE stay_requests SET check_in_date = CURRENT_DATE - 12, check_out_date = CURRENT_DATE - 10 WHERE id = $1`,
      [stayReq.rows[0].id],
    );
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await pool.query(`SELECT telegram_chat_id::text AS chat FROM partners WHERE id = $1`, [partner.rows[0].id])).rows)
      .toEqual([{ chat: '5552001' }]);
    expect(ok.json.kept?.map((k) => k.category)).toContain('карточка партнёра, скрытая с витрины');
    const { ERASE_STEP_LEAVES } = await import('@/lib/account/erase');
    expect(ok.json.kept?.map((k) => k.category)).toContain(ERASE_STEP_LEAVES['partners.channels'].category);
  });

  it('удаление: карточка CRM из брони Telegram до привязки — его: имя и телефон стираются; две карточки у одного партнёра не роняют удаление (#2327, четвёртый круг)', async () => {
    // Ревью: бронь из Telegram стиралась, а карточка клиента, которую из неё
    // завела CRM (user_id пуст, имя и телефон из брони), оставалась целой —
    // с заметкой «мама с диабетом», а ответ говорил «стёрты».
    const { linkContactFromSource } = await import('@/lib/crm/contacts');
    const uid = await freshTourist('crm-tg');
    const tg = Number((await pool.query<{ tg: string }>(`SELECT telegram_id::text AS tg FROM users WHERE id = $1`, [uid])).rows[0].tg);
    const booking = async (userCol: string | null, name: string, phone: string, meta: Record<string, unknown>) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone,
           booking_status, metadata)
         VALUES ($1, CURRENT_DATE - 20, 1, $2, $3, $4, 'completed', $5::jsonb) RETURNING id`,
        [tourId, userCol, name, phone, JSON.stringify(meta)],
      )).rows[0].id;
    const link = async (bookingId: string) => {
      const r = await linkContactFromSource('operator_booking', bookingId);
      if (r.outcome !== 'linked') throw new Error(`карточка не заведена: ${r.outcome}`);
      return r.contactId;
    };
    const fromChat = await link(await booking(null, 'Иван из чата', '+79991117788', { tg_chat_id: tg, platform: 'tg' }));
    expect((await pool.query(`SELECT user_id, display_name, phone FROM crm_contacts WHERE id = $1`, [fromChat])).rows)
      .toEqual([{ user_id: null, display_name: 'Иван из чата', phone: '+79991117788' }]);
    // Записей партнёра в ней нет: заметка «мама с диабетом» сделала бы её
    // не доказанно его (круг 10, тест (а'')).
    // Его же брони с аккаунтом с двух телефонов у того же партнёра — две
    // карточки с его user_id. Без телефона и почты их держал бы уникальный
    // индекс (partner_id, user_id): удаление падало на 23505.
    const own1 = await link(await booking(uid, 'Иван', '+79991117701', {}));
    const own2 = await link(await booking(uid, 'Иван', '+79991117702', {}));
    expect(own1).not.toBe(own2);
    // Карточка, которую завела бронь ДРУГОГО аккаунта с тем же телефоном:
    // его бронь из Telegram с этим номером ложится в неё (склейка по
    // телефону). Карточка не доказанно его (в ней чужой аккаунт): она не
    // стирается, от неё отвязывается его бронь (круг 9); ответ её называет.
    const sharedBooking = await booking(otherUserId, 'Мария', '+79991117760', {});
    const shared = await link(sharedBooking);
    const hisInShared = await booking(null, 'Иван с маминого', '+79991117760', { tg_chat_id: tg, platform: 'tg' });
    expect(await link(hisInShared)).toBe(shared);
    const sharedBefore = (await pool.query(
      `SELECT user_id::text AS user_id, display_name, phone, email FROM crm_contacts WHERE id = $1`, [shared],
    )).rows[0];
    expect(sharedBefore.user_id).toBe(otherUserId);
    // Аренда снаряжения заводит карточку без user_id всегда: имя и телефон — из формы аренды.
    const gearItem = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity, is_active, moderation_status)
       VALUES ($1, 'Палатка CRM', 'tents', 500, 1, 1, FALSE, 'approved') RETURNING id`, [operatorId],
    )).rows[0].id;
    const rental = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Иван прокат', 'ivan-gear@example.com', '+79991117770', CURRENT_DATE - 9, CURRENT_DATE - 7, 1, 2, 1000, 1000, 'completed')
       RETURNING id`, [gearItem, uid],
    )).rows[0].id;
    const lr = await linkContactFromSource('gear_rental', rental);
    if (lr.outcome !== 'linked') throw new Error(`карточка аренды не заведена: ${lr.outcome}`);
    const fromGear = lr.contactId;
    expect((await pool.query(`SELECT user_id, display_name FROM crm_contacts WHERE id = $1`, [fromGear])).rows)
      .toEqual([{ user_id: null, display_name: 'Иван прокат' }]);
    // Контроль: карточка чужого Telegram того же партнёра.
    const foreign = await link(await booking(null, 'Чужой из чата', '+79991117799', { tg_chat_id: tg + 1, platform: 'tg' }));

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    const cards = await pool.query(
      `SELECT user_id, display_name, phone, phone_e164, email, notes, tags FROM crm_contacts WHERE id = ANY($1::uuid[])`,
      [[fromChat, own1, own2, fromGear]],
    );
    expect(cards.rows).toHaveLength(4);
    for (const c of cards.rows) {
      expect(c).toEqual({
        user_id: null, display_name: 'Удалённый пользователь', phone: null, phone_e164: null, email: null, notes: null, tags: [],
      });
    }
    expect((await pool.query(`SELECT display_name, phone FROM crm_contacts WHERE id = $1`, [foreign])).rows)
      .toEqual([{ display_name: 'Чужой из чата', phone: '+79991117799' }]);
    expect((await pool.query(`SELECT user_id::text AS u, tourist_name, tourist_phone FROM operator_bookings WHERE id = $1`, [sharedBooking])).rows)
      .toEqual([{ u: otherUserId, tourist_name: 'Мария', tourist_phone: '+79991117760' }]);
    // Общая карточка цела, его бронь от неё отвязана.
    expect((await pool.query(
      `SELECT user_id::text AS user_id, display_name, phone, email FROM crm_contacts WHERE id = $1`, [shared],
    )).rows).toEqual([sharedBefore]);
    const sharedLinks = (await pool.query<{ source_id: string }>(
      `SELECT source_id FROM crm_contact_links WHERE contact_id = $1 AND source_kind = 'operator_booking'`, [shared],
    )).rows.map((r) => r.source_id);
    expect(sharedLinks).toContain(String(sharedBooking));
    expect(sharedLinks).not.toContain(String(hisInShared));
    // Осталась только карточка Марии — и ответ называет её словами «могли
    // быть вашими» и куда написать, а не «стёрты» (круг 9).
    const { unprovenCrmSentence } = await import('@/lib/account/erase');
    expect(ok.json.kept).toEqual([]);
    expect(ok.json.crm).toEqual({ cards: 1, partners: 1 });
    expect(ok.json.unchecked).toEqual([]);
    expect(ok.json.message).not.toContain('персональные данные стёрты');
    expect(ok.json.message).toContain(unprovenCrmSentence({ cards: 1, partners: 1 })!);
  });

  it('удаление: причина отмены брони (кабинет оператора) и её копия в ленте CRM, причины отмены жилья и отказа перевозчика — стираются (#2327, четвёртый круг)', async () => {
    // Ревью: «Турист в больнице с переломом» оставалась в
    // operator_bookings.cancellation_reason и в crm_events.payload.reason, а
    // ответ говорил «стёрты». Отмена — настоящей дверью кабинета оператора.
    const uid = await freshTourist('cancel-reason');
    const opUser = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Оператор отмены', 'x', 'operator') RETURNING id`,
      [`erase-op-${uid}@example.com`],
    )).rows[0].id;
    const partner = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, user_id)
       VALUES ('Оператор отмены', 'operator', '{}', TRUE, TRUE, $2, $1) RETURNING id`,
      [opUser, `erase-cancel-${uid.slice(0, 8)}`],
    )).rows[0].id;
    const tour = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published)
       VALUES ($1, 'Тур с отменой', 5000, 10, TRUE, TRUE) RETURNING id`, [partner],
    )).rows[0].id;
    const reason = 'Турист в больнице с переломом, справка у оператора';
    const bk = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, booking_status)
       VALUES ($1, CURRENT_DATE + 12, 1, $2, 'Иван', '+79991118899', 'confirmed') RETURNING id`, [tour, uid],
    )).rows[0].id;
    authAs.userId = opUser;
    authAs.role = 'operator';
    const { NextRequest } = await import('next/server');
    const { PATCH } = await import('@/app/api/hub/operator/bookings/[id]/route');
    const res = await PATCH(new NextRequest(`http://localhost/api/hub/operator/bookings/${bk}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ booking_status: 'cancelled', cancellation_reason: reason }),
    }) as unknown as NextRequest, { params: Promise.resolve({ id: bk }) });
    authAs.userId = userId;
    authAs.role = 'tourist';
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    // Дверь кабинета пишет причину в обе колонки — это и стирается ниже.
    expect((await pool.query(`SELECT cancellation_reason FROM operator_bookings WHERE id = $1`, [bk])).rows)
      .toEqual([{ cancellation_reason: reason }]);
    const ev = await pool.query<{ id: string; reason: string | null }>(
      `SELECT id, payload->>'reason' AS reason FROM crm_events WHERE source_kind = 'operator_booking' AND source_id = $1`, [bk],
    );
    expect(ev.rows.map((r) => r.reason)).toEqual([reason]);
    // Комментарий к подтверждению в ленте той же карточки: confirmBooking
    // принимает любой текст. Заголовок события строит код — он остаётся.
    const contactOfBk = (await pool.query<{ contact_id: string }>(
      `SELECT contact_id FROM crm_contact_links WHERE source_kind = 'operator_booking' AND source_id = $1`, [String(bk)],
    )).rows[0].contact_id;
    const confirmEv = (await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, source_kind, source_id, kind, actor_kind, title, payload)
       VALUES ($1, $2, 'operator_booking', $3, 'status_change', 'partner_user', 'Бронь тура: ждёт ответа → подтверждена',
               '{"from":"new","to":"confirmed","comment":"Подтвердил: место у окна, у туриста астма"}') RETURNING id`,
      [partner, contactOfBk, String(bk)],
    )).rows[0].id;
    // Бронь без причины — без причины и остаётся: «удалена» о том, чего не было, — выдумка.
    const silent = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, booking_status)
       VALUES ($1, CURRENT_DATE - 3, 1, $2, 'Иван', 'cancelled') RETURNING id`, [tour, uid],
    )).rows[0].id;
    // Заказ мест в машине, в котором перевозчик отказал словами, и бронь
    // жилья, которую хозяин отменил словами гостю.
    const vehicle = await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Вахтовка отказа', 20) RETURNING id`,
      [operatorId],
    );
    const trip = await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, status)
       VALUES ($1, CURRENT_DATE - 5, 'Петропавловск', 'Мутновский', 20, 'completed') RETURNING id`,
      [vehicle.rows[0].id],
    );
    const seat = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status, decline_reason)
       VALUES ($1, $2, 1, 'declined', 'Не повезём с гипсом на ноге') RETURNING id`,
      [trip.rows[0].id, uid],
    )).rows[0].id;
    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, is_active, moderation_status)
       VALUES ($1, 'Гостевой дом отмены', 'guesthouse', '{"lat":53.0,"lng":158.6}', FALSE, 'approved') RETURNING id`,
      [operatorId],
    )).rows[0].id;
    const stay = (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status, cancellation_reason)
       VALUES ($1, $2, CURRENT_DATE - 10, CURRENT_DATE - 8, 2, 1, 3000, 6000, 'cancelled', 'Гость написал, что у него ковид') RETURNING id`,
      [acc, uid],
    )).rows[0].id;

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const { ERASED_REASON } = await import('@/lib/account/erase');
    expect((await pool.query(`SELECT cancellation_reason, booking_status FROM operator_bookings WHERE id = $1`, [bk])).rows)
      .toEqual([{ cancellation_reason: ERASED_REASON, booking_status: 'cancelled' }]);
    expect((await pool.query(`SELECT cancellation_reason FROM operator_bookings WHERE id = $1`, [silent])).rows)
      .toEqual([{ cancellation_reason: null }]);
    const after = await pool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM crm_events WHERE id = $1`, [ev.rows[0].id]);
    expect(after.rows[0].payload).toEqual({ from: 'confirmed', to: 'cancelled' });
    expect((await pool.query(`SELECT title, payload FROM crm_events WHERE id = $1`, [confirmEv])).rows)
      .toEqual([{ title: 'Бронь тура: ждёт ответа → подтверждена', payload: { from: 'new', to: 'confirmed' } }]);
    expect((await pool.query(`SELECT decline_reason FROM transfer_seat_bookings WHERE id = $1`, [seat])).rows)
      .toEqual([{ decline_reason: ERASED_REASON }]);
    expect((await pool.query(`SELECT cancellation_reason FROM accommodation_bookings WHERE id = $1`, [stay])).rows)
      .toEqual([{ cancellation_reason: ERASED_REASON }]);
    expect(ok.json.kept).toEqual([]);
    expect(ok.json.unchecked).toEqual([]);
    expect(ok.json.message).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);
  });

  it('удаление: причина отмены словами самого туриста («ковид») стирается в брони, журнале статусов и ленте CRM; комментарий оператора к подтверждению — подпись (#2327, пятый круг)', async () => {
    // Ревью: cancelBooking писал причину туриста дословно в booking_logs.comment
    // («… — оплаты не было»), а ответ говорил «стёрты». Отмена — настоящим
    // cancelBooking, как её зовут POST /api/bookings/[id]/cancel и PATCH /api/bookings/[id].
    const uid = await freshTourist('self-cancel');
    const opUser = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Оператор журнала', 'x', 'operator') RETURNING id`,
      [`erase-oplog-${uid}@example.com`],
    )).rows[0].id;
    const partner = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, user_id)
       VALUES ('Оператор журнала', 'operator', '{}', TRUE, TRUE, $2, $1) RETURNING id`,
      [opUser, `erase-oplog-${uid.slice(0, 8)}`],
    )).rows[0].id;
    const tour = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published)
       VALUES ($1, 'Тур журнала', 5000, 10, TRUE, TRUE) RETURNING id`, [partner],
    )).rows[0].id;
    const bk = String((await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, booking_status)
       VALUES ($1, CURRENT_DATE + 12, 1, $2, 'Иван', '+79991119900', 'new') RETURNING id`, [tour, uid],
    )).rows[0].id);
    const { confirmBooking, cancelBooking } = await import('@/lib/bookings/booking.service');
    await confirmBooking(bk, opUser, 'Подтверждаю: у туриста астма, место у прохода');
    const reason = 'У меня ковид, лежу в больнице';
    await cancelBooking(bk, uid, 'tourist', reason);

    // До удаления причина лежит дословно в трёх местах.
    expect((await pool.query(`SELECT cancellation_reason FROM operator_bookings WHERE id = $1`, [bk])).rows)
      .toEqual([{ cancellation_reason: reason }]);
    const logsBefore = (await pool.query<{ to_status: string; comment: string }>(
      `SELECT to_status, comment FROM booking_logs WHERE booking_id = $1 ORDER BY created_at, to_status`, [bk],
    )).rows;
    expect(logsBefore.map((l) => l.to_status)).toEqual(['confirmed', 'cancelled']);
    expect(logsBefore[1].comment).toBe(`${reason} — оплаты не было`);
    const leaks = async () => (await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM booking_logs WHERE booking_id = $1 AND (comment ILIKE '%ковид%' OR comment ILIKE '%астма%'))
            + (SELECT count(*) FROM operator_bookings WHERE id = $1 AND cancellation_reason ILIKE '%ковид%')
            + (SELECT count(*) FROM crm_events WHERE source_kind = 'operator_booking' AND source_id = $1::text
                 AND (payload::text ILIKE '%ковид%' OR payload::text ILIKE '%астма%' OR title ILIKE '%ковид%')) AS n`,
      [bk],
    )).rows[0].n;
    expect(Number(await leaks())).toBeGreaterThanOrEqual(3);

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const { ERASED_REASON, ERASED_COMMENT } = await import('@/lib/account/erase');
    expect(Number(await leaks())).toBe(0);
    expect((await pool.query(`SELECT cancellation_reason, booking_status FROM operator_bookings WHERE id = $1`, [bk])).rows)
      .toEqual([{ cancellation_reason: ERASED_REASON, booking_status: 'cancelled' }]);
    expect((await pool.query(
      `SELECT to_status, comment FROM booking_logs WHERE booking_id = $1 ORDER BY created_at, to_status`, [bk],
    )).rows).toEqual([{ to_status: 'confirmed', comment: ERASED_COMMENT }, { to_status: 'cancelled', comment: ERASED_REASON }]);
    // Ответ правдив: его слова не названы «заметками оператора» — их нет.
    expect(ok.json.kept).toEqual([]);
    expect(ok.json.unchecked).toEqual([]);
    expect(ok.json.message).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);
    expect(ok.json.message).not.toContain('заметки оператора');
  });

  it('удаление: его аренда снаряжения со сроком впереди и живая бронь жилья держат (409) словами; прошедший срок без отметки возврата и заявка без ответа дольше 48 часов — нет (#2327, пятый круг и круг 9)', async () => {
    // Ревью пятого круга: собственная аренда туриста и его предстоящая бронь
    // жилья пропускали удаление, и прокат с хозяином теряли его телефон.
    // Круг 9: держать удаление бессрочно тем, что решает прокат, нельзя —
    // выданное с прошедшим сроком отмечает возвращённым только прокат, а
    // заявка без ответа держит снаряжение 48 часов (holdsGearSql).
    const { findEraseBlockers } = await import('@/lib/account/erase');
    const uid = await freshTourist('own-gear-stay');
    const item = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity, is_active, moderation_status)
       VALUES ($1, 'Палатка туриста', 'tents', 500, 1, 1, FALSE, 'approved') RETURNING id`, [operatorId],
    )).rows[0].id;
    const rental = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Иван', 'ivan-own-gear@example.com', '+79991114455', CURRENT_DATE - 9, CURRENT_DATE - 7, 1, 2, 1000, 1000, 'overdue')
       RETURNING id`, [item, uid],
    )).rows[0].id;
    // Срок прошёл, прокат не отметил возврат: не держит — ни просрочка, ни
    // выданная (active) с прошедшим сроком. Проверка без удаления: человек нужен дальше.
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    await pool.query(`UPDATE gear_rentals SET status = 'active' WHERE id = $1`, [rental]);
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    // Выдана, срок ещё идёт — «верните или дождитесь окончания».
    await pool.query(`UPDATE gear_rentals SET end_date = CURRENT_DATE + 2 WHERE id = $1`, [rental]);
    const running = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(running.status).toBe(409);
    expect(running.json.blockers).toEqual(['upcoming_gear_rental']);
    expect(running.json.error).toContain('Верните снаряжение или дождитесь окончания аренды');
    // Заявка на будущие дни, на которую прокат ещё не ответил, — держит, пока держит снаряжение.
    await pool.query(
      `UPDATE gear_rentals SET status = 'pending', start_date = CURRENT_DATE + 3, end_date = CURRENT_DATE + 5, created_at = NOW()
        WHERE id = $1`, [rental],
    );
    const pending = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(pending.json.blockers).toEqual(['upcoming_gear_rental']);
    expect(pending.json.error).toContain('заявка держит не дольше 48 часов');
    // Та же заявка старше 48 часов без ответа — не держит; подтверждённая — держит.
    await pool.query(`UPDATE gear_rentals SET created_at = NOW() - interval '49 hours' WHERE id = $1`, [rental]);
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    await pool.query(`UPDATE gear_rentals SET status = 'confirmed' WHERE id = $1`, [rental]);
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).json.blockers).toEqual(['upcoming_gear_rental']);
    // Возвращена раньше срока (completed, конец аренды впереди) — не дело.
    await pool.query(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Иван', 'ivan-own-gear@example.com', '+79991114455', CURRENT_DATE - 1, CURRENT_DATE + 5, 1, 6, 3000, 3000, 'completed')`,
      [item, uid],
    );

    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, is_active, moderation_status)
       VALUES ($1, 'Гостевой дом туриста', 'guesthouse', '{"lat":53.0,"lng":158.6}', FALSE, 'approved') RETURNING id`,
      [operatorId],
    )).rows[0].id;
    const stay = (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status)
       VALUES ($1, $2, CURRENT_DATE + 3, CURRENT_DATE + 5, 2, 1, 3000, 6000, 'pending') RETURNING id`, [acc, uid],
    )).rows[0].id;
    // Оба дела сразу — оба названы.
    const both = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(both.status).toBe(409);
    expect(both.json.blockers).toEqual(['upcoming_gear_rental', 'upcoming_stay']);
    expect(both.json.error).toContain('Верните снаряжение или дождитесь окончания аренды');
    expect(both.json.error).toContain('Отмените бронь жилья или дождитесь выезда');

    await pool.query(`UPDATE gear_rentals SET status = 'cancelled' WHERE id = $1`, [rental]);
    // Подтверждённая, но так и не выданная аренда с прошедшим сроком — снаряжение у проката.
    await pool.query(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Иван', 'ivan-own-gear@example.com', '+79991114455', CURRENT_DATE - 20, CURRENT_DATE - 18, 1, 2, 1000, 1000, 'confirmed')`,
      [item, uid],
    );
    const stayOnly = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(stayOnly.json.blockers).toEqual(['upcoming_stay']);
    await pool.query(`UPDATE accommodation_bookings SET status = 'confirmed' WHERE id = $1`, [stay]);
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).json.blockers).toEqual(['upcoming_stay']);
    // Завершённая досрочно и неявка с выездом впереди — не живая бронь.
    await pool.query(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status)
       VALUES ($1, $2, CURRENT_DATE - 1, CURRENT_DATE + 4, 5, 1, 3000, 15000, 'completed'),
              ($1, $2, CURRENT_DATE - 1, CURRENT_DATE + 6, 7, 1, 3000, 21000, 'no_show')`, [acc, uid],
    );
    // Выезд прошёл — подтверждённая бронь уже не дело.
    await pool.query(
      `UPDATE accommodation_bookings SET check_in_date = CURRENT_DATE - 6, check_out_date = CURRENT_DATE - 4 WHERE id = $1`, [stay],
    );
    // Выданное с прошедшим сроком, не отмеченное возвращённым, удаление не
    // держит: отметить возврат — решение проката; аренда обезличивается.
    const unreturned = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Иван', 'ivan-own-gear@example.com', '+79991114455', CURRENT_DATE - 12, CURRENT_DATE - 10, 1, 2, 1000, 1000, 'overdue')
       RETURNING id`, [item, uid],
    )).rows[0].id;
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    for (const id of [rental, unreturned]) {
      expect((await pool.query(`SELECT customer_name, customer_phone FROM gear_rentals WHERE id = $1`, [id])).rows)
        .toEqual([{ customer_name: 'Удалённый пользователь', customer_phone: '' }]);
    }
  });

  // ── Карточки CRM (#2327, круг 9): его — только то, что доказано столбцами
  // базы. Имя, номер и почта не доказывают ничего: восемь кругов угадывания
  // «его ли это имя» то стирали чужое (брат с семейным номером), то оставляли
  // его (имя в аккаунте другое). Правило теперь одно — PROVEN_HIS_CARD.
  async function erasePartner(tag: string, uid: string) {
    const partner = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ($1, 'operator', '{}', TRUE, TRUE, $2) RETURNING id`, [`Оператор ${tag}`, `erase-${tag}-${uid.slice(0, 8)}`],
    )).rows[0].id;
    const tour = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published)
       VALUES ($1, $2, 5000, 10, TRUE, TRUE) RETURNING id`, [partner, `Тур ${tag}`],
    )).rows[0].id;
    return { partner, tour };
  }
  async function pastBooking(tour: string, uid: string | null, name: string, phone: string): Promise<string> {
    return String((await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, booking_status)
       VALUES ($1, CURRENT_DATE - 20, 1, $2, $3, $4, 'completed') RETURNING id`, [tour, uid, name, phone],
    )).rows[0].id);
  }
  async function bookingWith(tour: string, uid: string, name: string, phone: string, email: string | null,
    consent: { at: string; ip: string } | null = null): Promise<string> {
    return String((await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone,
         tourist_email, booking_status, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, CURRENT_DATE - 20, 1, $2, $3, $4, $5, 'completed', $6::timestamptz, $7, $8, $9) RETURNING id`,
      [tour, uid, name, phone, email, consent?.at ?? null, consent?.ip ?? null,
       consent ? 'booking_form' : null, consent ? 'v1' : null],
    )).rows[0].id);
  }
  async function linkTo(kind: 'operator_booking' | 'lead' | 'gear_rental' | 'accommodation_booking' | 'transfer_seat_booking',
    id: string): Promise<string> {
    const { linkContactFromSource } = await import('@/lib/crm/contacts');
    const r = await linkContactFromSource(kind, id);
    if (r.outcome !== 'linked') throw new Error(`карточка не заведена: ${r.outcome}`);
    return r.contactId;
  }
  async function leadFor(partner: string, name: string, phone: string, email: string | null = null): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, email, operator_id, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, $2, $3, $4, NOW() - interval '30 days', '198.51.100.21', 'lead_form', 'v1') RETURNING id`,
      [name, phone, email, partner],
    )).rows[0].id;
  }
  /** Все поля карточки, которые могли прийти от человека или от партнёра о нём. */
  const cardFull = async (id: string) => (await pool.query(
    `SELECT user_id::text AS user_id, display_name, phone, phone_e164, email, email_norm, notes, tags,
            pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version
       FROM crm_contacts WHERE id = $1`, [id],
  )).rows[0];
  const linksOf = async (id: string) => (await pool.query<{ k: string; s: string }>(
    `SELECT source_kind AS k, source_id AS s FROM crm_contact_links WHERE contact_id = $1 ORDER BY id`, [id],
  )).rows.map((r) => `${r.k}:${r.s}`);
  const eventRow = async (id: string) => (await pool.query(
    `SELECT contact_id::text AS c, title, payload FROM crm_events WHERE id = $1`, [id],
  )).rows[0];
  const erasedCard = async (id: string) => {
    const { ERASED_NAME } = await import('@/lib/account/erase');
    expect((await pool.query(
      `SELECT user_id, display_name, phone, phone_e164, email, email_norm, notes, tags, pd_consent_ip FROM crm_contacts WHERE id = $1`,
      [id],
    )).rows).toEqual([{
      user_id: null, display_name: ERASED_NAME, phone: null, phone_e164: null, email: null, email_norm: null,
      notes: null, tags: [], pd_consent_ip: null,
    }]);
  };
  async function statusEvent(partner: string, card: string, kind: 'operator_booking' | 'lead', sid: string,
    payload: Record<string, unknown>, actor: { kind: 'tourist' | 'partner_user'; user: string | null } = { kind: 'partner_user', user: null }) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, source_kind, source_id, kind, actor_kind, actor_user_id, title, payload)
       VALUES ($1, $2, $3, $4, 'status_change', $5, $6, 'Бронь тура: смена статуса', $7::jsonb) RETURNING id`,
      [partner, card, kind, sid, actor.kind, actor.user, JSON.stringify(payload)],
    )).rows[0].id;
  }
  /** Касание каждого рукописного вида (HAND_TITLE_KINDS) с заголовком и текстом партнёра. */
  async function touchesIn(partner: string, card: string): Promise<Map<string, string>> {
    const { HAND_TITLE_KINDS } = await import('@/lib/account/erase');
    const out = new Map<string, string>();
    for (const kind of HAND_TITLE_KINDS) {
      out.set(kind, (await pool.query<{ id: string }>(
        `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title, payload)
         VALUES ($1, $2, $3, 'partner_user', $4, '{"details":"ингалятор в рюкзаке"}') RETURNING id`,
        [partner, card, kind, `Рукой партнёра: ${kind}`],
      )).rows[0].id);
    }
    return out;
  }

  it('удаление (а): карточка только из его записей — бронь, бронь из его Telegram до привязки и аренда — стирается: имя, телефон, почта, причина отмены в ленте; ответ «стёрты» (#2327, круг 9)', async () => {
    const uid = await freshTourist('proven');
    const tg = Number((await pool.query<{ tg: string }>(`SELECT telegram_id::text AS tg FROM users WHERE id = $1`, [uid])).rows[0].tg);
    const p = await erasePartner('proven', uid);
    const phone = '+79996661001';
    const own = await pastBooking(p.tour, uid, 'Андрей Петров', phone);
    const card = await linkTo('operator_booking', own);
    // Бронь Кузьмича из его Telegram до привязки аккаунта — без user_id, с меткой канала.
    const fromChat = String((await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone,
         booking_status, metadata)
       VALUES ($1, CURRENT_DATE - 15, 1, NULL, 'Андрюша', $2, 'completed', $3::jsonb) RETURNING id`,
      [p.tour, phone, JSON.stringify({ tg_chat_id: tg, platform: 'tg' })],
    )).rows[0].id);
    expect(await linkTo('operator_booking', fromChat)).toBe(card);
    const item = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity, is_active, moderation_status)
       VALUES ($1, 'Палатка (а)', 'tents', 500, 1, 1, FALSE, 'approved') RETURNING id`, [p.partner],
    )).rows[0].id;
    const rental = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Мама Андрея', 'andrey-gear@example.com', $3, CURRENT_DATE - 9, CURRENT_DATE - 7, 1, 2, 1000, 1000, 'completed')
       RETURNING id`, [item, uid, phone],
    )).rows[0].id;
    expect(await linkTo('gear_rental', rental)).toBe(card);
    const cancelled = await statusEvent(p.partner, card, 'operator_booking', fromChat,
      { from: 'confirmed', to: 'cancelled', reason: 'Андрей заболел' }, { kind: 'tourist', user: null });
    expect((await cardFull(card)).email_norm).not.toBeNull();

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // Каждая связь — его запись, ручной записи, записей партнёра и чужого
    // аккаунта нет: карточка его, хотя имена в записях разные («Андрей
    // Петров», «Андрюша», «Мама Андрея») — имя не судят.
    await erasedCard(card);
    expect(await linksOf(card)).toEqual([`operator_booking:${own}`, `operator_booking:${fromChat}`, `gear_rental:${rental}`]);
    expect(await eventRow(cancelled)).toMatchObject({ c: card, payload: { from: 'confirmed', to: 'cancelled' } });
    expect((await eventRow(cancelled)).payload.reason).toBeUndefined();
    expect(ok.json.kept).toEqual([]);
    expect(ok.json.crm).toEqual({ cards: 0, partners: 0 });
    expect(ok.json.message).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);
  });

  it("удаление (а'): карточки из его брони жилья и его заказа мест в машине — тоже его и стираются (#2327, круг 10)", async () => {
    // Ревью круга 9: строки accommodation_booking и transfer_seat_booking в
    // HIS_CRM_SOURCES не держал ни один тест — без них такие карточки стали бы
    // «могли быть вашими», хотя каждая запись в них его.
    const uid = await freshTourist('proven-stay-seat');
    const p = await erasePartner('proven-stay-seat', uid);
    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, is_active, moderation_status)
       VALUES ($1, 'Гостевой дом (а)', 'guesthouse', '{"lat":53.0,"lng":158.6}', FALSE, 'approved') RETURNING id`, [p.partner],
    )).rows[0].id;
    const stay = (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status)
       VALUES ($1, $2, CURRENT_DATE - 9, CURRENT_DATE - 7, 2, 1, 3000, 6000, 'completed') RETURNING id`, [acc, uid],
    )).rows[0].id;
    // В брони жилья человека нет — карточку заводят имя, телефон и почта его аккаунта.
    const stayCard = await linkTo('accommodation_booking', stay);
    const vehicle = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Вахтовка (а)', 20) RETURNING id`,
      [p.partner],
    )).rows[0].id;
    const trip = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, status)
       VALUES ($1, CURRENT_DATE - 5, 'Петропавловск', 'Мутновский', 20, 'completed') RETURNING id`, [vehicle],
    )).rows[0].id;
    const seat = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status, contact_phone)
       VALUES ($1, $2, 1, 'confirmed', '+79996661102') RETURNING id`, [trip, uid],
    )).rows[0].id;
    const seatCard = await linkTo('transfer_seat_booking', seat);
    expect(seatCard).not.toBe(stayCard);
    expect(await cardFull(stayCard)).toMatchObject({ user_id: uid, phone_e164: '+79990000000' });
    expect((await cardFull(seatCard)).phone_e164).toBe('+79996661102');

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await erasedCard(stayCard);
    await erasedCard(seatCard);
    expect(ok.json.crm).toEqual({ cards: 0, partners: 0 });
  });

  it("удаление (а''): в его карточке партнёр записал о другом человеке с тем же номером — заметка, касание, задача — карточка не доказанно его: всё цело, его связь ушла, ответ называет записи партнёра; по обращению администратор стирает её с основанием в журнале (#2327, круг 10)", async () => {
    const { createManualContact, updateContact } = await import('@/lib/crm/contact-queries');
    const { addContactTouch } = await import('@/lib/crm/events');
    const { createTask } = await import('@/lib/crm/tasks');
    const { unprovenCrmSentence, ERASED_TASK_TITLE } = await import('@/lib/account/erase');
    const { EVENT_KIND_LABELS } = await import('@/lib/crm/event-kinds');
    const uid = await freshTourist('hand-records');
    const p = await erasePartner('hand-records', uid);
    const phone = '+79995550202';
    const his = await bookingWith(p.tour, uid, 'Андрей', phone, 'andrey-hand@example.com');
    const card = await linkTo('operator_booking', his);
    const hisEvent = await statusEvent(p.partner, card, 'operator_booking', his,
      { from: 'confirmed', to: 'cancelled', reason: 'Андрей заболел' }, { kind: 'tourist', user: uid });
    // Звонит его мать: партнёр заводит её руками — номер тот же, и ему
    // отвечают «клиент уже есть» с его карточкой. Всё о ней ложится туда.
    const manual = await createManualContact(p.partner, { display_name: 'Мария', phone });
    expect(manual).toEqual({ outcome: 'exists', id: card });
    expect(await updateContact(p.partner, card, { notes: 'Мария (мама Андрея): диабет, инсулин в холодильнике гида' })).toBe(true);
    const touch = await addContactTouch(p.partner, card, {
      kind: 'call', title: 'Звонила Мария', details: 'у Марии диабет, нужен перерыв на еду',
    });
    if (touch.outcome !== 'recorded') throw new Error(`касание не записано: ${touch.outcome}`);
    const task = await createTask(p.partner, { title: 'Перезвонить Марии про еду', dueAt: new Date(Date.now() + 86_400_000), contactId: card });
    if (task.outcome !== 'created') throw new Error(`задача не заведена: ${task.outcome}`);
    const before = await cardFull(card);
    expect(before).toMatchObject({ user_id: uid, phone_e164: phone, email_norm: 'andrey-hand@example.com' });

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // Записи партнёра о Марии и поля карточки целы; снята ссылка на его аккаунт.
    expect(await cardFull(card)).toEqual({ ...before, user_id: null });
    expect(await eventRow(touch.id)).toMatchObject({
      c: card, title: 'Звонила Мария', payload: { details: 'у Марии диабет, нужен перерыв на еду' },
    });
    expect((await pool.query(`SELECT title, details FROM crm_tasks WHERE id = $1`, [task.task.id])).rows)
      .toEqual([{ title: 'Перезвонить Марии про еду', details: null }]);
    // Его связь и событие ушли, событие обезличено.
    expect(await linksOf(card)).toEqual([]);
    expect(await eventRow(hisEvent)).toEqual({ c: null, title: 'Бронь тура: смена статуса', payload: { from: 'confirmed', to: 'cancelled' } });
    // Ответ: могли быть его или о нём — и называет записи партнёра.
    expect(ok.json.crm).toEqual({ cards: 1, partners: 1 });
    const sentence = unprovenCrmSentence({ cards: 1, partners: 1 })!;
    expect(ok.json.message).toContain(sentence);
    expect(sentence).toContain('заметки, метки, задачи, отметки о звонках, встречах и выполненных задачах');

    // Он пишет по почте ПД; администратор сверил и стирает карточку — с основанием.
    const admin = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Админ (а\'\')', 'x', 'admin') RETURNING id`,
      [`erase-admin-${uid}@example.com`],
    )).rows[0].id;
    const { POST } = await import('@/app/api/admin/crm/contacts/[id]/erase/route');
    const { NextRequest } = await import('next/server');
    const adminPost = async (basis: Record<string, unknown>) => {
      authAs.userId = admin;
      authAs.role = 'admin';
      try {
        const res = await POST(new NextRequest(`http://localhost/api/admin/crm/contacts/${card}/erase`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(basis),
        }) as unknown as NextRequest, { params: Promise.resolve({ id: card }) });
        return { status: res.status, json: await res.json() as { success: boolean; data?: { events: number; tasks: number } } };
      } finally {
        authAs.userId = userId;
        authAs.role = 'tourist';
      }
    };
    // Основание словами (сюда легло бы имя человека) — отказ, карточка цела, журнала нет.
    expect((await adminPost({ reason: `письмо Андрея с номера ${phone}` })).status).toBe(422);
    expect((await cardFull(card)).phone_e164).toBe(phone);
    const received = new Date().toISOString().slice(0, 10);
    const erased = await adminPost({ received, ticket: '17' });
    expect(erased.status, JSON.stringify(erased.json)).toBe(200);
    expect(erased.json.data).toEqual({ events: 1, tasks: 1 });
    await erasedCard(card);
    expect(await eventRow(touch.id)).toEqual({ c: card, title: EVENT_KIND_LABELS.call, payload: {} });
    expect((await pool.query(`SELECT title, details FROM crm_tasks WHERE id = $1`, [task.task.id])).rows)
      .toEqual([{ title: ERASED_TASK_TITLE, details: null }]);
    expect((await pool.query(
      `SELECT user_id::text AS u, action, resource_type, details FROM audit_logs WHERE resource_id = $1`, [card],
    )).rows).toEqual([{
      u: admin, action: 'crm_contact_erased_on_request', resource_type: 'crm_contact',
      details: { received, ticket: '17', partner_id: p.partner },
    }]);
  });

  it("удаление (а'''): каждая запись партнёра по отдельности — заметка, метка, задача, касание любого рукописного вида — делает его карточку не доказанно его (#2327, круг 10)", async () => {
    const { HAND_TITLE_KINDS } = await import('@/lib/account/erase');
    const uid = await freshTourist('hand-each');
    const p = await erasePartner('hand-each', uid);
    const cases: Array<[string, (card: string) => Promise<unknown>]> = [
      ['заметка', (card) => pool.query(`UPDATE crm_contacts SET notes = 'о ком-то с этим номером' WHERE id = $1`, [card])],
      ['метка', (card) => pool.query(`UPDATE crm_contacts SET tags = ARRAY['диабет'] WHERE id = $1`, [card])],
      ['задача', (card) => pool.query(
        `INSERT INTO crm_tasks (partner_id, contact_id, title, due_at) VALUES ($1, $2, 'Перезвонить', NOW() + interval '1 day')`,
        [p.partner, card])],
      ...HAND_TITLE_KINDS.map((kind): [string, (card: string) => Promise<unknown>] => [`касание ${kind}`, (card) => pool.query(
        `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, title) VALUES ($1, $2, $3, 'partner_user', 'Рукой партнёра')`,
        [p.partner, card, kind])]),
    ];
    const cards: Array<[string, string, Record<string, unknown>]> = [];
    let n = 0;
    for (const [label, write] of cases) {
      const card = await linkTo('operator_booking', await pastBooking(p.tour, uid, 'Андрей', `+7999555${String(3000 + n++)}`));
      await write(card);
      cards.push([label, card, await cardFull(card)]);
    }
    // Контроль: такая же карточка без записей партнёра — его и стирается.
    const clean = await linkTo('operator_booking', await pastBooking(p.tour, uid, 'Андрей', '+79995553999'));

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    for (const [label, card, before] of cards) expect(await cardFull(card), label).toEqual({ ...before, user_id: null });
    await erasedCard(clean);
    expect(ok.json.crm).toEqual({ cards: cases.length, partners: 1 });
  });

  it('удаление: склейка, пришедшая во время стирания, не попадает в его карточку — ждёт конца транзакции и заводит другому клиенту свою (#2327, круг 10)', async () => {
    // Ревью круга 9: запирались только карточки, которые не доказанно его.
    // Хук брони матери (тот же номер, её почта) успевал между решением и
    // шагом crm_contacts положить её бронь в его карточку — и шаг стирал её
    // почту, а её бронь навсегда оставалась на «Удалённом пользователе».
    const { linkContactFromSource } = await import('@/lib/crm/contacts');
    const { eraseUser } = await import('@/lib/account/erase');
    const uid = await freshTourist('race');
    const mother = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Мария Гонки', 'x', 'tourist') RETURNING id`,
      [`erase-race-mother-${uid}@example.com`],
    )).rows[0].id;
    const p = await erasePartner('race', uid);
    const phone = '+79995550101';
    const card = await linkTo('operator_booking', await pastBooking(p.tour, uid, 'Андрей', phone));
    const hers = await bookingWith(p.tour, mother, 'Мария', phone, 'maria-race@example.com');
    // Второй случай: у другого партнёра его бронь легла в карточку матери уже
    // после решения о карточках (крон склейки). Решение о ней не принималось
    // — шаги обязаны проверить доказанность сами, а не стереть её целиком.
    const p2 = await erasePartner('race2', uid);
    const hersAt2 = await bookingWith(p2.tour, mother, 'Мария', '+79995550102', 'maria-race2@example.com');
    const herCard2 = await linkTo('operator_booking', hersAt2);
    const hisLate = await pastBooking(p2.tour, uid, 'Андрей', '+79995550102');
    const herCard2Before = await cardFull(herCard2);
    const { UNPROVEN_CRM_CARDS, UNPROVEN_CRM_PARTNERS } = await import('@/lib/account/erase');
    let counts: Record<string, number> = {};

    const a = await pool.connect();
    let herLink: ReturnType<typeof linkContactFromSource> | null = null;
    let herState: 'не начата' | 'ждёт' | 'успела' = 'не начата';
    try {
      await a.query('BEGIN');
      // Её хук начинается между решением о карточках и первым шагом стирания.
      const wrapped = {
        query: async (text: string, params?: unknown[]) => {
          if (herLink === null && /^\s*UPDATE operator_bookings\b/.test(text)) {
            await a.query(
              `INSERT INTO crm_contact_links (contact_id, partner_id, source_kind, source_id, occurred_at)
               VALUES ($1, $2, 'operator_booking', $3, NOW())`, [herCard2, p2.partner, hisLate],
            );
            herLink = linkContactFromSource('operator_booking', hers);
            herState = await Promise.race([
              herLink.then(() => 'успела' as const),
              new Promise<'ждёт'>((r) => setTimeout(() => r('ждёт'), 1500)),
            ]);
          }
          return a.query(text, params);
        },
      };
      counts = await eraseUser(wrapped as never, uid, 'account_deleted');
      await a.query('COMMIT');
    } catch (err) {
      await a.query('ROLLBACK');
      throw err;
    } finally {
      a.release();
    }
    expect(herState).toBe('ждёт');
    const her = await herLink!;
    if (her.outcome !== 'linked') throw new Error(`её бронь не привязана: ${her.outcome}`);
    // Её бронь — в её новой карточке, с её почтой; его карточка стёрта и чужого не несёт.
    expect(her.contactId).not.toBe(card);
    expect(await cardFull(her.contactId)).toMatchObject({ user_id: mother, phone_e164: phone, email_norm: 'maria-race@example.com' });
    await erasedCard(card);
    expect(await linksOf(card)).toHaveLength(1);
    expect(await linksOf(her.contactId)).toEqual([`operator_booking:${hers}`]);
    // Карточка матери у второго партнёра цела: решения о ней не было, и шаги
    // не стирают её целиком, а проверяют доказанность сами.
    expect(await cardFull(herCard2)).toEqual(herCard2Before);
    // Ревью круга 10: его связь, пришедшая после первого прохода, уходила
    // из её карточки только в тесте — на деле оставалась, а ответ о карточке
    // молчал. Второй проход перед лентой уводит её и называет карточку.
    expect(await linksOf(herCard2)).toEqual([`operator_booking:${hersAt2}`]);
    expect(counts[UNPROVEN_CRM_CARDS]).toBe(1);
    expect(counts[UNPROVEN_CRM_PARTNERS]).toBe(1);
  });

  it('удаление: склейка его непривязанной аренды, начатая во время стирания, ждёт коммита и не заводит карточку со стёртыми именем и телефоном (#2327, ревью круга 10)', async () => {
    // Ревью круга 10, сценарий s3: склейка читала человека из аренды до
    // коммита стирания, ждала его карточку по телефону, а после коммита по
    // стёртому телефону её уже не находила и заводила НОВУЮ — с прежними
    // именем, телефоном и почтой. Теперь перед записью она запирает строку
    // источника и перечитывает его: аккаунт стёрт — клиентом он не становится.
    const { linkContactFromSource } = await import('@/lib/crm/contacts');
    const { eraseUser, findEraseBlockers, findRemainingData } = await import('@/lib/account/erase');
    const uid = await freshTourist('race-rental');
    const p = await erasePartner('race-rental', uid);
    const phone = '+79990003333';
    const card = await linkTo('operator_booking', await bookingWith(p.tour, uid, 'Иван Петров', phone, 'ivan-s3@example.com'));
    const item = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity, is_active, moderation_status)
       VALUES ($1, 'Палатка (гонка)', 'tents', 500, 1, 1, FALSE, 'approved') RETURNING id`, [p.partner],
    )).rows[0].id;
    // Его завершённая аренда тем же номером, хуком не привязанная (её подберёт
    // задел или событие смены статуса).
    const rental = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Иван Петров', 'ivan-s3@example.com', $3, CURRENT_DATE - 9, CURRENT_DATE - 7, 1, 2, 1000, 1000, 'completed')
       RETURNING id`, [item, uid, phone],
    )).rows[0].id;

    const a = await pool.connect();
    let link: ReturnType<typeof linkContactFromSource> | null = null;
    let state: 'не начата' | 'ждёт' | 'успела' = 'не начата';
    try {
      await a.query('BEGIN');
      await a.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [uid]);
      expect(await findEraseBlockers(a, uid)).toEqual([]);
      const wrapped = {
        query: async (text: string, params?: unknown[]) => {
          // Карточки уже заперты первым проходом; склейка аренды начинается.
          if (link === null && /^\s*UPDATE operator_bookings\b/.test(text)) {
            link = linkContactFromSource('gear_rental', rental);
            state = await Promise.race([
              link.then(() => 'успела' as const),
              new Promise<'ждёт'>((r) => setTimeout(() => r('ждёт'), 1500)),
            ]);
          }
          return a.query(text, params);
        },
      };
      const counts = await eraseUser(wrapped as never, uid, 'account_deleted');
      await findRemainingData(a, uid, counts);
      await a.query('COMMIT');
    } catch (err) {
      await a.query('ROLLBACK');
      throw err;
    } finally {
      a.release();
    }
    expect(state).toBe('ждёт');
    expect(await link!).toEqual({ outcome: 'no_source' });
    await erasedCard(card);
    // Новой карточки со старыми именем и телефоном нет: у партнёра одна — стёртая.
    expect((await pool.query(`SELECT count(*)::int AS n FROM crm_contacts WHERE partner_id = $1`, [p.partner])).rows)
      .toEqual([{ n: 1 }]);
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM crm_contacts WHERE phone_e164 = $1 OR email_norm = 'ivan-s3@example.com'`, [phone],
    )).rows).toEqual([{ n: 0 }]);
  });

  it('удаление: копия карточки оператора о нём (миграция 1200) — его: строка Telegram снимается, карточка из его броней стирается целиком; заметка партнёра поверх копии и перенесённые метки держат карточку (#2327, ревью круга 10)', async () => {
    // Сценарий s1 ревью: 1200 дописала ник из operator_client_notes (ключ —
    // его аккаунт) в заметку его карточки. Шаг operator_client_notes удалял
    // оригинал, а копия оставалась — и делала карточку из одних его броней
    // «не доказанно его»: имя, телефон и почта не стирались.
    const m1200 = readFileSync(join(process.cwd(), 'migrations/1200_operator_client_notes_to_crm.sql'), 'utf-8');
    const copy1200 = m1200.split(';').map((x) => x.replace(/^\s*--.*$/gm, '').trim())
      .find((x) => x.startsWith('UPDATE crm_contacts c'));
    if (!copy1200) throw new Error('перенос миграции 1200 не найден');
    const notesRow = (partner: string, uid: string, tags: string[], telegram: string | null) => pool.query(
      `INSERT INTO operator_client_notes (operator_id, user_id, tags, telegram) VALUES ($1, $2, $3, $4)`, [partner, uid, tags, telegram],
    );

    // 1. Только копия ника: карточка его и стирается целиком, ответ — «стёрты».
    const uid = await freshTourist('copy1200');
    const p = await erasePartner('copy1200', uid);
    const card = await linkTo('operator_booking', await bookingWith(p.tour, uid, 'Иван Петров', '+79990001111', 'ivan-s1@example.com'));
    await notesRow(p.partner, uid, [], 'ivan_k');
    await pool.query(copy1200);
    expect((await cardFull(card)).notes).toBe('Telegram: @ivan_k');
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await erasedCard(card);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_client_notes WHERE user_id = $1`, [uid])).rows).toEqual([{ n: 0 }]);
    expect(ok.json.crm).toEqual({ cards: 0, partners: 0 });
    expect(ok.json.message).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);

    // 2. Заметка партнёра до 1200 и копия числового ника; 3. перенесённая метка.
    const uid2 = await freshTourist('copy1200-mixed');
    const p2 = await erasePartner('copy1200-mixed', uid2);
    const noted = await linkTo('operator_booking', await bookingWith(p2.tour, uid2, 'Иван', '+79990001112', 'ivan-s1b@example.com'));
    await pool.query(`UPDATE crm_contacts SET notes = 'Боится высоты' WHERE id = $1`, [noted]);
    await notesRow(p2.partner, uid2, [], '123456789');
    const p3 = await erasePartner('copy1200-tag', uid2);
    const tagged = await linkTo('operator_booking', await bookingWith(p3.tour, uid2, 'Иван', '+79990001113', 'ivan-s1c@example.com'));
    await notesRow(p3.partner, uid2, ['VIP'], 'ivan_tag');
    await pool.query(copy1200);
    const notedBefore = await cardFull(noted);
    const taggedBefore = await cardFull(tagged);
    expect(notedBefore.notes).toBe('Боится высоты\nTelegram: 123456789');
    expect(taggedBefore).toMatchObject({ notes: 'Telegram: @ivan_tag', tags: ['VIP'] });
    const ok2 = await callDelete(uid2, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok2.status, JSON.stringify(ok2.json)).toBe(200);
    // Заметка партнёра цела, его ник из неё снят; карточка не доказанно его.
    expect(await cardFull(noted)).toEqual({ ...notedBefore, user_id: null, notes: 'Боится высоты' });
    // Метку 1200 от метки партнёра по строке не отличить: она остаётся и
    // держит карточку; ник снят, заметка пуста.
    expect(await cardFull(tagged)).toEqual({ ...taggedBefore, user_id: null, notes: null });
    expect(await linksOf(noted)).toEqual([]);
    expect(await linksOf(tagged)).toEqual([]);
    expect(ok2.json.crm).toEqual({ cards: 2, partners: 2 });
  });

  it('удаление: карточку из его броней партнёр переименовал — имя записал партнёр, карточка не доказанно его; повтор того же имени следа не оставляет (#2327, ревью круга 10)', async () => {
    // Мать звонит с семейного номера, «клиент уже есть» — карточка сына, и
    // партнёр переименовывает её в мать. До следа переименования удаление
    // аккаунта сына стирало такую карточку целиком — с записью о матери.
    const { updateContact } = await import('@/lib/crm/contact-queries');
    const uid = await freshTourist('renamed');
    const p = await erasePartner('renamed', uid);
    const renamed = await linkTo('operator_booking', await bookingWith(p.tour, uid, 'Андрей', '+79996667001', 'andrey-rn@example.com'));
    expect(await updateContact(p.partner, renamed, { display_name: 'Мария Ивановна (мама Андрея)' })).toBe(true);
    const same = await linkTo('operator_booking', await bookingWith(p.tour, uid, 'Андрей', '+79996667002', 'andrey-rn2@example.com'));
    expect(await updateContact(p.partner, same, { display_name: 'Андрей' })).toBe(true);
    const trace = async (id: string) => (await pool.query<{ t: boolean }>(
      `SELECT renamed_by_partner_at IS NOT NULL AS t FROM crm_contacts WHERE id = $1`, [id],
    )).rows[0].t;
    expect(await trace(renamed)).toBe(true);
    expect(await trace(same)).toBe(false);
    const before = await cardFull(renamed);
    expect(before.display_name).toBe('Мария Ивановна (мама Андрея)');

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await cardFull(renamed)).toEqual({ ...before, user_id: null });
    expect(await linksOf(renamed)).toEqual([]);
    await erasedCard(same);
    expect(ok.json.crm).toEqual({ cards: 1, partners: 1 });
  });

  it('удаление: открытый контроль маршрута держит, пока нет отметки о возвращении, — и после срока, и после «жив, задерживаюсь»; закрытый стирается (#2327, ревью круга 10)', async () => {
    // Сторож невозвращения ведёт контроль, пока completed_at пуст: просроченный
    // — как раз тот, по которому ищут, а «жив, задерживаюсь» лестницу не
    // снимает. Прежний отказ смотрел на дату и отметку «жив» — и удаление
    // стирало телефон руководителя, контакт и последнюю точку, по которым
    // дежурный начнёт поиск.
    const { TRIP_WATCH_CLOSURE_HOLD_HOURS } = await import('@/lib/account/erase');
    const uid = await freshTourist('watch-open');
    const reg = async (sql: string) => (await pool.query<{ id: string }>(
      `INSERT INTO route_registrations (user_id, route_name, start_date, end_date, group_size, leader_name, leader_phone,
         emergency_contact_name, emergency_contact_phone, expected_return_at, checkin_confirmed_at, last_position_lat, last_position_lng)
       ${sql} RETURNING id`, [uid],
    )).rows[0].id;
    const overdue = await reg(`VALUES ($1, 'Авачинский', CURRENT_DATE - 2, CURRENT_DATE - 1, 1, 'Иван', '+79990004444',
         'Мама', '+79990005555', NOW() - interval '20 hours', NULL, 53.25, 158.83)`);
    const r1 = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(r1.status).toBe(409);
    expect(r1.json.blockers).toEqual(['active_route_registration']);
    expect(r1.json.error).toContain('«Я вернулся»');
    const phones = async (id: string) => (await pool.query(
      `SELECT leader_phone, emergency_contact_phone, last_position_lat::float AS lat FROM route_registrations WHERE id = $1`, [id],
    )).rows[0];
    expect(await phones(overdue)).toEqual({ leader_phone: '+79990004444', emergency_contact_phone: '+79990005555', lat: 53.25 });

    await pool.query(`UPDATE route_registrations SET completed_at = NOW(), closed_reason = 'returned' WHERE id = $1`, [overdue]);
    const alive = await reg(`VALUES ($1, 'Мутновский', CURRENT_DATE, CURRENT_DATE + 2, 2, 'Иван', '+79990004444',
         'Мама', '+79990005555', NOW() + interval '2 days', NOW(), 52.45, 158.19)`);
    const r2 = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(r2.status).toBe(409);
    // Просроченный только что закрыт после срока — его держит ожидание отбоя.
    expect(r2.json.blockers).toEqual(['active_route_registration', 'recent_route_registration']);
    expect(await phones(alive)).toEqual({ leader_phone: '+79990004444', emergency_contact_phone: '+79990005555', lat: 52.45 });

    // Отметил возвращение — контроль закрыт. Просроченный закрыт после своего
    // срока: прогон сторожа мог взять его до отметки и ещё дослать ступень и
    // отбой — по этим адресам; удаление ждёт (ревью круга 10, пункт 1).
    await pool.query(`UPDATE route_registrations SET completed_at = NOW(), closed_reason = 'returned' WHERE id = $1`, [alive]);
    const held = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(held.status).toBe(409);
    expect(held.json.blockers).toEqual(['recent_route_registration']);
    expect(await phones(overdue)).toEqual({ leader_phone: '+79990004444', emergency_contact_phone: '+79990005555', lat: 53.25 });
    // Прошло больше срока удержания — удаление проходит и стирает обе.
    await pool.query(
      `UPDATE route_registrations SET completed_at = NOW() - interval '1 hour' * $2 - interval '1 minute' WHERE id = $1`,
      [overdue, TRIP_WATCH_CLOSURE_HOLD_HOURS],
    );
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    for (const id of [overdue, alive]) {
      expect(await phones(id)).toEqual({ leader_phone: '', emergency_contact_phone: '', lat: null });
    }
  });

  it('удаление: закрытый недавно контроль, по которому писали контакту, держит, пока не дойдёт отбой; потом журнал доставки теряет телефон и почту контакта — роли, ступени и отказ без адреса остаются (#2327, ревью круга 10)', async () => {
    // Сторож пишет в журнал телефон или почту контакта (recipient), а
    // отказ почтового сервера повторяет адрес. Отбой «вернулся» берёт адресатов
    // из журнала и Telegram контакта из регистрации — стёртые раньше отбоя,
    // они оставили бы контакт в тревоге.
    const { findEraseBlockers, TRIP_WATCH_CLOSURE_HOLD_HOURS, ERASED_RECIPIENT, ERASED_DELIVERY_ERROR } = await import('@/lib/account/erase');
    const uid = await freshTourist('watch-journal');
    const reg = (await pool.query<{ id: string }>(
      `INSERT INTO route_registrations (user_id, route_name, start_date, end_date, group_size, leader_name, leader_phone,
         emergency_contact_name, emergency_contact_phone, emergency_contact_email, emergency_contact_telegram_chat_id,
         expected_return_at, completed_at, closed_reason)
       VALUES ($1, 'Авачинский', CURRENT_DATE - 1, CURRENT_DATE + 1, 1, 'Иван', '+79990006666', 'Мама', '+79990007777',
         'Mama.Ivana@example.com', 7770001, NOW() + interval '1 day', NOW() - interval '30 minutes', 'returned')
       RETURNING id`, [uid],
    )).rows[0].id;
    // Закрыт вовремя и без продлений, писем никому — сторож его не брал: не держит.
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    // Срок продлевали — до продления он мог быть просрочен: держит.
    await pool.query(`UPDATE route_registrations SET ladder_reset_at = NOW() - interval '2 hours' WHERE id = $1`, [reg]);
    expect(await findEraseBlockers(pool, uid)).toEqual(['recent_route_registration']);
    await pool.query(`UPDATE route_registrations SET ladder_reset_at = NULL WHERE id = $1`, [reg]);
    await pool.query(
      `INSERT INTO route_registration_notifications (registration_id, step, channel, recipient, status, error_message, sent_at) VALUES
         ($1, 1, 'max', 'tourist', 'failed', 'MAX не ответил за 10 с', NOW() - interval '3 hours'),
         ($1, 1, 'telegram', '+79990007777', 'sent', NULL, NOW() - interval '2 hours'),
         ($1, 1, 'email', 'Mama.Ivana@example.com', 'failed',
          'SMTP error: 550 5.1.1 <mama.ivana@example.com>: Recipient address rejected', NOW() - interval '2 hours'),
         ($1, 2, 'admin_only', 'admin', 'sent', NULL, NOW() - interval '1 hour'),
         ($1, 2, 'none', 'admin', 'failed', 'у контакта нет Telegram; дежурный: MAX не ответил', NOW() - interval '1 hour')`,
      [reg],
    );
    // Чужой контроль с тем же контактом — не его, журнал не тронут.
    const other = (await pool.query<{ id: string }>(
      `INSERT INTO route_registrations (user_id, route_name, start_date, end_date, group_size, leader_name, leader_phone,
         emergency_contact_name, emergency_contact_phone, completed_at)
       VALUES ($1, 'Мутновский', CURRENT_DATE - 9, CURRENT_DATE - 8, 1, 'Брат', '+79990008888', 'Мама', '+79990007777',
         NOW() - interval '7 days') RETURNING id`, [otherUserId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO route_registration_notifications (registration_id, step, channel, recipient, status, sent_at)
       VALUES ($1, 2, 'telegram', '+79990007777', 'sent', NOW() - interval '7 days')`, [other],
    );

    const held = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(held.status).toBe(409);
    expect(held.json.blockers).toEqual(['recent_route_registration']);
    expect(held.json.error).toContain(`Подождите ${TRIP_WATCH_CLOSURE_HOLD_HOURS} ч`);
    const journal = async (id: string) => (await pool.query<{ step: number; channel: string; recipient: string; status: string; error: string | null }>(
      `SELECT step, channel, recipient, status, error_message AS error FROM route_registration_notifications
        WHERE registration_id = $1 ORDER BY step, channel`, [id],
    )).rows;
    expect((await journal(reg)).map((n) => n.recipient)).toContain('+79990007777');

    // Срок удержания прошёл — отбою адрес больше не нужен.
    await pool.query(
      `UPDATE route_registrations SET completed_at = NOW() - interval '1 hour' * $2 - interval '1 minute' WHERE id = $1`,
      [reg, TRIP_WATCH_CLOSURE_HOLD_HOURS],
    );
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const after = await journal(reg);
    expect(after).toEqual([
      { step: 1, channel: 'email', recipient: ERASED_RECIPIENT, status: 'failed', error: ERASED_DELIVERY_ERROR },
      { step: 1, channel: 'max', recipient: 'tourist', status: 'failed', error: 'MAX не ответил за 10 с' },
      { step: 1, channel: 'telegram', recipient: ERASED_RECIPIENT, status: 'sent', error: null },
      { step: 2, channel: 'admin_only', recipient: 'admin', status: 'sent', error: null },
      { step: 2, channel: 'none', recipient: 'admin', status: 'failed', error: 'у контакта нет Telegram; дежурный: MAX не ответил' },
    ]);
    // Ни телефона, ни почты контакта (и руководителя) в журнале — ни в адресате, ни в тексте отказа.
    const text = JSON.stringify(after).toLowerCase();
    for (const pd of ['+79990007777', 'mama.ivana@example.com', '+79990006666', '7770001']) expect(text).not.toContain(pd);
    expect(await journal(other)).toEqual([{ step: 2, channel: 'telegram', recipient: '+79990007777', status: 'sent', error: null }]);
  });

  it('удаление: каналы его карточки партнёра — его id в Telegram и MAX и диалог MAX, где он писал Кузьмичу, — снимаются вместе с зеркалом; чат команды и чужая карточка не тронуты и названы в ответе (#2327, ревью круга 10)', async () => {
    // Вход через Telegram пишет partners.telegram_chat_id = его id, «Старт»
    // по ссылке привязки — id чата (в MAX — диалога) и зеркало в contacts.
    // После удаления туда шли бы напоминания CRM с именами клиентов.
    const { ERASE_STEP_LEAVES } = await import('@/lib/account/erase');
    const uid = await freshTourist('partner-channels');
    const tg = Number((await pool.query<{ tg: string }>(
      `UPDATE users SET telegram_chat_id = telegram_id, max_user_id = $2 WHERE id = $1 RETURNING telegram_id::text AS tg`,
      [uid, 660000 + Math.floor(Math.random() * 9999)],
    )).rows[0].tg);
    const maxUser = Number((await pool.query<{ m: string }>(`SELECT max_user_id::text AS m FROM users WHERE id = $1`, [uid])).rows[0].m);
    const dialog = 5_000_000_000 + Math.floor(Math.random() * 99999);
    const team = -1_000_000_000_000 - Math.floor(Math.random() * 99999);
    await pool.query(
      `INSERT INTO tg_conversations (chat_id, mode, role, content, user_id, platform) VALUES ($1, 'tourist', 'user', 'Привет', $2, 'max')`,
      [dialog, maxUser],
    );
    // Карточка на человека — одна в категории (idx_partners_user_category).
    const card = async (slug: string, owner: string, category: string, tgChat: number | null, maxChat: number | null, contacts: unknown) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_verified, is_public, widget_enabled, slug, user_id,
           telegram_chat_id, max_chat_id, contacts)
         VALUES ($1, $6, '{}', TRUE, FALSE, FALSE, $1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [`${slug}-${uid.slice(0, 8)}`, owner, tgChat, maxChat, JSON.stringify(contacts), category],
      )).rows[0].id;
    // Его: id в Telegram, диалог MAX с его перепиской, зеркало его id.
    const own = await card('erase-own', uid, 'operator', tg, dialog, { telegram_chat_id: String(tg), phone: '+74150000001' });
    // Чат команды в Telegram — не его; MAX — его max_user_id.
    const mixed = await card('erase-team', uid, 'guide', team, maxUser, { telegram_chat_id: String(team) });
    // Чужая карточка с тем же числом — не его карточка.
    const stranger = await freshTourist('partner-stranger');
    const foreign = await card('erase-foreign', stranger, 'operator', tg, maxUser, { telegram_chat_id: String(tg) });

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const channels = async (id: string) => (await pool.query(
      `SELECT telegram_chat_id::text AS tg, max_chat_id::text AS max, contacts FROM partners WHERE id = $1`, [id],
    )).rows[0];
    expect(await channels(own)).toEqual({ tg: null, max: null, contacts: { phone: '+74150000001' } });
    expect(await channels(mixed)).toEqual({ tg: String(team), max: null, contacts: { telegram_chat_id: String(team) } });
    expect(await channels(foreign)).toEqual({ tg: String(tg), max: String(maxUser), contacts: { telegram_chat_id: String(tg) } });
    // Чат команды назван: по записям он не его, напоминания идут туда.
    const leaves = ERASE_STEP_LEAVES['partners.channels'];
    expect(ok.json.kept).toContainEqual({ category: leaves.category, why: leaves.why, count: 1 });
    expect(ok.json.message).not.toContain('персональные данные стёрты');
    expect(ok.json.message).toContain(`Осталось: `);
    expect(ok.json.message).toContain(leaves.category);
  });

  it('удаление: возврат по его отменённой брони, который администратор ещё не отметил, держит (409); нулевой к возврату и отмеченный — нет (#2327, ревью круга 10)', async () => {
    // Деньги переводит администратор вручную по контактам брони и видит её в
    // «Ждут возврата»; после удаления там остался бы «Удалённый пользователь»
    // без телефона и почты.
    const { findEraseBlockers } = await import('@/lib/account/erase');
    const uid = await freshTourist('refund');
    const booking = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone,
         tourist_email, booking_status, payment_status, paid_at)
       VALUES ($1, CURRENT_DATE + 20, 1, $2, 'Иван', '+79990009999', 'refund@example.com', 'cancelled', 'paid', NOW() - interval '3 days')
       RETURNING id`, [tourId, uid],
    )).rows[0].id;
    const payment = (await pool.query<{ id: string }>(
      `INSERT INTO tour_payments (booking_id, operator_id, retail_amount, net_amount, commission_amount, commission_rate, status, refund_due)
       VALUES ($1, $2, 5000, 4500, 500, 10, 'HELD', 2500) RETURNING id`, [booking, operatorId],
    )).rows[0].id;
    const r = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(r.status).toBe(409);
    expect(r.json.blockers).toEqual(['refund_pending']);
    expect(r.json.error).toContain('ещё не отметила возврат');
    expect((await pool.query(`SELECT tourist_phone FROM operator_bookings WHERE id = $1`, [booking])).rows)
      .toEqual([{ tourist_phone: '+79990009999' }]);
    // Отмена до 1012: суммы к возврату не записано — возвращается вся, держит.
    await pool.query(`UPDATE tour_payments SET refund_due = NULL WHERE id = $1`, [payment]);
    expect(await findEraseBlockers(pool, uid)).toEqual(['refund_pending']);
    // К возврату ноль (поздняя отмена при 0%) — должны ничего, не держит.
    await pool.query(`UPDATE tour_payments SET refund_due = 0 WHERE id = $1`, [payment]);
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    // Бронь не отменена — платёж уйдёт оператору, возврата нет, не держит.
    await pool.query(`UPDATE tour_payments SET refund_due = 2500 WHERE id = $1`, [payment]);
    await pool.query(`UPDATE operator_bookings SET booking_status = 'completed', booking_date = CURRENT_DATE - 5 WHERE id = $1`, [booking]);
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    await pool.query(`UPDATE operator_bookings SET booking_status = 'cancelled' WHERE id = $1`, [booking]);
    expect(await findEraseBlockers(pool, uid)).toEqual(['refund_pending']);

    // Администратор отметил возврат (POST /api/admin/finance/refunds) — удаление проходит.
    await pool.query(
      `UPDATE tour_payments SET status = 'REFUNDED', refunded_at = NOW(), refund_amount = 2500,
         refund_reason = 'перевод СБП, операция 12345' WHERE id = $1`, [payment],
    );
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await pool.query(`SELECT tourist_phone FROM operator_bookings WHERE id = $1`, [booking])).rows)
      .toEqual([{ tourist_phone: null }]);
  });

  it('удаление (б): карточка с его бронью и чужой заявкой, ручная карточка партнёра с его бронью, карточка с заявкой, которой уже нет, — не доказанно его: поля, заметки, задачи и касания целы, его связи и события ушли, ответ — «могли быть вашими» и куда написать (#2327, круг 9)', async () => {
    const { createManualContact } = await import('@/lib/crm/contact-queries');
    const { listContactEvents, recordSourceEvent } = await import('@/lib/crm/events');
    const { UNLINKED_WHERE } = await import('@/lib/crm/source-specs');
    const { UNPROVEN_CARD_KEEP, unprovenCrmSentence } = await import('@/lib/account/erase');
    const uid = await freshTourist('unproven');
    // 1. Его бронь первой: в карточке его имя, почта, согласие и ссылка на его
    // аккаунт; потом заявка тем же номером — «Андрей», он это или брат, не сказать.
    const p1 = await erasePartner('unproven1', uid);
    const his1 = await bookingWith(p1.tour, uid, 'Андрей Первый', '+79996662001', 'andrey.first@example.com',
      { at: '2026-09-12T10:00:00Z', ip: '203.0.113.61' });
    const card1 = await linkTo('operator_booking', his1);
    const lead1 = await leadFor(p1.partner, 'Андрей', '+79996662001', 'andrey-work@example.com');
    expect(await linkTo('lead', lead1)).toBe(card1);
    await pool.query(`UPDATE crm_contacts SET notes = 'Боится высоты', tags = ARRAY['высота'] WHERE id = $1`, [card1]);
    const task1 = (await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, contact_id, title, details, due_at)
       VALUES ($1, $2, 'Перезвонить про высоту', 'спросить про маршрут', NOW() + interval '1 day') RETURNING id`, [p1.partner, card1],
    )).rows[0].id;
    const touches = await touchesIn(p1.partner, card1);
    const hisEvent = await statusEvent(p1.partner, card1, 'operator_booking', his1,
      { from: 'confirmed', to: 'cancelled', reason: 'Андрей заболел' }, { kind: 'tourist', user: uid });
    const leadEvent = await statusEvent(p1.partner, card1, 'lead', lead1, { from: 'new', to: 'in_progress', comment: 'перезвонить вечером' });
    // Сообщения его беседы с партнёром (recordUserEvent: по аккаунту, без источника).
    const opUser = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Оператор (б)', 'x', 'operator') RETURNING id`,
      [`erase-op-unproven-${uid}@example.com`],
    )).rows[0].id;
    const conv = (await pool.query<{ id: string }>(`INSERT INTO conversations (created_by) VALUES ($1) RETURNING id`, [uid])).rows[0].id;
    await pool.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, 'tourist'), ($1, $3, 'operator')`,
      [conv, uid, opUser],
    );
    const chatIn = (await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, actor_user_id, title, payload)
       VALUES ($1, $2, 'message_in', 'tourist', $3, 'Сообщение от клиента в чате платформы', $4::jsonb) RETURNING id`,
      [p1.partner, card1, uid, JSON.stringify({ conversation_id: conv })],
    )).rows[0].id;
    const chatOut = (await pool.query<{ id: string }>(
      `INSERT INTO crm_events (partner_id, contact_id, kind, actor_kind, actor_user_id, title, payload)
       VALUES ($1, $2, 'message_out', 'partner_user', $3, 'Сообщение клиенту в чате платформы', $4::jsonb) RETURNING id`,
      [p1.partner, card1, opUser, JSON.stringify({ conversation_id: conv })],
    )).rows[0].id;
    const before1 = await cardFull(card1);
    expect(before1).toMatchObject({
      user_id: uid, display_name: 'Андрей Первый', email_norm: 'andrey.first@example.com', pd_consent_ip: '203.0.113.61',
    });
    // 2. Ручная карточка партнёра на Марию; его бронь тем же номером дописала
    // туда ссылку на его аккаунт и его почту.
    const p2 = await erasePartner('unproven2', uid);
    const manual = await createManualContact(p2.partner, {
      display_name: 'Мария Иванова', phone: '+79996662002', notes: 'Диабет, инсулин в холодильнике гида', tags: ['диабет'],
    });
    if (manual.outcome !== 'created') throw new Error(`ручная карточка не заведена: ${manual.outcome}`);
    const card2 = manual.id;
    const his2 = await bookingWith(p2.tour, uid, 'Андрей', '+79996662002', 'andrey-maria@example.com');
    expect(await linkTo('operator_booking', his2)).toBe(card2);
    const before2 = await cardFull(card2);
    expect(before2).toMatchObject({ user_id: uid, email_norm: 'andrey-maria@example.com' });
    // 3. Карточку завела заявка, которую потом удалили (внешнего ключа на связь
    // нет): чья она была, не узнать; его бронь легла туда же.
    const p3 = await erasePartner('unproven3', uid);
    const lead3 = await leadFor(p3.partner, 'Гость', '+79996662003');
    const card3 = await linkTo('lead', lead3);
    await pool.query(`DELETE FROM leads WHERE id = $1`, [lead3]);
    const his3 = await pastBooking(p3.tour, uid, 'Андрей', '+79996662003');
    expect(await linkTo('operator_booking', his3)).toBe(card3);
    const before3 = await cardFull(card3);

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // Поля карточек — как были; снята только ссылка на его аккаунт.
    expect(await cardFull(card1)).toEqual({ ...before1, user_id: null });
    expect(await cardFull(card2)).toEqual({ ...before2, user_id: null });
    expect(await cardFull(card3)).toEqual({ ...before3, user_id: null });
    // Его связей нет нигде; чужие на месте.
    expect(await linksOf(card1)).toEqual([`lead:${lead1}`]);
    expect(await linksOf(card2)).toEqual([]);
    expect(await linksOf(card3)).toEqual([`lead:${lead3}`]);
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM crm_contact_links WHERE source_kind = 'operator_booking' AND source_id = ANY($1::text[])`,
      [[his1, his2, his3]],
    )).rows).toEqual([{ n: 0 }]);
    // Его события ушли из ленты и обезличены; событие заявки, задача и касания — целы.
    expect(await eventRow(hisEvent)).toEqual({ c: null, title: 'Бронь тура: смена статуса', payload: { from: 'confirmed', to: 'cancelled' } });
    expect(await eventRow(chatIn)).toMatchObject({ c: null, payload: { conversation_id: conv } });
    expect(await eventRow(chatOut)).toMatchObject({ c: null, payload: { conversation_id: conv } });
    expect(await eventRow(leadEvent)).toEqual({
      c: card1, title: 'Бронь тура: смена статуса', payload: { from: 'new', to: 'in_progress', comment: 'перезвонить вечером' },
    });
    expect((await pool.query(`SELECT title, details FROM crm_tasks WHERE id = $1`, [task1])).rows)
      .toEqual([{ title: 'Перезвонить про высоту', details: 'спросить про маршрут' }]);
    const feed = await listContactEvents(p1.partner, card1);
    expect(feed.map((e) => e.id).sort()).toEqual([leadEvent, ...touches.values()].sort());
    // Построчный сторож: касание вида k пережило удаление нетронутым ⇔ вид
    // назван в UNPROVEN_CARD_KEEP. Путь начнёт их обезличивать — запись станет
    // ложью и покраснеет здесь.
    const survived: string[] = [];
    for (const [kind, id] of touches) {
      const row = await eventRow(id);
      if (row.c === card1 && row.title === `Рукой партнёра: ${kind}` && row.payload.details === 'ингалятор в рюкзаке') survived.push(kind);
    }
    expect(survived.sort()).toEqual(Object.keys(UNPROVEN_CARD_KEEP)
      .filter((k) => k.startsWith('crm_events.')).map((k) => k.slice('crm_events.'.length)).sort());
    expect(survived.length).toBeGreaterThan(0);
    // Его бронь клиентом снова не стала: задел её не видит, событие по ней
    // карточку не заводит, у партнёра по-прежнему одна карточка.
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM operator_bookings s JOIN operator_tours t ON t.id = s.operator_tour_id
        WHERE s.id = $1 AND ${UNLINKED_WHERE.operator_booking}`, [his1],
    )).rows).toEqual([{ n: 0 }]);
    expect(await recordSourceEvent({
      sourceKind: 'operator_booking', sourceId: his1, kind: 'status_change', actorKind: 'partner_user', title: 'Бронь тура: оплата отмечена',
    })).toEqual({ outcome: 'no_contact' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM crm_contacts WHERE partner_id = $1`, [p1.partner])).rows)
      .toEqual([{ n: 1 }]);
    // Ответ: правда без угадывания — остались, могли быть его, куда написать.
    expect(ok.json.kept).toEqual([]);
    expect(ok.json.crm).toEqual({ cards: 3, partners: 3 });
    const sentence = unprovenCrmSentence({ cards: 3, partners: 3 })!;
    expect(sentence).toContain('У 3 партнёров остались карточки клиентов, где были и ваши заявки.');
    expect(sentence).toContain('могли быть вашими');
    expect(sentence).toContain('info@vedarai.ru');
    expect(ok.json.message).toContain(sentence);
    expect(ok.json.message).not.toContain('персональные данные стёрты');
    // В карточке осталась заметка партнёра «Боится высоты» — ответ её называет.
    expect((await cardFull(card1)).notes).toBe('Боится высоты');
    expect(ok.json.message).toMatch(/записи партнёра о клиенте \(заметки, метки, задачи/);

    // Он пишет; администратор стирает карточку по обращению. Стирается ровно
    // то, что обещают ответ и экран: поля и записи партнёра в карточке. Сама
    // заявка «Андрей» в ней — может быть, его брата с тем же номером — цела, и
    // ответ говорит это («Сами заявки это не стирает»), а не «стёрто всё».
    const { eraseCrmContactOnRequest, ERASED_NAME } = await import('@/lib/account/erase');
    const { getContactCard } = await import('@/lib/crm/contact-queries');
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      expect(await eraseCrmContactOnRequest(tx, card1)).toMatchObject({ partnerId: p1.partner });
      await tx.query('COMMIT');
    } finally {
      tx.release();
    }
    expect(ok.json.message).toContain('Сами заявки это не стирает: имя и телефон, записанные в заявке, остаются у партнёра.');
    expect((await pool.query(`SELECT name, phone FROM leads WHERE id = $1`, [lead1])).rows)
      .toEqual([{ name: 'Андрей', phone: '+79996662001' }]);
    const after = await getContactCard(p1.partner, card1);
    expect(after).toMatchObject({ display_name: ERASED_NAME, phone: null, email: null, notes: null });
    // Источник по-прежнему несёт имя из своей строки — экран карточки со
    // стёртым клиентом им не подписывает (рендер — crm-erase-on-request).
    expect(after!.sources.map((x) => [x.kind, x.person_name])).toEqual([['lead', 'Андрей']]);
  });

  it('удаление (в): семейный номер — карточка матери с её аккаунтом цела, её чат по-прежнему ложится в неё, его бронь и событие ушли; карточка с её аккаунтом и одной его бронью — тоже не его (#2327, круг 9)', async () => {
    const { recordUserEvent } = await import('@/lib/crm/events');
    const { unprovenCrmSentence } = await import('@/lib/account/erase');
    const uid = await freshTourist('family');
    const mother = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Мария Семейная', 'x', 'tourist') RETURNING id`,
      [`erase-mother-${uid}@example.com`],
    )).rows[0].id;
    const p = await erasePartner('family', uid);
    const hers = await pastBooking(p.tour, mother, 'Мария Семейная', '+79996663001');
    const card = await linkTo('operator_booking', hers);
    await pool.query(`UPDATE crm_contacts SET notes = 'Мария: давление, таблетки', tags = ARRAY['давление'] WHERE id = $1`, [card]);
    const herEvent = await statusEvent(p.partner, card, 'operator_booking', hers, { from: 'new', to: 'confirmed', comment: 'место у окна' });
    // Он — тем же номером в другой записи: склейка кладёт его бронь в её карточку.
    const his = await pastBooking(p.tour, uid, 'Андрей', '+7 999 666-30-01');
    expect(await linkTo('operator_booking', his)).toBe(card);
    const hisEvent = await statusEvent(p.partner, card, 'operator_booking', his,
      { from: 'confirmed', to: 'cancelled', reason: 'Андрей простыл' }, { kind: 'tourist', user: uid });
    const before = await cardFull(card);
    expect(before.user_id).toBe(mother);
    // У второго партнёра карточка матери, чью связь с её бронью уже сняли:
    // кроме его брони в ней ничего, но ссылка на аккаунт — её. Карточка не
    // доказанно его, и поля её целы.
    const p2 = await erasePartner('family2', uid);
    const hers2 = await pastBooking(p2.tour, mother, 'Мария Семейная', '+79996663002');
    const card2 = await linkTo('operator_booking', hers2);
    await pool.query(`DELETE FROM crm_contact_links WHERE contact_id = $1`, [card2]);
    await pool.query(`UPDATE crm_contacts SET notes = 'Мария: давление' WHERE id = $1`, [card2]);
    const his2 = await pastBooking(p2.tour, uid, 'Андрей', '+79996663002');
    expect(await linkTo('operator_booking', his2)).toBe(card2);
    const before2 = await cardFull(card2);
    expect(before2.user_id).toBe(mother);

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await cardFull(card)).toEqual(before);
    expect(await cardFull(card2)).toEqual(before2);
    expect(await linksOf(card2)).toEqual([]);
    expect(await linksOf(card)).toEqual([`operator_booking:${hers}`]);
    expect(await eventRow(herEvent)).toMatchObject({ c: card, payload: { from: 'new', to: 'confirmed', comment: 'место у окна' } });
    expect(await eventRow(hisEvent)).toMatchObject({ c: null, payload: { from: 'confirmed', to: 'cancelled' } });
    expect((await pool.query(`SELECT user_id::text AS u, tourist_name, tourist_phone FROM operator_bookings WHERE id = $1`, [hers])).rows)
      .toEqual([{ u: mother, tourist_name: 'Мария Семейная', tourist_phone: '+79996663001' }]);
    expect(await recordUserEvent({
      partnerId: p.partner, userId: mother, kind: 'message_in', actorKind: 'tourist', title: 'Сообщение от клиента в чате платформы',
    })).toMatchObject({ outcome: 'recorded', contactId: card });
    expect(ok.json.crm).toEqual({ cards: 2, partners: 2 });
    expect(ok.json.message).toContain(unprovenCrmSentence({ cards: 2, partners: 2 })!);
  });

  it('удаление (г): аккаунт MAX «Путешественник» — его карточка с его аккаунтом стирается целиком, хотя имена в ней другие; заявка на его же имя у другого партнёра карточку его не делает (#2327, круг 9)', async () => {
    const uid = await freshTourist('max-traveler');
    await pool.query(`UPDATE users SET name = 'Путешественник', email = $2, max_user_id = $3 WHERE id = $1`,
      [uid, `max_${uid}@max.local`, 7000000 + Math.floor(Math.random() * 99999)]);
    const p1 = await erasePartner('maxown', uid);
    const card = await linkTo('operator_booking', await pastBooking(p1.tour, uid, 'Андрей Петров', '+79996664001'));
    // Бронь за жену тем же номером — тоже его запись: он её оставил.
    expect(await linkTo('operator_booking', await pastBooking(p1.tour, uid, 'Мария Петрова', '+79996664001'))).toBe(card);
    expect((await cardFull(card)).user_id).toBe(uid);
    // У другого партнёра — заявка «Андрей Петров» с его номером и его бронь:
    // заявку столбец к аккаунту не привязывает, и совпавшее имя этого не меняет.
    const p2 = await erasePartner('maxlead', uid);
    const lead = await leadFor(p2.partner, 'Андрей Петров', '+79996664002', 'andrey.max@example.com');
    const leadCard = await linkTo('lead', lead);
    expect(await linkTo('operator_booking', await pastBooking(p2.tour, uid, 'Андрей Петров', '+79996664002'))).toBe(leadCard);
    const leadBefore = await cardFull(leadCard);

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await erasedCard(card);
    expect(await cardFull(leadCard)).toEqual({ ...leadBefore, user_id: null });
    expect(await linksOf(leadCard)).toEqual([`lead:${lead}`]);
    expect(ok.json.crm).toEqual({ cards: 1, partners: 1 });
  });

  it('удаление: бронь жилья, заезд по которой наступил, — отказ ongoing_stay с исполнимым советом; до заезда — upcoming_stay, и гость правда может отменить (#2327, ревью седьмого круга)', async () => {
    // Ревью: совет «Отмените бронь жилья» давался и после заезда, а роут отмены
    // гостя такую бронь не отменяет (заезд позже сегодняшнего по Камчатке).
    const uid = await freshTourist('stay-ongoing');
    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, is_active, moderation_status)
       VALUES ($1, 'Гостевой дом заезда', 'guesthouse', '{"lat":53.0,"lng":158.6}', FALSE, 'approved') RETURNING id`,
      [operatorId],
    )).rows[0].id;
    const stay = (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date - 1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 5,
               6, 1, 3000, 18000, 'pending') RETURNING id`, [acc, uid],
    )).rows[0].id;
    const cancelAs = async () => {
      authAs.userId = uid;
      const { NextRequest } = await import('next/server');
      const { POST } = await import('@/app/api/stay/bookings/[id]/cancel/route');
      const res = await POST(new NextRequest(`http://localhost/api/stay/bookings/${stay}/cancel`, { method: 'POST' }) as unknown as NextRequest,
        { params: Promise.resolve({ id: stay }) });
      authAs.userId = userId;
      return res.status;
    };
    const during = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(during.status).toBe(409);
    expect(during.json.blockers).toEqual(['ongoing_stay']);
    expect(during.json.error).toContain('Дождитесь выезда');
    expect(during.json.error).toContain('напишите в поддержку');
    expect(during.json.error).not.toContain('Отмените бронь жилья');
    // Совет «отмените» тут и правда неисполним: роут отмены гостя её не отменяет.
    expect(await cancelAs()).toBe(422);
    // Заезд завтра по Камчатке — «отмените», и отмена гостя проходит.
    await pool.query(
      `UPDATE accommodation_bookings SET check_in_date = (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 1 WHERE id = $1`, [stay],
    );
    const before = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(before.json.blockers).toEqual(['upcoming_stay']);
    expect(before.json.error).toContain('Отмените бронь жилья или дождитесь выезда');
    expect(await cancelAs()).toBe(200);
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it('удаление: его бронь, аренда, заказ мест и бронь жилья, не привязанные к CRM, после удаления клиентом не становятся — ни хук, ни задел не заводят карточку со ссылкой на стёртый аккаунт (#2327, ревью седьмого круга)', async () => {
    // Ревью: хук отказал, задел ещё не прошёл — после удаления обезличенная
    // бронь оставалась годной для задела, и по ключу аккаунта (почта .invalid
    // не ключ, телефон стёрт) в CRM партнёра появлялась карточка с user_id
    // стёртого аккаунта.
    const { linkContactFromSource, UNLINKED_COUNT_SQL } = await import('@/lib/crm/contacts');
    const uid = await freshTourist('unlinked');
    const p = await erasePartner('unlinked', uid);
    const bk = await pastBooking(p.tour, uid, 'Андрей', '+79993330666');
    const item = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity, is_active, moderation_status)
       VALUES ($1, 'Палатка задела', 'tents', 500, 1, 1, FALSE, 'approved') RETURNING id`, [p.partner],
    )).rows[0].id;
    const rental = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, $2, 'Андрей', 'andrey-unlinked@example.com', '+79993330667', CURRENT_DATE - 9, CURRENT_DATE - 7, 1, 2, 1000, 1000, 'completed')
       RETURNING id`, [item, uid],
    )).rows[0].id;
    const vehicle = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Вахтовка задела', 20) RETURNING id`,
      [p.partner],
    )).rows[0].id;
    const trip = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, status)
       VALUES ($1, CURRENT_DATE - 5, 'Петропавловск', 'Мутновский', 20, 'completed') RETURNING id`, [vehicle],
    )).rows[0].id;
    const seat = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status, contact_phone)
       VALUES ($1, $2, 1, 'confirmed', '+79993330668') RETURNING id`, [trip, uid],
    )).rows[0].id;
    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, is_active, moderation_status)
       VALUES ($1, 'Гостевой дом задела', 'guesthouse', '{"lat":53.0,"lng":158.6}', FALSE, 'approved') RETURNING id`, [p.partner],
    )).rows[0].id;
    const stay = (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings (accommodation_id, user_id, check_in_date, check_out_date, nights, adults,
         room_price_per_night, total_price, status)
       VALUES ($1, $2, CURRENT_DATE - 9, CURRENT_DATE - 7, 2, 1, 3000, 6000, 'completed') RETURNING id`, [acc, uid],
    )).rows[0].id;
    const KINDS = ['operator_booking', 'gear_rental', 'transfer_seat_booking', 'accommodation_booking'] as const;
    const counts = async () => Promise.all(KINDS.map(async (k) => (await pool.query<{ n: number }>(UNLINKED_COUNT_SQL[k])).rows[0].n));
    const before = await counts();

    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // Задел их больше не видит — счёт непривязанных упал на каждую.
    expect(await counts()).toEqual(before.map((n) => n - 1));
    // Хук по ним не заводит карточку.
    for (const [kind, id] of [['operator_booking', bk], ['gear_rental', rental], ['transfer_seat_booking', seat],
      ['accommodation_booking', stay]] as const) {
      expect(await linkContactFromSource(kind, id), kind).toEqual({ outcome: 'no_source' });
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM crm_contacts WHERE user_id = $1 OR partner_id = $2`, [uid, p.partner])).rows)
      .toEqual([{ n: 0 }]);
  });

  it('удаление: владелец проката — позиция на витрине или незакрытая аренда держат (409), закрытая аренда — нет (#2327, четвёртый круг)', async () => {
    // Ревью: скрытая карточка без туров и окна чата, но с палаткой на
    // витрине — удаление проходило, и заявки на прокат с телефоном клиента
    // шли бы в мессенджер человека, который с платформой простился.
    const uid = await freshTourist('gear-owner');
    const partner = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, widget_enabled, slug, user_id, telegram_chat_id)
       VALUES ('Прокат-владелец', 'gear', '{}', TRUE, FALSE, FALSE, $2, $1, 5552002) RETURNING id`,
      [uid, `erase-gear-${uid.slice(0, 8)}`],
    )).rows[0].id;
    const item = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity, is_active, moderation_status)
       VALUES ($1, 'Палатка', 'tents', 500, 2, 2, TRUE, 'approved') RETURNING id`, [partner],
    )).rows[0].id;
    const onShelf = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(onShelf.status).toBe(409);
    expect(onShelf.json.blockers).toEqual(['partner_live_business']);
    // Отказ называет прокат и то, что его снимает, — а не только туры и жильё.
    expect(onShelf.json.error).toContain('прокат снаряжения на витрине');
    expect(onShelf.json.error).toContain('аренды закрыты');

    // Позиция снята с витрины, но аренда на будущие дни ещё не закрыта.
    await pool.query(`UPDATE gear_items SET is_active = FALSE WHERE id = $1`, [item]);
    const rental = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals (gear_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, 'Клиент проката', 'client@example.com', '+79993332211', CURRENT_DATE + 2, CURRENT_DATE + 4, 1, 2, 1000, 1000, 'pending')
       RETURNING id`, [item],
    )).rows[0].id;
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);
    // Срок прошёл, а снаряжение выдано и не возвращено — дело не закрыто,
    // помечена ли аренда просроченной или ещё нет.
    await pool.query(
      `UPDATE gear_rentals SET start_date = CURRENT_DATE - 6, end_date = CURRENT_DATE - 4, status = 'active' WHERE id = $1`, [rental],
    );
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);
    await pool.query(`UPDATE gear_rentals SET status = 'overdue' WHERE id = $1`, [rental]);
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);
    // Подтверждённая, но так и не выданная аренда с прошедшим сроком — не
    // дело: снаряжение у партнёра. Её не держит отказ — это видно по 200 ниже.
    await pool.query(
      `INSERT INTO gear_rentals (gear_id, customer_name, customer_email, customer_phone, start_date, end_date, quantity,
         days_count, base_price, total_price, status)
       VALUES ($1, 'Клиент давний', 'old@example.com', '+79993332212', CURRENT_DATE - 9, CURRENT_DATE - 7, 1, 2, 1000, 1000, 'confirmed')`,
      [item],
    );

    await pool.query(`UPDATE gear_rentals SET status = 'completed' WHERE id = $1`, [rental]);
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await pool.query(`SELECT telegram_chat_id::text AS chat FROM partners WHERE id = $1`, [partner])).rows)
      .toEqual([{ chat: '5552002' }]);
  });

  it('удаление: перевозчик с заказами мест в его машинах на будущую поездку — отказ (409); прошедшая поездка и отменённый заказ не держат (#2327, четвёртый круг)', async () => {
    // Заказчик ждёт машину, а напоминание о заказе с его именем идёт в
    // мессенджер перевозчика — то же живое дело, что предстоящая бронь тура.
    const uid = await freshTourist('carrier-owner');
    const partner = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, widget_enabled, slug, user_id, telegram_chat_id)
       VALUES ('Перевозчик-владелец', 'transfer', '{}', TRUE, FALSE, FALSE, $2, $1, 5552003) RETURNING id`,
      [uid, `erase-carrier-${uid.slice(0, 8)}`],
    )).rows[0].id;
    const vehicle = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Вахтовка владельца', 20) RETURNING id`,
      [partner],
    )).rows[0].id;
    const trip = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, status)
       VALUES ($1, CURRENT_DATE + 3, 'Петропавловск', 'Мутновский', 20, 'planned') RETURNING id`,
      [vehicle],
    )).rows[0].id;
    // Отменённый заказ на ту же поездку — не дело. Удалением не проверить:
    // прошедшее, оно стёрло бы аккаунт до следующих шагов; тот же SQL отказа.
    const { findEraseBlockers } = await import('@/lib/account/erase');
    await pool.query(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status) VALUES ($1, $2, 1, 'cancelled')`,
      [trip, otherUserId],
    );
    expect(await findEraseBlockers(pool, uid)).toEqual([]);
    const order = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status) VALUES ($1, $2, 2, 'requested') RETURNING id`,
      [trip, otherUserId],
    )).rows[0].id;
    const live = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(live.status).toBe(409);
    expect(live.json.blockers).toEqual(['partner_live_business']);
    expect(live.json.error).toContain('заказы мест в ваших машинах');
    await pool.query(`UPDATE transfer_seat_bookings SET status = 'confirmed' WHERE id = $1`, [order]);
    expect((await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' })).status).toBe(409);

    // Поездка состоялась.
    await pool.query(`UPDATE transfer_trips SET trip_date = CURRENT_DATE - 2, status = 'completed' WHERE id = $1`, [trip]);
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await pool.query(`SELECT telegram_chat_id::text AS chat FROM partners WHERE id = $1`, [partner])).rows)
      .toEqual([{ chat: '5552003' }]);
  });

  it('удаление: запросы мест, подключённые к его Telegram, — его: ждущий ответа и предстоящая бронь из запроса держат (409), прошедшие стираются вместе с бронью; чужие, MAX и без чата не тронуты (#2327, четвёртый круг)', async () => {
    // Ревью: запрос мест, к которому он привязал свой Telegram кнопкой
    // «Старт», хранил имя и телефон, а ответ говорил «найти их по вам
    // нельзя». Бронь, которую завёл такой запрос, лежит без user_id и без метки.
    const { randomBytes } = await import('node:crypto');
    const uid = await freshTourist('seat-req');
    const tg = Number((await pool.query<{ tg: string }>(`SELECT telegram_id::text AS tg FROM users WHERE id = $1`, [uid])).rows[0].tg);
    const request = async (o: { channel: string; chat: number | null; phone: string; status?: string; bookingId?: string }) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO tour_seat_requests (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone,
           reply_channel, tourist_chat_id, status_token_hash, status, booking_id, deadline_at, pd_consent_at, pd_consent_ip)
         VALUES ($1, $2, CURRENT_DATE + 5, 1, 'Иван из запроса', $3, $4, $5, $6, $7, $8, NOW() + interval '2 hours', NOW(), '203.0.113.7')
         RETURNING id`,
        [tourId, operatorId, o.phone, o.channel, o.chat, randomBytes(32).toString('hex'), o.status ?? 'pending', o.bookingId ?? null],
      )).rows[0].id;
    const mine = await request({ channel: 'telegram', chat: tg, phone: '+79994440001' });
    // Контроль: чужой Telegram, MAX с тем же числом, ответ по телефону.
    const foreign = await request({ channel: 'telegram', chat: tg + 1, phone: '+79994440002', status: 'expired' });
    const maxSame = await request({ channel: 'max', chat: tg, phone: '+79994440003', status: 'expired' });
    const byPhone = await request({ channel: 'phone', chat: null, phone: '+79994440004', status: 'expired' });
    // Граница: бронь, записанная на ДРУГОЙ аккаунт, не становится его, даже
    // если на неё ссылается запрос из его чата.
    const othersBooking = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone, booking_status)
       VALUES ($1, CURRENT_DATE - 30, 1, $2, 'Турист Б', '+79994440005', 'completed') RETURNING id`, [tourId, otherUserId],
    )).rows[0].id;
    await request({ channel: 'telegram', chat: tg, phone: '+79994440005', status: 'confirmed', bookingId: othersBooking });

    const waiting = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(waiting.status).toBe(409);
    expect(waiting.json.blockers).toEqual(['pending_seat_request']);

    // Оператор ответил «Есть места»: бронь заведена без userId и без метки
    // канала (answerSeatRequest → reserveBooking) — предстоящая держит.
    const bk = (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, user_id, tourist_name, tourist_phone,
         booking_status, created_via, metadata)
       VALUES ($1, CURRENT_DATE + 5, 1, NULL, 'Иван из запроса', '+79994440001', 'confirmed', 'seat_request', $2::jsonb) RETURNING id`,
      [tourId, JSON.stringify({ seat_request_id: mine })],
    )).rows[0].id;
    await pool.query(`UPDATE tour_seat_requests SET status = 'confirmed', booking_id = $2, answered_at = NOW() WHERE id = $1`, [mine, bk]);
    const upcoming = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(upcoming.status).toBe(409);
    expect(upcoming.json.blockers).toEqual(['upcoming_unlinked_booking']);

    // Поездка состоялась.
    await pool.query(`UPDATE operator_bookings SET booking_date = CURRENT_DATE - 3, booking_status = 'completed' WHERE id = $1`, [bk]);
    await pool.query(`UPDATE tour_seat_requests SET tour_date = CURRENT_DATE - 3 WHERE id = $1`, [mine]);
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    const req = async (id: string) => (await pool.query(
      `SELECT tourist_name, tourist_phone, tourist_chat_id::text AS chat, pd_consent_ip, status FROM tour_seat_requests WHERE id = $1`, [id],
    )).rows[0];
    expect(await req(mine)).toEqual({
      tourist_name: 'Удалённый пользователь', tourist_phone: '', chat: null, pd_consent_ip: null, status: 'confirmed',
    });
    expect((await pool.query(`SELECT user_id::text AS uid, tourist_name, tourist_phone FROM operator_bookings WHERE id = $1`, [bk])).rows)
      .toEqual([{ uid, tourist_name: 'Удалённый пользователь', tourist_phone: null }]);
    expect(await req(foreign)).toMatchObject({ tourist_name: 'Иван из запроса', tourist_phone: '+79994440002', chat: String(tg + 1) });
    expect(await req(maxSame)).toMatchObject({ tourist_name: 'Иван из запроса', tourist_phone: '+79994440003', chat: String(tg) });
    expect(await req(byPhone)).toMatchObject({ tourist_name: 'Иван из запроса', tourist_phone: '+79994440004' });
    expect((await pool.query(`SELECT user_id::text AS uid, tourist_name, tourist_phone FROM operator_bookings WHERE id = $1`, [othersBooking])).rows)
      .toEqual([{ uid: otherUserId, tourist_name: 'Турист Б', tourist_phone: '+79994440005' }]);
    expect(ok.json.message).toContain('Запросы мест в туре, оставленные без входа в аккаунт и не подключённые к вашему Telegram');
  });

  it('удаление: заказ мест в машине на будущую поездку блокирует (409), прошедшая поездка — телефон стирается', async () => {
    const uid = await freshTourist('seat');
    const vehicle = await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Вахтовка', 20) RETURNING id`,
      [operatorId],
    );
    const trip = await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, status)
       VALUES ($1, CURRENT_DATE + 5, 'Петропавловск', 'Мутновский', 20, 'planned') RETURNING id`,
      [vehicle.rows[0].id],
    );
    const seat = await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, status, contact_phone)
       VALUES ($1, $2, 2, 'requested', '+79991112233') RETURNING id`,
      [trip.rows[0].id, uid],
    );
    // Запрос без ответа перевозчик может отклонить — совет про это.
    const blocked = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(blocked.status).toBe(409);
    expect(blocked.json.blockers).toEqual(['requested_transfer_seat']);
    expect(blocked.json.error).toContain('попросите перевозчика отклонить запрос');
    expect((await pool.query(`SELECT contact_phone FROM transfer_seat_bookings WHERE id = $1`, [seat.rows[0].id])).rows)
      .toEqual([{ contact_phone: '+79991112233' }]);
    // Подтверждённый не отменяет никто (declineSeats берёт только requested):
    // совет «попросите отменить» был бы неисполним (ревью круга 10, пункт 4).
    const { declineSeats } = await import('@/lib/transfers/service');
    await pool.query(`UPDATE transfer_seat_bookings SET status = 'confirmed' WHERE id = $1`, [seat.rows[0].id]);
    const declined = await declineSeats({ bookingId: seat.rows[0].id, partnerId: operatorId, reason: 'проверка: отказ по подтверждённому' });
    expect(declined.ok).toBe(false);
    const confirmed = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(confirmed.status).toBe(409);
    expect(confirmed.json.blockers).toEqual(['upcoming_transfer_seat']);
    expect(confirmed.json.error).toContain('дождитесь даты поездки');
    expect(confirmed.json.error).not.toMatch(/попросите перевозчика (отменить|отклонить)/i);

    // Перевозчик отменил поездку — живого дела больше нет.
    await pool.query(`UPDATE transfer_trips SET status = 'cancelled' WHERE id = $1`, [trip.rows[0].id]);
    const ok = await callDelete(uid, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await pool.query(`SELECT contact_phone FROM transfer_seat_bookings WHERE id = $1`, [seat.rows[0].id])).rows)
      .toEqual([{ contact_phone: null }]);
  });

  it('ответ на удаление: ничего не осталось — «стёрты»; осталось — названо, и каждый счёт выполнился на настоящей базе', async () => {
    // Счёт оставшегося идёт в той же транзакции после стирания; упавший счёт
    // дал бы «не удалось проверить» (unchecked) — здесь его быть не должно:
    // это доказывает, что SQL каждой записи ERASE_KEEP выполняется.
    const clean = await freshTourist('clean');
    const r1 = await callDelete(clean, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(r1.status).toBe(200);
    expect(r1.json.unchecked).toEqual([]);
    expect(r1.json.kept).toEqual([]);
    expect(r1.json.message).toMatch(/^Аккаунт удалён, персональные данные стёрты\./);

    const reporter = await freshTourist('reporter');
    await pool.query(
      `INSERT INTO place_safety_reports (place_id, user_id, is_ok, note) VALUES ('p-erase', $1, FALSE, 'мост через ручей смыло')`,
      [reporter],
    );
    const r2 = await callDelete(reporter, { confirm: true, phrase: 'УДАЛИТЬ' });
    expect(r2.status).toBe(200);
    expect(r2.json.unchecked).toEqual([]);
    expect(r2.json.kept).toEqual([{ category: 'ваши наблюдения о состоянии мест', why: expect.any(String), count: 1 }]);
    expect(r2.json.message).not.toContain('персональные данные стёрты');
    expect(r2.json.message).toContain('Осталось: ваши наблюдения о состоянии мест');
  });

  it('перепись ПД по файлам схемы совпадает с настоящей базой (сторож account-erase-coverage не слеп)', async () => {
    // Юнит-сторож полноты судит по разбору baseline и миграций. Разбор,
    // потерявший таблицу или ключ, сделал бы его зелёным впустую — поэтому
    // та же перепись снимается с information_schema базы, собранной из тех
    // же файлов, и обязана совпасть до колонки.
    const { personDataCensus, recordEraseSteps, schemaFromDatabase, schemaFromRepo } = await import('../helpers/pd-census');
    const erased = new Set((await recordEraseSteps()).map((s) => s.table));
    const asObject = (m: Map<string, unknown>) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));
    const live = asObject(personDataCensus(await schemaFromDatabase(pool), erased));
    const files = asObject(personDataCensus(schemaFromRepo(), erased));
    expect(Object.keys(live).length).toBeGreaterThan(10);
    expect(files).toEqual(live);
  });

  it('экстренный контакт из tourist_profiles читается профилем (его подставляет «Контрольный срок»)', async () => {
    const uid = await freshTourist('emergency');
    await pool.query(
      `INSERT INTO tourist_profiles (user_id, full_name, emergency_contact_name, emergency_contact_phone, emergency_contact_relation)
       VALUES ($1, 'Иван', 'Мама', '+79990001122', 'мать')`, [uid],
    );
    const { getTouristProfile } = await import('@/lib/auth/tourist-helpers');
    const pr = await getTouristProfile(uid);
    expect(pr).toMatchObject({ emergency_contact_name: 'Мама', emergency_contact_phone: '+79990001122', emergency_contact_relation: 'мать' });
  });
});
