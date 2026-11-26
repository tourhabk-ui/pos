/**
 * Скидки и наценки тура — с отметкой проверки, на настоящем PostgreSQL.
 *
 * Слово владельца 23.11: «Наценки тоже показываются в модерации: цена тура
 * меняется только через одну дверь». Миграция 1514 даёт правилу
 * `tour_pricing_rules` статус проверки; цену считают только по правилам
 * `approved`. Здесь судится то, чего мок не скажет:
 *
 *  - миграция на таблице с данными: прежние правила остаются действующими,
 *    новое правило без названного статуса — «на проверке»;
 *  - оба читателя цены (карточка / бронь и пакетный расчёт для каналов)
 *    не видят правил «на проверке», отклонённых и выключенных;
 *  - правило, которое просят снять, действует до решения;
 *  - двери администратора и владельца пишут правило действующим.
 *
 * Своя база `pricing_rule_moderation_test`. Без KERNEL_PG_TEST_URL файл
 * честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'c6000000-0000-4000-8000-0000000002ad', role: 'admin' })), // = ADMIN
  requireOperator: vi.fn(async () => ({ userId: 'c6000000-0000-4000-8000-000000000301', role: 'operator' })), // = USER
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[pricing-rule-moderation.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'pricing_rule_moderation_test';
const OP = 'c6000000-0000-4000-8000-000000000101';
const ADMIN = 'c6000000-0000-4000-8000-0000000002ad';
/** Владелец карточки OP: от его имени идут просьбы из кабинета. */
const USER = 'c6000000-0000-4000-8000-000000000301';
/** Чужая карточка: её туры и правила владельцу OP недоступны. */
const OP2 = 'c6000000-0000-4000-8000-000000000102';

