/**
 * Общая вставка брони и общий гейт — на настоящем PostgreSQL (аудит 15.10,
 * находка P2-01).
 *
 * Мок отвечает на любой SQL, а у этой правки два вопроса, на которые отвечает
 * только сервер:
 *   1. выполняется ли вставка, список колонок которой строится из того, что
 *      передала дверь, — у каждой из трёх дверей свой набор (бронь туриста с
 *      jsonb и согласием, холд OCTO, ручная бронь с лидом);
 *   2. видят ли вид занятости и гейт многодневную бронь ВСЕМИ её днями.
 *
 * Сцена: схема baseline прода плюс все миграции, тур на три дня с
 * вместимостью 4. Холд OCTO на двоих 01.08 занимает 01–03.08 — тогда бронь
 * на троих 03.08 (третий день холда) гейт обязан отклонить, а на двоих —
 * пропустить. До 15.10 холд писался однодневным, и 02–03.08 были «свободны».
 *
 * Вторая дверь в этом файле — заявка на аренду снаряжения (аудит 15.10,
 * находка A13): пик занятости и вставка под одной блокировкой, заявка без
 * ответа держит единицу 48 часов, не больше трёх открытых заявок у человека,
 * согласие «прокату» в той же строке. Мок судит порядок вызовов, а 48 часов,
 * приведения типов и настоящую гонку двух соединений — только сервер.
 *
 * Третья — перенос брони оператором (аудит 15.10, RESCHEDULE-GATE): места
 * судит тот же гейт, что новую бронь (словарные статусы, интервал дней,
 * календарь), без самой переносимой брони, а строка получает `end_date` и
 * `duration_days` целевого тура — иначе многодневная бронь после переноса не
 * держит своих дней.
 *
 * Своя база `booking_writers_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

// Уведомления реселлеров по вебхукам — наружу; здесь проверяется запись.
vi.mock('@/lib/octo/webhooks', () => ({ notifyOctoWebhooks: vi.fn(async () => undefined) }));
// Уведомление о заявке на аренду — тоже наружу (MAX/Telegram).
vi.mock('@/lib/notifications/gear-rental', () => ({ notifyNewGearRental: vi.fn(async () => undefined) }));
// Кто вошёл — заголовок теста: дверь проката под входом, и подпись JWT здесь не
// предмет проверки. Остальной модуль — настоящий.
vi.mock('@/lib/auth/middleware', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/middleware')>();
  const { NextResponse } = await import('next/server');
  const requireAuth = async (req: Request) => {
    const user = req.headers.get('x-test-user');
    if (!user) return NextResponse.json({ success: false, error: 'Требуется аутентификация' }, { status: 401 });
    return { userId: user, email: `${user}@test.local`, role: req.headers.get('x-test-role') ?? 'tourist' };
  };
  // Кабинет оператора (статистика) входит тем же заголовком теста.
  return { ...real, requireAuth, requireOperator: requireAuth };
});
// Роут переноса брони входит через verifyAuth — тем же заголовком теста.
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...real,
    verifyAuth: async (req: Request) => {
      const user = req.headers.get('x-test-user');
      return user
        ? { userId: user, role: req.headers.get('x-test-role'), email: `${user}@test.local`, isAuthenticated: true }
        : { userId: null, role: null, email: null, isAuthenticated: false };
    },
  };
});

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[booking-writers.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'booking_writers_test';

withPg('общая вставка и гейт брони на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let tourId = '';
  let operatorId = '';
  let octoKeyId = '';
  let optionId = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

    // OCTO-сервис ходит пулом приложения — ему нужен тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    const partner = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Оператор', 'operator', '{}', TRUE, TRUE, 'op-writers') RETURNING id`,
    );
    operatorId = partner.rows[0]!.id;
    const tour = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, multi_day_count,
                                   is_active, is_published, activity_type, difficulty)
       VALUES ($1, 'Толбачик, три дня', 30000, 4, 3, TRUE, TRUE, 'hiking', 'medium') RETURNING id::text AS id`,
      [operatorId],
    );
    tourId = tour.rows[0]!.id;
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  const DURATION = { multi_day_count: 3, duration_hours: null };

  it('холд OCTO: вставка выполняется, многодневный холд занимает все три дня', async () => {
    const { insertBookingRow } = await import('@/lib/bookings/reserve');
    // Холд ссылается на ключ реселлера внешним ключом — без строки ключа его не вставить.
    const key = await pool.query<{ id: string }>(
      `INSERT INTO octo_api_keys (name, api_key) VALUES ('реселлер', 'key-writers') RETURNING id::text AS id`,
    );
    octoKeyId = key.rows[0]!.id;
    const option = await pool.query<{ id: string }>(
      `INSERT INTO tour_options (operator_tour_id, internal_name, is_default, price_adult)
       VALUES ($1, 'Основной', TRUE, 30000) RETURNING id::text AS id`,
      [tourId],
    );
    optionId = option.rows[0]!.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await insertBookingRow(client, {
        operator_tour_id: tourId,
        booking_date: '2026-08-01',
        participants: 2,
        adult_count: 2,
        child_count: 0,
        base_total_price: 60000,
        final_price: 60000,
        booking_status: 'new',
        tourist_name: 'Реселлер',
        tourist_email: null,
        tourist_phone: null,
        special_requests: null,
        octo_api_key_id: key.rows[0]!.id,
        option_id: option.rows[0]!.id,
        hold_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        availability_id: 'avail-2026-08-01',
        reseller_reference: 'ref-1',
        created_via: 'api',
      }, DURATION);
      await client.query('COMMIT');

      expect(row.end_date).toBe('2026-08-03');
      expect(row.duration_days).toBe(3);
      expect(row.octo_uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.booking_date).toBe('2026-08-01');
    } finally {
      client.release();
    }

    // Вид занятости (миграция 140) разворачивает холд во все три дня — до
    // 15.10 он видел только день выезда.
    const occ = await pool.query<{ date: string; occupied: string }>(
      `SELECT date::text AS date, occupied::text AS occupied
         FROM v_tour_daily_occupancy WHERE operator_tour_id = $1 ORDER BY date`,
      [tourId],
    );
    expect(occ.rows).toEqual([
      { date: '2026-08-01', occupied: '2' },
      { date: '2026-08-02', occupied: '2' },
      { date: '2026-08-03', occupied: '2' },
    ]);
  });

  it('гейт: третий день холда занят — на троих отказ, на двоих можно', async () => {
    const { readTourDays, assertDaysOpen, ReserveError } = await import('@/lib/bookings/reserve');
    const client = await pool.connect();
    try {
      const days = await readTourDays(client, tourId, '2026-08-03', '2026-08-05');
      expect(days.map((d) => Number(d.occupied))).toEqual([2, 0, 0]);
      expect(() => assertDaysOpen(days, { participants: 3, maxParticipants: 4, durationDays: 3 }))
        .toThrow(ReserveError);
      expect(() => assertDaysOpen(days, { participants: 2, maxParticipants: 4, durationDays: 3 }))
        .not.toThrow();
    } finally {
      client.release();
    }
  });

  it('бронь туриста: jsonb-метка и согласие — одной вставкой', async () => {
    const { insertBookingRow } = await import('@/lib/bookings/reserve');
    const at = new Date('2026-10-15T08:00:00Z');
    const client = await pool.connect();
    try {
      const row = await insertBookingRow(client, {
        operator_tour_id: tourId,
        tourist_name: 'Иван',
        tourist_email: null,
        tourist_phone: '+79990000000',
        participants: 1,
        booking_date: '2026-09-10',
        special_requests: '',
        booking_status: 'new',
        base_total_price: 30000,
        final_price: 30000,
        discount_percent: null,
        discount_reason: null,
        created_via: 'website',
        user_id: null,
        metadata: JSON.stringify({ tg_chat_id: 555 }),
        pd_consent_at: at,
        pd_consent_ip: '203.0.113.7',
        pd_consent_source: 'web-form',
        pd_consent_version: 'v1',
        referral_link_id: null,
        agent_user_id: null,
      }, DURATION);
      const back = await client.query<{ tg: string; consent: string; end_date: string; status: string }>(
        `SELECT metadata->>'tg_chat_id' AS tg, pd_consent_at::text AS consent,
                end_date::text AS end_date, booking_status AS status
           FROM operator_bookings WHERE id = $1`,
        [row.id],
      );
      expect(back.rows[0]).toMatchObject({ tg: '555', end_date: '2026-09-12', status: 'new' });
      expect(back.rows[0]!.consent).not.toBeNull();
      expect(row.access_token).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      client.release();
    }
  });

  it('ручная бронь из лида: lead_id ::uuid, «оплачено» и «подтверждено» — как записал оператор', async () => {
    const { insertBookingRow } = await import('@/lib/bookings/reserve');
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status) VALUES ('Анна', '+79990001122', 'звонок', 'new')
       RETURNING id::text AS id`,
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await insertBookingRow(client, {
        operator_tour_id: Number(tourId),
        tourist_name: 'Анна',
        tourist_phone: '+79990001122',
        tourist_email: null,
        booking_date: '2026-09-20',
        participants: 2,
        adult_count: null,
        child_count: null,
        base_total_price: 60000,
        final_price: 55000,
        payment_status: 'paid',
        payment_method: 'cash',
        booking_status: 'confirmed',
        special_requests: null,
        created_via: 'direct_contact',
        lead_id: lead.rows[0]!.id,
      }, DURATION);
      await client.query(
        `UPDATE leads SET status = 'converted', operator_id = COALESCE(operator_id, $2::uuid), updated_at = NOW()
          WHERE id = $1::uuid`,
        [lead.rows[0]!.id, operatorId],
      );
      await client.query('COMMIT');

      expect(row).toMatchObject({ booking_date: '2026-09-20', end_date: '2026-09-22', duration_days: 3, booking_status: 'confirmed' });
      const back = await pool.query<{ lead_id: string; payment_status: string; lead_status: string }>(
        `SELECT b.lead_id::text AS lead_id, b.payment_status, l.status AS lead_status
           FROM operator_bookings b JOIN leads l ON l.id = b.lead_id WHERE b.id = $1`,
        [row.id],
      );
      expect(back.rows[0]).toEqual({ lead_id: lead.rows[0]!.id, payment_status: 'paid', lead_status: 'converted' });
    } finally {
      client.release();
    }
  });

  it('OCTO createBooking целиком: третий день чужого холда занят, следующие дни — холд на все три', async () => {
    const { createBooking } = await import('@/lib/octo/service');
    const base = { tourId, optionId, childCount: 0, apiKeyId: octoKeyId };

    // 03.08 — третий день холда на двоих; вместимость 4, просят троих.
    const refused = await createBooking({ ...base, availabilityId: 'avail-2026-08-03', bookingDate: '2026-08-03', adultCount: 3 });
    expect(refused).toEqual({ error: 'AVAILABILITY_SOLD_OUT' });

    const held = await createBooking({ ...base, availabilityId: 'avail-2026-08-04', bookingDate: '2026-08-04', adultCount: 2 });
    expect('booking' in held && held.booking.octo_uuid).toBeTruthy();
    const back = await pool.query<{ end_date: string; duration_days: number; logs: string }>(
      `SELECT b.end_date::text AS end_date, b.duration_days,
              (SELECT COUNT(*)::text FROM octo_booking_log l WHERE l.booking_id = b.id) AS logs
         FROM operator_bookings b WHERE b.availability_id = 'avail-2026-08-04'`,
    );
    expect(back.rows).toEqual([{ end_date: '2026-08-06', duration_days: 3, logs: '1' }]);
  });

  describe('дверь проката (аудит 15.10, A13)', () => {
    const users: Record<string, string> = {};
    let partnerUser = '';
    let gearPartner = '';

    async function addUser(key: string, role = 'tourist'): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id::text AS id`,
        [`${key}@gear.test`, key, role],
      );
      return r.rows[0]!.id;
    }

    async function addGear(name: string, quantity: number): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO gear_items (partner_id, name, category, price_per_day, quantity, available_quantity,
                                 is_active, moderation_status)
         VALUES ($1, $2, 'tent', 500, $3, $3, TRUE, 'approved') RETURNING id::text AS id`,
        [gearPartner, name, quantity],
      );
      return r.rows[0]!.id;
    }

    /** Заявка, записанная прямо в базу: чужая или старая — с нужным возрастом. */
    async function seedRental(gearId: string, userId: string | null, ageHours: number,
                              start = '2099-08-01', end = '2099-08-04', status = 'pending'): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO gear_rentals (gear_id, user_id, customer_name, customer_email, customer_phone,
                                   start_date, end_date, quantity, days_count, base_price, total_price,
                                   status, created_at)
         VALUES ($1, $2, 'Сосед', 's@x.ru', '+79990000000', $3, $4, 1, 3, 1500, 1500, $5,
                 NOW() - make_interval(hours => $6::int))
         RETURNING id::text AS id`,
        [gearId, userId, start, end, status, ageHours],
      );
      return r.rows[0]!.id;
    }

    async function rent(user: string, gearId: string, start = '2099-08-01', end = '2099-08-04') {
      const { POST } = await import('@/app/api/gear/rentals/route');
      return POST(new Request('http://l/api/gear/rentals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': user },
        body: JSON.stringify({
          gearId,
          customer: { name: 'Иван Петров', email: 'ivan@x.ru', phone: '+79990001122' },
          rental: { startDate: start, endDate: end, quantity: 1 },
          pd_consent: true,
        }),
      }) as unknown as import('next/server').NextRequest);
    }

    beforeAll(async () => {
      for (const k of ['ana', 'boris', 'vera', 'gleb', 'dina']) users[k] = await addUser(`gear-${k}`);
      partnerUser = await addUser('gear-owner', 'gear');
      const p = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, user_id)
         VALUES ('Прокат', 'gear', '{}', TRUE, TRUE, 'gear-writers', $1) RETURNING id::text AS id`,
        [partnerUser],
      );
      gearPartner = p.rows[0]!.id;
    });

    it('две одновременные заявки на последнюю единицу: одна проходит, вторая — 409', async () => {
      const gearId = await addGear('Последняя палатка', 1);
      const [a, b] = await Promise.all([rent(users.ana!, gearId), rent(users.boris!, gearId)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const rows = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM gear_rentals WHERE gear_id = $1`, [gearId],
      );
      expect(rows.rows[0]!.n).toBe(1);
    });

    it('строка знает человека и согласие «прокату» — одной вставкой', async () => {
      const gearId = await addGear('Горелка', 2);
      const res = await rent(users.vera!, gearId);
      expect(res.status).toBe(200);
      const id = (await res.json()).data.rentalId as string;
      const row = await pool.query(
        `SELECT user_id::text AS user_id, pd_consent_at IS NOT NULL AS has_at, pd_consent_ip,
                pd_consent_source, pd_consent_version
           FROM gear_rentals WHERE id = $1`, [id],
      );
      expect(row.rows[0]).toMatchObject({
        user_id: users.vera, has_at: true, pd_consent_source: 'gear-page', pd_consent_version: '2026-10-15-gear',
      });
      expect(String(row.rows[0]!.pd_consent_ip).length).toBeGreaterThan(0);
    });

    it('заявка без ответа держит единицу 48 часов: моложе — занято, старше — свободно', async () => {
      const fresh = await addGear('Спальник (свежая заявка)', 1);
      await seedRental(fresh, null, 47);
      expect((await rent(users.gleb!, fresh)).status).toBe(409);

      const stale = await addGear('Спальник (заявка старше срока)', 1);
      await seedRental(stale, null, 49);
      expect((await rent(users.gleb!, stale)).status).toBe(200);

      // Подтверждённая держит всегда, сколько бы ей ни было.
      const kept = await addGear('Спальник (подтверждён давно)', 1);
      await seedRental(kept, null, 500, '2099-08-01', '2099-08-04', 'confirmed');
      expect((await rent(users.gleb!, kept)).status).toBe(409);
    });

    it('каталог по датам судит той же формулой: старше срока — позиция видна, свежая заявка и подтверждённая — нет', async () => {
      const free = await addGear('Коврик (заявка старше срока)', 1);
      await seedRental(free, null, 49);
      const { findAvailableGear } = await import('@/lib/auth/gear-helpers');
      const listed = await findAvailableGear(undefined, '2099-08-01', '2099-08-04');
      const names = listed.map((g) => String(g.name));
      // Положительная улика первой: каталог глотает отказ базы в [] — без неё
      // «не видно» прошло бы и на упавшем запросе.
      expect(names).toContain('Коврик (заявка старше срока)');
      expect(names).not.toContain('Спальник (свежая заявка)');
      expect(names).not.toContain('Спальник (подтверждён давно)');
    });

    it('потолок: три открытые заявки — 429; заявка старше 48 часов не считается', async () => {
      const big = await addGear('Палатки оптом', 20);
      await seedRental(big, users.dina!, 1, '2099-09-01', '2099-09-02');
      await seedRental(big, users.dina!, 2, '2099-09-03', '2099-09-04');
      await seedRental(big, users.dina!, 49, '2099-09-05', '2099-09-06');
      expect((await rent(users.dina!, big)).status).toBe(200);
      const fourth = await rent(users.dina!, big, '2099-10-01', '2099-10-02');
      expect(fourth.status).toBe(429);
      const n = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM gear_rentals WHERE user_id = $1`, [users.dina],
      );
      expect(n.rows[0]!.n).toBe(4);
    });

    it('подтверждение заявки старше срока при занятой единице — 409, статус прежний', async () => {
      const gearId = await addGear('Котелок', 1);
      const old = await seedRental(gearId, null, 60);
      // За 60 часов единицу взяли и подтвердили.
      await seedRental(gearId, null, 1, '2099-08-02', '2099-08-05', 'confirmed');
      const { PATCH } = await import('@/app/api/gear/rentals/[id]/route');
      const res = await PATCH(new Request(`http://l/api/gear/rentals/${old}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-user': partnerUser, 'x-test-role': 'gear' },
        body: JSON.stringify({ status: 'confirmed' }),
      }) as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: old }) });
      expect(res.status).toBe(409);
      const st = await pool.query<{ status: string }>(`SELECT status FROM gear_rentals WHERE id = $1`, [old]);
      expect(st.rows[0]!.status).toBe('pending');
    });
  });

  describe('перенос брони — общий гейт и дни целевого тура (аудит 15.10, RESCHEDULE-GATE)', () => {
    let adminId = '';
    let dayTour = '';    // однодневный, вместимость 4
    let threeDay = '';   // три дня, вместимость 4

    async function addTour(title: string, multiDay: number | null): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, multi_day_count,
                                     is_active, is_published, activity_type, difficulty)
         VALUES ($1, $2, 10000, 4, $3, TRUE, TRUE, 'hiking', 'medium') RETURNING id::text AS id`,
        [operatorId, title, multiDay],
      );
      return r.rows[0]!.id;
    }

    /** Бронь прямо в базу: чужая занятость — с тем статусом и днями, что нужны сцене. */
    async function seed(tour: string, start: string, end: string, people: number, status: string): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, end_date, duration_days,
                                        participants, booking_status)
         VALUES ($1::bigint, $2::date, $3::date, ($3::date - $2::date) + 1, $4, $5)
         RETURNING id::text AS id`,
        [tour, start, end, people, status],
      );
      return r.rows[0]!.id;
    }

    async function move(id: string, tour: string, date: string) {
      const { rescheduleBooking } = await import('@/lib/bookings/booking.service');
      return rescheduleBooking(id, adminId, 'admin', { targetTourId: tour, targetDate: date });
    }

    async function rowOf(id: string) {
      const r = await pool.query<{ tour: string; start: string; end: string; days: number }>(
        `SELECT operator_tour_id::text AS tour, booking_date::text AS start,
                end_date::text AS end, duration_days AS days
           FROM operator_bookings WHERE id = $1::bigint`,
        [id],
      );
      return r.rows[0]!;
    }

    async function occupied(tour: string, start: string, end: string): Promise<number[]> {
      const { readTourDays } = await import('@/lib/bookings/reserve');
      const client = await pool.connect();
      try {
        return (await readTourDays(client, tour, start, end)).map((d) => Number(d.occupied));
      } finally {
        client.release();
      }
    }

    beforeAll(async () => {
      const u = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role)
         VALUES ('resched-admin@test.local', 'Админ', 'x', 'admin') RETURNING id::text AS id`,
      );
      adminId = u.rows[0]!.id;
      dayTour = await addTour('Мутновский, день', null);
      threeDay = await addTour('Ключевская группа, три дня', 3);
    });

    it('(а) дата занята бронью «new» до потолка — перенос другой брони на неё отклонён', async () => {
      const { ReserveError } = await import('@/lib/bookings/reserve');
      // С `new` рождается каждая бронь туриста; прежний счёт переноса видел
      // только `('pending','confirmed')` и считал эту дату пустой.
      await seed(dayTour, '2026-11-10', '2026-11-10', 4, 'new');
      const other = await seed(dayTour, '2026-11-11', '2026-11-11', 2, 'new');

      await expect(move(other, dayTour, '2026-11-10')).rejects.toBeInstanceOf(ReserveError);
      // Оператор видит отказ гейта словами и кодом 409, а не «ошибку сервера».
      const { PATCH } = await import('@/app/api/bookings/[id]/reschedule/route');
      const res = await PATCH(new Request(`http://l/api/bookings/${other}/reschedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-user': adminId, 'x-test-role': 'admin' },
        body: JSON.stringify({ targetTourId: dayTour, targetDate: '2026-11-10' }),
      }) as unknown as import('next/server').NextRequest, { params: Promise.resolve({ id: other }) });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('Нет свободных мест на эту дату.');
      expect(await rowOf(other)).toMatchObject({ start: '2026-11-11', end: '2026-11-11' });
    });

    it('(б) чужая многодневная бронь накрывает дату серединой или дни 2..N — отклонён', async () => {
      const { ReserveError } = await import('@/lib/bookings/reserve');
      await seed(threeDay, '2026-11-20', '2026-11-22', 3, 'confirmed');
      const other = await seed(threeDay, '2026-12-01', '2026-12-03', 2, 'new');

      // 21.11 — середина чужих 20–22.11: равенство booking_date её не видело.
      await expect(move(other, threeDay, '2026-11-21')).rejects.toBeInstanceOf(ReserveError);
      // 19.11 свободно, но дни 2–3 (20–21.11) заняты: их прежний счёт не проверял.
      await expect(move(other, threeDay, '2026-11-19')).rejects.toBeInstanceOf(ReserveError);
      expect(await rowOf(other)).toMatchObject({ start: '2026-12-01', end: '2026-12-03' });
    });

    it('(в) перенос многодневной брони позже: end_date и duration_days переписаны, новые дни заняты, старые свободны', async () => {
      const id = await seed(threeDay, '2026-12-10', '2026-12-12', 2, 'new');
      await move(id, threeDay, '2026-12-20');

      expect(await rowOf(id)).toEqual({ tour: threeDay, start: '2026-12-20', end: '2026-12-22', days: 3 });
      expect(await occupied(threeDay, '2026-12-20', '2026-12-22')).toEqual([2, 2, 2]);
      expect(await occupied(threeDay, '2026-12-10', '2026-12-12')).toEqual([0, 0, 0]);
      // Вид занятости (кабинет, планер, цена) видит те же три дня.
      const occ = await pool.query<{ date: string; occupied: string }>(
        `SELECT date::text AS date, occupied::text AS occupied FROM v_tour_daily_occupancy
          WHERE operator_tour_id = $1::bigint AND date BETWEEN '2026-12-10' AND '2026-12-31' ORDER BY date`,
        [threeDay],
      );
      expect(occ.rows).toEqual([
        { date: '2026-12-20', occupied: '2' },
        { date: '2026-12-21', occupied: '2' },
        { date: '2026-12-22', occupied: '2' },
      ]);

      // На тур другой длительности: однодневная бронь на трёхдневный тур — три дня.
      const single = await seed(dayTour, '2026-12-05', '2026-12-05', 1, 'confirmed');
      await move(single, threeDay, '2027-02-01');
      expect(await rowOf(single)).toEqual({ tour: threeDay, start: '2027-02-01', end: '2027-02-03', days: 3 });
    });

    it('(г) дата закрыта оператором в календаре — перенос отклонён', async () => {
      const { ReserveError } = await import('@/lib/bookings/reserve');
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
         VALUES ($1::bigint, '2026-11-15', 4, TRUE)`,
        [dayTour],
      );
      const id = await seed(dayTour, '2026-11-16', '2026-11-16', 1, 'new');
      const refused = await move(id, dayTour, '2026-11-15').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ReserveError);
      expect((refused as InstanceType<typeof ReserveError>).code).toBe('DATE_BLOCKED');
      expect(await rowOf(id)).toMatchObject({ start: '2026-11-16' });
    });

    it('(д) перенос не считает саму переносимую бронь занятостью', async () => {
      // Полная группа на её же дату и тур — не отказ из-за себя.
      const full = await seed(dayTour, '2026-11-25', '2026-11-25', 4, 'confirmed');
      await expect(move(full, dayTour, '2026-11-25')).resolves.toMatchObject({ id: full });

      // Трёхдневная полная группа на день позже: новые дни 2–3 — её же старые.
      const group = await seed(threeDay, '2027-01-10', '2027-01-12', 4, 'confirmed');
      await move(group, threeDay, '2027-01-11');
      expect(await rowOf(group)).toMatchObject({ start: '2027-01-11', end: '2027-01-13', days: 3 });
      expect(await occupied(threeDay, '2027-01-10', '2027-01-13')).toEqual([0, 4, 4, 4]);
    });

    it('статистика оператора: «ждут подтверждения» — брони «new», а не несуществующее «pending»', async () => {
      const owner = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role)
         VALUES ('stats-owner@test.local', 'Владелец', 'x', 'operator') RETURNING id::text AS id`,
      );
      const ownerId = owner.rows[0]!.id;
      const p = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, user_id)
         VALUES ('Свой кабинет', 'operator', '{}', TRUE, TRUE, 'op-stats', $1) RETURNING id::text AS id`,
        [ownerId],
      );
      const t = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published,
                                     activity_type, difficulty)
         VALUES ($1, 'Халактырский пляж', 5000, 10, TRUE, TRUE, 'hiking', 'easy') RETURNING id::text AS id`,
        [p.rows[0]!.id],
      );
      const tour = t.rows[0]!.id;
      await seed(tour, '2026-11-01', '2026-11-01', 1, 'new');
      await seed(tour, '2026-11-02', '2026-11-02', 1, 'new');
      await seed(tour, '2026-11-03', '2026-11-03', 1, 'confirmed');

      const { GET } = await import('@/app/api/operator/stats/route');
      const res = await GET(new Request('http://l/api/operator/stats', {
        headers: { 'x-test-user': ownerId, 'x-test-role': 'operator' },
      }) as unknown as import('next/server').NextRequest);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.bookings).toMatchObject({ total: 3, pending: 2, confirmed: 1 });
    });
  });

  // Аудит 15.10, BOOKING-CHECK (миграция operator_bookings_status_check): CHECK на booking_status по
  // единому словарю. Юнит-сторож сверяет множество значений с BOOKING_STATUSES
  // разбором миграции; здесь — что сервер на самом деле пускает и отклоняет,
  // и что повтор миграции (раннер на каждом выкате) не падает.
  describe('словарь статусов брони — CHECK в базе (аудит 15.10, BOOKING-CHECK)', () => {
    const CONSTRAINT = 'operator_bookings_booking_status_check';

    async function insertWithStatus(status: string): Promise<string> {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status)
         VALUES ($1::bigint, '2099-12-01', 1, $2) RETURNING id::text AS id`,
        [tourId, status],
      );
      return r.rows[0]!.id;
    }

    async function sqlstateOf(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string } | null> {
      try {
        await run();
        return null;
      } catch (e) {
        return e as { code?: string; constraint?: string };
      }
    }

    it('ограничение стоит и проверено (VALIDATE прошёл, а не осталось NOT VALID)', async () => {
      const r = await pool.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint
          WHERE conrelid = 'operator_bookings'::regclass AND conname = $1`,
        [CONSTRAINT],
      );
      expect(r.rows).toEqual([{ convalidated: true }]);
    });

    it('каждое слово словаря проходит и вставкой, и сменой статуса', async () => {
      const { BOOKING_STATUSES } = await import('@/lib/types/statuses');
      const id = await insertWithStatus('new');
      for (const status of BOOKING_STATUSES) {
        expect(await sqlstateOf(() => insertWithStatus(status)), `вставка ${status}`).toBeNull();
        expect(await sqlstateOf(() => pool.query(
          `UPDATE operator_bookings SET booking_status = $2 WHERE id = $1::bigint`, [id, status],
        )), `смена на ${status}`).toBeNull();
      }
    });

    it.each(['rejected', 'pending', 'paid', 'Confirmed', ''])('слово вне словаря «%s» — 23514 и вставкой, и сменой', async (status) => {
      const ins = await sqlstateOf(() => insertWithStatus(status));
      expect(ins).toMatchObject({ code: '23514', constraint: CONSTRAINT });
      const id = await insertWithStatus('new');
      const upd = await sqlstateOf(() => pool.query(
        `UPDATE operator_bookings SET booking_status = $2 WHERE id = $1::bigint`, [id, status],
      ));
      expect(upd).toMatchObject({ code: '23514', constraint: CONSTRAINT });
      const left = await pool.query<{ booking_status: string }>(
        `SELECT booking_status FROM operator_bookings WHERE id = $1::bigint`, [id],
      );
      expect(left.rows[0]!.booking_status).toBe('new');
    });

    it('повтор миграции (раннер на каждом выкате) — без ошибки, ограничение одно', async () => {
      const { readFileSync, readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      // По имени, а не по номеру: номер миграции назначается при сведении.
      const file = readdirSync(join(process.cwd(), 'migrations')).filter((f) => /^\d+_operator_bookings_status_check\.sql$/.test(f));
      expect(file).toHaveLength(1);
      const sql = readFileSync(join(process.cwd(), 'migrations', file[0]!), 'utf-8');
      await pool.query(sql);
      await pool.query(sql);
      const r = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_constraint
          WHERE conrelid = 'operator_bookings'::regclass AND conname = $1 AND convalidated`,
        [CONSTRAINT],
      );
      expect(r.rows[0]!.n).toBe(1);
    });
  });

  describe('воронка брони и причины невидимости на настоящей базе (#2881, #2882, 30.10)', () => {
    const base = {
      touristName: 'Анна', touristPhone: '+79140001122', touristEmail: 'a@example.com',
      specialRequests: null, createdVia: 'website', userId: null, pdConsent: null, referralCode: null,
    };

    it('заявка заведена — строка booking_submitted с id тура и каналом; отказ — booking_rejected с кодом', async () => {
      const { reserveBooking, ReserveError } = await import('@/lib/bookings/reserve');
      // Больше вместимости (4) — отказ MAX_EXCEEDED из общего модуля.
      let refused: unknown = null;
      try {
        await reserveBooking({ ...base, tourId: Number(tourId), participants: 5, date: '2031-07-01' });
      } catch (e) { refused = e; }
      expect(refused).toBeInstanceOf(ReserveError);
      expect((refused as InstanceType<typeof ReserveError>).code).toBe('MAX_EXCEEDED');

      const ok = await reserveBooking({
        ...base, tourId: Number(tourId), participants: 1, date: '2031-07-10',
        visitor: { ip: '198.51.100.3', userAgent: 'Mozilla/5.0 (iPhone)', cookie: null },
      });
      expect(ok.bookingId).toBeTruthy();

      const rows = await pool.query<{ step: string; reason: string | null; source: string | null; entity_id: string | null; has_hash: boolean }>(
        `SELECT step, reason, source, entity_id, visitor_hash IS NOT NULL AS has_hash
           FROM funnel_events WHERE entity_id = $1 ORDER BY id`,
        [tourId],
      );
      expect(rows.rows).toEqual([
        { step: 'booking_rejected', reason: 'MAX_EXCEEDED', source: 'website', entity_id: tourId, has_hash: false },
        { step: 'booking_submitted', reason: null, source: 'website', entity_id: tourId, has_hash: true },
      ]);
    });

    it('сводка за 7 дней: вёдра невидимых в сумме равны tours_hidden, воронка считает заявку и отказ с причиной', async () => {
      // Три невидимых тура разного рода и один с незаписанным флагом — в остаток.
      await pool.query(
        `INSERT INTO operator_tours (operator_id, title, base_price, is_active, is_published, activity_type, difficulty) VALUES
           ($1, 'Черновик', 1000, TRUE,  FALSE, 'hiking', 'easy'),
           ($1, 'Выключен', 1000, FALSE, TRUE,  'hiking', 'easy'),
           ($1, 'И то и другое', 1000, FALSE, FALSE, 'hiking', 'easy')`,
        [operatorId],
      );
      const { PLATFORM_WEEK_SQL } = await import('@/lib/agents/platform-week-stats');
      const { rows } = await pool.query<{
        tours_visible: number; tours_hidden: number; hidden_draft: number; hidden_inactive: number; hidden_both: number;
        funnel_booking_submitted: number; funnel_booking_rejected: number; funnel_top_reject_reason: string | null; funnel_top_reject_count: number;
      }>(PLATFORM_WEEK_SQL);
      const s = rows[0]!;
      expect(s.tours_visible).toBeGreaterThanOrEqual(1);
      expect(s.hidden_draft).toBeGreaterThanOrEqual(1);
      expect(s.hidden_inactive).toBeGreaterThanOrEqual(1);
      expect(s.hidden_both).toBeGreaterThanOrEqual(1);
      expect(s.hidden_draft + s.hidden_inactive + s.hidden_both).toBe(s.tours_hidden);
      expect(s.funnel_booking_submitted).toBeGreaterThanOrEqual(1);
      expect(s.funnel_booking_rejected).toBeGreaterThanOrEqual(1);
      expect(s.funnel_top_reject_reason).toBe('MAX_EXCEEDED');
      expect(s.funnel_top_reject_count).toBeGreaterThanOrEqual(1);
    });
  });
});
