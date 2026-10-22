/**
 * Бронь OCTO — только ключу, который её создал (аудит перед запуском, 22.10).
 *
 * `operator_bookings.octo_uuid` заполняется умолчанием `gen_random_uuid()` у
 * КАЖДОЙ брони (миграция 050), не только у канальной. А чтение, подтверждение,
 * отмена и отметка неявки искали бронь по одному этому номеру. Любой
 * действующий ключ реселлера по номеру читал имя, почту и телефон туриста,
 * подтверждал и отменял чужие холды — и брони туристов с сайта, у которых
 * ключа нет вовсе. Второе: ключ, выданный под оператора, ставил холды на туры
 * другого оператора, хотя в списке продуктов их не видел, а холд держит места
 * наравне с бронью.
 *
 * Здесь — исполнение роутов против базы со схемой прода, с настоящей
 * проверкой ключей (`requireOctoAuth` читает octo_api_keys), без подмен:
 *
 *   ключ A (оператор А) создал бронь  → A видит, подтверждает, отмечает, отменяет;
 *   ключ C (на всех операторов)       → по номеру брони A получает 404, бронь не меняется;
 *   ключ B (оператор Б)               → то же, и холд на тур А — 404 PRODUCT_NOT_FOUND;
 *   бронь туриста с сайта             → через OCTO не видна никому, отмена — 404.
 *
 * Без KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[octo-key-binding.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'octo_key_binding_test';
const OPERATOR_A = 'c0c70000-0000-4000-8000-00000000000a';
const OPERATOR_B = 'c0c70000-0000-4000-8000-00000000000b';
const KEY_A = 'octo-test-key-operator-a';
const KEY_B = 'octo-test-key-operator-b';
const KEY_C = 'octo-test-key-all-operators';
const TOURIST_EMAIL = 'tourist-octo-binding@example.test';
const SITE_PHONE = '+79990001122';

interface OctoBooking { id: string; status: string; contact?: { emailAddress?: string | null } }

function req(url: string, key: string, init: { method?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(`https://vedarai.ru${url}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const params = (uuid: string) => ({ params: Promise.resolve({ uuid }) });

async function getBooking(uuid: string, key: string) {
  const { GET } = await import('@/app/api/octo/bookings/[uuid]/route');
  return GET(req(`/api/octo/bookings/${uuid}`, key), params(uuid));
}

async function confirm(uuid: string, key: string) {
  const { POST } = await import('@/app/api/octo/bookings/[uuid]/confirm/route');
  return POST(req(`/api/octo/bookings/${uuid}/confirm`, key, { method: 'POST', body: {} }), params(uuid));
}

async function cancel(uuid: string, key: string) {
  const { POST } = await import('@/app/api/octo/bookings/[uuid]/cancel/route');
  return POST(req(`/api/octo/bookings/${uuid}/cancel`, key, { method: 'POST', body: { reason: 'тест' } }), params(uuid));
}

async function markStatus(uuid: string, key: string, status: 'REDEEMED' | 'NO_SHOW') {
  const { PATCH } = await import('@/app/api/octo/bookings/[uuid]/status/route');
  return PATCH(req(`/api/octo/bookings/${uuid}/status`, key, { method: 'PATCH', body: { status } }), params(uuid));
}

withPg('OCTO: бронь — только ключу, который её создал (22.10)', () => {
  let pool: import('pg').Pool;
  let tourA = '';
  let optionA = '';
  let siteBookingUuid = '';
  let dayN = 0;

  /** Холд через сам роут создания: тот же путь, что у реселлера. */
  async function createHold(key: string, tourId = tourA, optionId = optionA) {
    const { POST } = await import('@/app/api/octo/bookings/route');
    dayN += 1;
    const date = `2027-07-${String(dayN).padStart(2, '0')}`;
    return POST(req('/api/octo/bookings', key, {
      method: 'POST',
      body: {
        productId: tourId,
        optionId,
        availabilityId: `${tourId}-${optionId}-${date}`,
        unitItems: [{ unitId: 'ADULT' }],
        contact: { fullName: 'Турист OCTO', emailAddress: TOURIST_EMAIL },
        resellerReference: `ref-${key}-${dayN}`,
      },
    }));
  }

  async function statusOf(uuid: string): Promise<string> {
    const { rows } = await pool.query<{ booking_status: string }>(
      'SELECT booking_status FROM operator_bookings WHERE octo_uuid = $1', [uuid],
    );
    return rows[0]?.booking_status ?? 'нет строки';
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, status)
       VALUES ($1, 'Оператор А (тест OCTO)', 'operator', '{}'::jsonb, 'test-octo-a', TRUE, 'active'),
              ($2, 'Оператор Б (тест OCTO)', 'operator', '{}'::jsonb, 'test-octo-b', TRUE, 'active')`,
      [OPERATOR_A, OPERATOR_B],
    );
    const { rows: [tour] } = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, duration_hours,
                                   is_active, is_published)
       VALUES ($1, 'Тур оператора А (тест OCTO)', 10000, 8, 6, TRUE, TRUE)
       RETURNING id::text`,
      [OPERATOR_A],
    );
    tourA = tour.id;
    const { rows: [option] } = await pool.query<{ id: string }>(
      `INSERT INTO tour_options (operator_tour_id, internal_name, is_active, price_adult)
       VALUES ($1, 'Стандарт', TRUE, 10000) RETURNING id::text`,
      [tourA],
    );
    optionA = option.id;
    await pool.query(
      `INSERT INTO octo_api_keys (name, api_key, operator_id, can_create_bookings, rate_limit_per_minute)
       VALUES ('Реселлер оператора А', $1, $4, TRUE, 1000),
              ('Реселлер оператора Б', $2, $5, TRUE, 1000),
              ('Реселлер на всех',      $3, NULL, TRUE, 1000)`,
      [KEY_A, KEY_B, KEY_C, OPERATOR_A, OPERATOR_B],
    );
    // Бронь туриста с сайта: ключа канала нет, octo_uuid — умолчанием.
    const { rows: [site] } = await pool.query<{ octo_uuid: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status,
                                      tourist_name, tourist_phone, final_price)
       VALUES ($1, '2027-08-01', 2, 'confirmed', 'Турист с сайта', $2, 20000)
       RETURNING octo_uuid::text`,
      [tourA, SITE_PHONE],
    );
    siteBookingUuid = site.octo_uuid;
    expect(siteBookingUuid).toMatch(/^[0-9a-f-]{36}$/);
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('холд ставит ключ своего оператора и ключ на всех; чужой оператор — 404 PRODUCT_NOT_FOUND', async () => {
    const own = await createHold(KEY_A);
    expect(own.status).toBe(201);
    const all = await createHold(KEY_C);
    expect(all.status).toBe(201);

    const foreign = await createHold(KEY_B);
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: string }).error).toBe('PRODUCT_NOT_FOUND');
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operator_bookings b JOIN octo_api_keys k ON k.id = b.octo_api_key_id
        WHERE k.api_key = $1`, [KEY_B],
    );
    expect(rows[0].n).toBe('0');
  });

  it('бронь читает только её ключ: остальным — 404 без контактов туриста', async () => {
    const created = await createHold(KEY_A);
    const booking = (await created.json()) as OctoBooking;

    const mine = await getBooking(booking.id, KEY_A);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as OctoBooking).id).toBe(booking.id);

    for (const key of [KEY_B, KEY_C]) {
      const res = await getBooking(booking.id, key);
      expect(res.status, `ключ ${key}`).toBe(404);
      expect(await res.text()).not.toContain(TOURIST_EMAIL);
    }
  });

  it('подтверждает только её ключ: чужое подтверждение — 404, холд остаётся холдом', async () => {
    const booking = (await (await createHold(KEY_A)).json()) as OctoBooking;

    for (const key of [KEY_B, KEY_C]) {
      expect((await confirm(booking.id, key)).status, `ключ ${key}`).toBe(404);
    }
    expect(await statusOf(booking.id)).toBe('new');

    const ok = await confirm(booking.id, KEY_A);
    expect(ok.status).toBe(200);
    expect(await statusOf(booking.id)).toBe('confirmed');
  });

  it('неявку отмечает только её ключ', async () => {
    const booking = (await (await createHold(KEY_A)).json()) as OctoBooking;
    expect((await confirm(booking.id, KEY_A)).status).toBe(200);

    for (const key of [KEY_B, KEY_C]) {
      expect((await markStatus(booking.id, key, 'NO_SHOW')).status, `ключ ${key}`).toBe(404);
    }
    expect(await statusOf(booking.id)).toBe('confirmed');

    const ok = await markStatus(booking.id, KEY_A, 'NO_SHOW');
    expect(ok.status).toBe(200);
    expect(await statusOf(booking.id)).toBe('no_show');
  });

  it('отменяет только её ключ', async () => {
    const booking = (await (await createHold(KEY_A)).json()) as OctoBooking;

    for (const key of [KEY_B, KEY_C]) {
      expect((await cancel(booking.id, key)).status, `ключ ${key}`).toBe(404);
    }
    expect(await statusOf(booking.id)).toBe('new');

    const ok = await cancel(booking.id, KEY_A);
    expect(ok.status).toBe(200);
    expect(await statusOf(booking.id)).toBe('cancelled');
  });

  it('бронь туриста с сайта через OCTO не видна и не меняется ни одним ключом', async () => {
    for (const key of [KEY_A, KEY_B, KEY_C]) {
      const res = await getBooking(siteBookingUuid, key);
      expect(res.status, `чтение ключом ${key}`).toBe(404);
      expect(await res.text()).not.toContain(SITE_PHONE);
      expect((await cancel(siteBookingUuid, key)).status, `отмена ключом ${key}`).toBe(404);
      expect((await markStatus(siteBookingUuid, key, 'REDEEMED')).status, `отметка ключом ${key}`).toBe(404);
    }
    expect(await statusOf(siteBookingUuid)).toBe('confirmed');
  });
});