withPg('правила цены: действует только проверенное', () => {
  let pool: import('pg').Pool;
  let soon = '';

  const addTour = async (title: string, o: { owner?: string; published?: boolean } = {}) => {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, price_unit, is_active, is_published, max_participants)
       VALUES ($1, $2, 20000, 'per_person', TRUE, $3, 10) RETURNING id::text AS id`, [o.owner ?? OP, title, o.published !== false],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, booked_slots) VALUES ($1::bigint, $2::date, 10, 0)`,
      [id, soon],
    );
    return id;
  };
  /** Правило «скидка на последние места» на близкую дату; статус — как назван (или умолчание колонки). */
  const addRule = async (tour: string, multiplier: number, o: { status?: string; active?: boolean; removal?: boolean } = {}) => {
    const cols = ['operator_tour_id', 'rule_type', 'days_before_min', 'days_before_max', 'multiplier', 'is_active'];
    const vals: unknown[] = [tour, 'last_minute', 0, 7, multiplier, o.active !== false];
    if (o.status !== undefined) { cols.push('moderation_status'); vals.push(o.status); }
    if (o.removal) { cols.push('removal_requested_at'); vals.push(new Date()); }
    return (await pool.query<{ id: string; moderation_status: string }>(
      `INSERT INTO tour_pricing_rules (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id::text AS id, moderation_status`, vals,
    )).rows[0];
  };
  const multipliers = async (tour: string) => {
    const { loadPricingContext } = await import('@/lib/tours/honest-price');
    const ctx = await loadPricingContext(tour, soon, pool);
    return ctx.rules.map((r) => Number(r.multiplier)).sort();
  };
  const bulkPrice = async (tour: string) => {
    const { bulkDynamicPrices } = await import('@/lib/services/tours/dynamic-pricing');
    const prices = await bulkDynamicPrices(tour, [soon], 2, 20000);
    return prices[soon];
  };

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

    await pool.query(`INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'rule-admin@example.test', 'Администратор', 'x', 'admin')`, [ADMIN]);
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, profile_status, is_public) VALUES ($1, 'Оператор', 'operator', '{}'::jsonb, 'approved', TRUE)`,
      [OP],
    );
    // Владелец карточки OP и чужая карточка — для дверей кабинета.
    await pool.query(`INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'rule-owner@example.test', 'Тест', 'x', 'operator')`, [USER]);
    await pool.query(`UPDATE partners SET user_id = $2 WHERE id = $1`, [OP, USER]);
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, profile_status, is_public)
       VALUES ($1, 'Другой оператор', 'operator', '{}'::jsonb, 'approved', TRUE)`,
      [OP2],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
  });

  it('миграция 1514 на таблице с данными: прежние правила действуют, новое без статуса — «на проверке»', async () => {
    // Тот же текст миграции — на пробной таблице с двумя правилами, заведёнными «до миграции».
    await pool.query(`CREATE TABLE probe_rules (id BIGSERIAL PRIMARY KEY, multiplier NUMERIC(5,3) NOT NULL, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`INSERT INTO probe_rules (multiplier, is_active) VALUES (0.85, TRUE), (1.15, FALSE)`);
    const sql = readFileSync(join(process.cwd(), 'migrations/1514_tour_pricing_rules_moderation.sql'), 'utf-8')
      .replace(/tour_pricing_rules/g, 'probe_rules');
    await pool.query(sql);
    expect((await pool.query(`SELECT multiplier::float8 AS m, moderation_status FROM probe_rules ORDER BY id`)).rows)
      .toEqual([{ m: 0.85, moderation_status: 'approved' }, { m: 1.15, moderation_status: 'approved' }]);
    // Новое правило без названного статуса цену не меняет, пока его не проверили.
    const fresh = await pool.query(`INSERT INTO probe_rules (multiplier) VALUES (0.5) RETURNING moderation_status`);
    expect(fresh.rows[0].moderation_status).toBe('pending');
    // Повторный прогон миграции статусы не трогает.
    await pool.query(sql);
    expect((await pool.query(`SELECT moderation_status, COUNT(*)::int AS n FROM probe_rules GROUP BY 1 ORDER BY 1`)).rows)
      .toEqual([{ moderation_status: 'approved', n: 2 }, { moderation_status: 'pending', n: 1 }]);
    // Чужой статус база не примет.
    await expect(pool.query(`INSERT INTO probe_rules (multiplier, moderation_status) VALUES (0.9, 'live')`)).rejects.toMatchObject({ code: '23514' });
    await pool.query(`DROP TABLE probe_rules`);
  });

  it('у настоящей таблицы умолчание — «на проверке»: правило без статуса цену не меняет', async () => {
    const tour = await addTour('Правило без статуса');
    const rule = await addRule(tour, 0.5);
    expect(rule.moderation_status).toBe('pending');
    expect(await multipliers(tour)).toEqual([]);
    expect((await bulkPrice(tour)).finalPrice).toBe(20000);
  });

  it('оба читателя цены видят только проверенное и включённое правило', async () => {
    const tour = await addTour('Четыре правила');
    await addRule(tour, 0.85, { status: 'approved' });
    await addRule(tour, 0.5, { status: 'pending' });
    await addRule(tour, 0.6, { status: 'rejected' });
    await addRule(tour, 0.7, { status: 'approved', active: false });
    expect(await multipliers(tour)).toEqual([0.85]);
    // Пакетный расчёт для каналов — то же правило и та же цена.
    const bulk = await bulkPrice(tour);
    expect(bulk.finalPrice).toBe(17000);
    const { honestTourPrice } = await import('@/lib/tours/honest-price');
    const shown = await honestTourPrice({ tourId: tour, tourDate: soon, baseUnitPrice: 20000, priceUnit: 'per_person', participants: 2, exec: pool });
    expect(shown.finalUnitPrice).toBe(17000);
    expect(shown.total).toBe(34000);
    expect(shown.appliedRules).toEqual(['last_minute']);
  });

  it('правило, которое просят снять, действует до решения', async () => {
    const tour = await addTour('Просят снять');
    await addRule(tour, 0.85, { status: 'approved', removal: true });
    expect(await multipliers(tour)).toEqual([0.85]);
  });

  it('дверь администратора пишет правило действующим и называет, кто одобрил', async () => {
    const tour = await addTour('Правило администратора');
    const { POST } = await import('@/app/api/admin/pricing-rules/route');
    const res = await POST(new NextRequest('http://localhost/api/admin/pricing-rules', {
      method: 'POST',
      body: JSON.stringify({ operatorTourId: Number(tour), ruleType: 'last_minute', multiplier: 0.9, daysBeforeMin: 0, daysBeforeMax: 7 }),
    }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const row = (await pool.query(
      `SELECT moderation_status, moderated_by::text AS moderated_by, moderated_at IS NOT NULL AS decided FROM tour_pricing_rules WHERE operator_tour_id = $1::bigint`, [tour],
    )).rows[0];
    expect(row).toEqual({ moderation_status: 'approved', moderated_by: ADMIN, decided: true });
    expect(await multipliers(tour)).toEqual([0.9]);
  });

  it('наценка на выходные из кабинета владельца — действующая (до очереди наценок поведение прежнее)', async () => {
    const tour = await addTour('Наценка на выходные');
    const { setWeekendMarkup, listWeekendMarkups } = await import('@/lib/tours/operator-markup');
    expect(await setWeekendMarkup(pool, OP, [Number(tour)], 15)).toEqual([Number(tour)]);
    const row = (await pool.query(`SELECT moderation_status, rule_type FROM tour_pricing_rules WHERE operator_tour_id = $1::bigint AND is_active = TRUE`, [tour])).rows[0];
    expect(row).toEqual({ moderation_status: 'approved', rule_type: 'weekend_sat_sun' });
    expect((await listWeekendMarkups(pool, OP)).find((m) => m.tourId === Number(tour))?.percent).toBe(15);
    // Чужой тур наценка не трогает.
    const foreign = await addTour('Чужая наценка на выходные', { owner: OP2 });
    expect(await setWeekendMarkup(pool, OP, [Number(foreign)], 15)).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM tour_pricing_rules WHERE operator_tour_id = $1::bigint`, [foreign])).rowCount).toBe(0);
  });

  // Пока двери владельца не переведены на «на проверку», скидка из кабинета
  // обязана действовать сразу: умолчание колонки — «на проверке», и правило,
  // записанное без статуса, молча перестало бы менять цену.
  it('скидка из кабинета владельца — действующая сразу; новая заменяет прежнюю; снятие — сразу', async () => {
    const tour = await addTour('Скидка из кабинета');
    const route = await import('@/app/api/hub/operator/pricing-rules/route');
    const ask = async (tourId: string, percent: number) => {
      const res = await route.POST(new NextRequest('http://localhost/api/hub/operator/pricing-rules', {
        method: 'POST', body: JSON.stringify({ tourId: Number(tourId), ruleType: 'last_minute', percent, daysBefore: 7 }),
      }));
      return { status: res.status, body: (await res.json()) as { id?: string } };
    };
    const drop = async (id: string) => (await route.DELETE(
      new NextRequest(`http://localhost/api/hub/operator/pricing-rules?id=${id}`, { method: 'DELETE' }),
    )).status;
    const rows = async (tourId: string) => (await pool.query(
      `SELECT pr.multiplier::float8 AS m, pr.moderation_status AS status, pr.is_active AS active
         FROM tour_pricing_rules pr WHERE pr.operator_tour_id = $1::bigint ORDER BY pr.id`, [tourId],
    )).rows;

    const first = await ask(tour, 15);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await rows(tour)).toEqual([{ m: 0.85, status: 'approved', active: true }]);
    expect(await multipliers(tour)).toEqual([0.85]);
    // Вторая скидка того же рода не перемножается с первой.
    const second = await ask(tour, 25);
    expect(await rows(tour)).toEqual([{ m: 0.85, status: 'approved', active: false }, { m: 0.75, status: 'approved', active: true }]);
    expect(await multipliers(tour)).toEqual([0.75]);
    expect(await drop(second.body.id!)).toBe(200);
    expect(await multipliers(tour)).toEqual([]);

    // Чужой тур: скидка не записана, чужое правило не снято.
    const foreign = await addTour('Чужая скидка', { owner: OP2 });
    expect((await ask(foreign, 15)).status).toBe(404);
    expect(await rows(foreign)).toEqual([]);
    const theirs = await addRule(foreign, 0.9, { status: 'approved' });
    expect(await drop(theirs.id)).toBe(404);
    expect(await rows(foreign)).toEqual([{ m: 0.9, status: 'approved', active: true }]);
  });
});
