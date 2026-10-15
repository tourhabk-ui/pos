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
  return {
    ...real,
    requireAuth: async (req: Request) => {
      const user = req.headers.get('x-test-user');
      if (!user) return NextResponse.json({ success: false, error: 'Требуется аутентификация' }, { status: 401 });
      return { userId: user, email: `${user}@test.local`, role: req.headers.get('x-test-role') ?? 'tourist' };
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
});
