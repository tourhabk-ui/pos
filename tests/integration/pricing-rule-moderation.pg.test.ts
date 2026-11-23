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
 *  - дверь администратора пишет правило действующим, двери владельца
 *    (скидки, наценка на выходные, подтверждение цены из чата) — на проверку:
 *    владение, замена просьбы, снятие, гонка двух просьб.
 *
 * Своя база `pricing_rule_moderation_test`. Без KERNEL_PG_TEST_URL файл
 * честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

// Транспорт сообщения владельцу подменён: настоящие чаты из тестов не тревожим.
const sent = vi.hoisted(() => ({ alerts: [] as Array<{ text: string }> }));
vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async (a: { text: string }) => {
    sent.alerts.push(a);
    return { channel: 'max', delivered: true };
  }),
}));
// Поисковикам из теста не пишем; что пинг уходит только после одобрения — считаем вызовы.
const pings = vi.hoisted(() => ({ tours: [] as string[] }));
vi.mock('@/lib/seo/indexnow', async (orig) => ({
  ...(await orig<typeof import('@/lib/seo/indexnow')>()),
  pingTourChanged: vi.fn((id: string | number | bigint) => { pings.tours.push(String(id)); }),
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
    await pool.query(`INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'rule-owner@example.test', 'Тест', 'x', 'operator')`, [USER]);
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, profile_status, is_public, max_chat_id, user_id)
       VALUES ($1, 'Оператор', 'operator', '{}'::jsonb, 'approved', TRUE, 555003, $2)`,
      [OP, USER],
    );
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, profile_status, is_public)
       VALUES ($1, 'Другой оператор', 'operator', '{}'::jsonb, 'approved', TRUE)`,
      [OP2],
    );
  }, 300_000);

  // Счётчики сообщений и пингов — на один тест: «никому не писали» судится с нуля.
  beforeEach(() => { sent.alerts.length = 0; pings.tours.length = 0; });

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
  });

  it('миграция 1514 на таблице с данными: прежние правила действуют, новое без статуса — «на проверке»', async () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/1514_tour_pricing_rules_moderation.sql'), 'utf-8');
    // Таблица прода «до миграции»: в базе теста миграция уже применена, поэтому
    // её снимает обратная правка из хвоста самой миграции, выполненная как есть
    // (заодно проверено, что обещанный откат исполним). Рукописной таблицы нет:
    // миграция ложится на настоящую схему tour_pricing_rules.
    const rollback = sql.slice(sql.indexOf('-- Rollback:')).split('\n').slice(1)
      .map((line) => line.replace(/^--\s?/, '')).join('\n');
    expect(rollback).toMatch(/DROP COLUMN IF EXISTS moderation_status/);
    await pool.query(rollback);
    const columns = async () => (await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'tour_pricing_rules' AND column_name LIKE 'moderat%'`)).rows.map((r) => r.column_name).sort();
    expect(await columns()).toEqual([]);

    // Два правила, заведённые «до миграции»: включённое и выключенное.
    const tour = await addTour('Правила до миграции');
    const before = async (multiplier: number, active: boolean) => (await pool.query<{ id: string }>(
      `INSERT INTO tour_pricing_rules (operator_tour_id, rule_type, days_before_min, days_before_max, multiplier, is_active)
       VALUES ($1::bigint, 'last_minute', 0, 3, $2, $3) RETURNING id::text`, [tour, multiplier, active])).rows[0]!.id;
    const live = await before(0.85, true);
    const off = await before(1.15, false);

    await pool.query(sql);
    expect(await columns()).toEqual(['moderated_at', 'moderated_by', 'moderation_reason', 'moderation_status']);
    const statuses = async () => (await pool.query<{ id: string; m: number; moderation_status: string }>(
      `SELECT id::text, multiplier::float8 AS m, moderation_status FROM tour_pricing_rules WHERE operator_tour_id = $1::bigint ORDER BY id`, [tour])).rows;
    expect(await statuses()).toEqual([
      { id: live, m: 0.85, moderation_status: 'approved' },
      { id: off, m: 1.15, moderation_status: 'approved' },
    ]);
    // Новое правило без названного статуса цену не меняет, пока его не проверили.
    const fresh = await pool.query<{ id: string; moderation_status: string }>(
      `INSERT INTO tour_pricing_rules (operator_tour_id, rule_type, days_before_min, days_before_max, multiplier)
       VALUES ($1::bigint, 'last_minute', 4, 7, 0.5) RETURNING id::text, moderation_status`, [tour]);
    expect(fresh.rows[0]!.moderation_status).toBe('pending');
    // Повторный прогон миграции статусы не трогает.
    await pool.query(sql);
    expect((await statuses()).map((r) => r.moderation_status)).toEqual(['approved', 'approved', 'pending']);
    // Чужой статус база не примет.
    await expect(pool.query(
      `INSERT INTO tour_pricing_rules (operator_tour_id, rule_type, days_before_min, days_before_max, multiplier, moderation_status)
       VALUES ($1::bigint, 'last_minute', 8, 9, 0.9, 'live')`, [tour])).rejects.toMatchObject({ code: '23514' });
    await pool.query(`DELETE FROM tour_pricing_rules WHERE operator_tour_id = $1::bigint`, [tour]);
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

  describe('двери владельца: скидка и наценка идут на проверку', () => {
    const rulesOf = async (tour: string) => (await pool.query<{
      id: string; type: string; m: number; status: string; active: boolean; removal: boolean; by: string | null;
    }>(
      `SELECT id::text AS id, rule_type AS type, multiplier::float8 AS m, moderation_status AS status, is_active AS active,
              removal_requested_at IS NOT NULL AS removal, requested_by::text AS by
         FROM tour_pricing_rules pr WHERE operator_tour_id = $1::bigint ORDER BY pr.id`, [tour],
    )).rows;
    const call = async (path: string, method: 'POST' | 'DELETE' | 'GET', body?: unknown) => {
      const mod = path.startsWith('/api/hub/operator/weekend-markup')
        ? await import('@/app/api/hub/operator/weekend-markup/route')
        : await import('@/app/api/hub/operator/pricing-rules/route');
      const res = await mod[method](new NextRequest(`http://localhost${path}`, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      return { status: res.status, body: await res.json() };
    };
    const askDiscount = (tour: string, percent: number, extra: Record<string, unknown> = { ruleType: 'last_minute', daysBefore: 7 }) =>
      call('/api/hub/operator/pricing-rules', 'POST', { tourId: Number(tour), percent, ...extra });
    const dropDiscount = (id: string) => call(`/api/hub/operator/pricing-rules?id=${id}`, 'DELETE');
    const askMarkup = (tour: string, percent: number) => call('/api/hub/operator/weekend-markup', 'POST', { tourId: Number(tour), percent });
    const dropMarkup = (query: string) => call(`/api/hub/operator/weekend-markup?${query}`, 'DELETE');
    const markupOf = async (tour: string) => {
      const { listWeekendMarkups } = await import('@/lib/tours/operator-markup');
      return (await listWeekendMarkups(pool, OP)).find((m) => m.tourId === Number(tour))!;
    };
    /** Решение администратора — той же дверью, что и в кабинете: карточка очереди и её отпечаток. */
    const decideRule = async (id: string, action: 'approve' | 'reject', reason?: string) => {
      const list = await import('@/app/api/admin/moderation/pricing-rules/route');
      const cards = (await (await list.GET(new NextRequest('http://localhost/api/admin/moderation/pricing-rules'))).json()) as {
        data: { rules: Array<{ id: string; seen: string }> };
      };
      const seen = cards.data.rules.find((r) => r.id === id)?.seen;
      const { POST } = await import('@/app/api/admin/moderation/pricing-rules/[id]/route');
      const res = await POST(
        new NextRequest(`http://localhost/api/admin/moderation/pricing-rules/${id}`, { method: 'POST', body: JSON.stringify({ action, seen, reason }) }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    };

    it('скидка из кабинета ждёт проверки и цену не меняет; повтор — «уже ждёт», второй строки нет', async () => {
      const tour = await addTour('Дверь: новая скидка');
      const asked = await askDiscount(tour, 15);
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      expect(asked.body).toMatchObject({ success: true, state: 'pending' });
      expect(await rulesOf(tour)).toEqual([
        { id: asked.body.id, type: 'last_minute', m: 0.85, status: 'pending', active: true, removal: false, by: USER },
      ]);
      // На сайте цена прежняя — у обоих читателей.
      expect(await multipliers(tour)).toEqual([]);
      expect((await bulkPrice(tour)).finalPrice).toBe(20000);
      // Та же просьба ещё раз: строка та же, а не вторая.
      const again = await askDiscount(tour, 15);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ state: 'already_pending', id: asked.body.id });
      expect(await rulesOf(tour)).toHaveLength(1);
      // Владелец видит свою просьбу со статусом.
      const list = await call('/api/hub/operator/pricing-rules', 'GET');
      const mine = (list.body.data as Array<Record<string, unknown>>).filter((r) => r.tour_id === tour);
      expect(mine).toEqual([expect.objectContaining({ rule_id: asked.body.id, moderation_status: 'pending', removal_asked: false })]);
      // После одобрения скидка действует.
      await decideRule(asked.body.id, 'approve');
      expect(await multipliers(tour)).toEqual([0.85]);
    });

    it('новая просьба заменяет прежнюю неодобренную; действующая скидка действует до решения', async () => {
      const tour = await addTour('Дверь: замена просьбы');
      const live = await addRule(tour, 0.9, { status: 'approved' });
      const first = await askDiscount(tour, 20);
      expect(first.body.state).toBe('pending');
      expect(await multipliers(tour)).toEqual([0.9]);
      const second = await askDiscount(tour, 25);
      expect(second.body.state).toBe('pending');
      expect(second.body.id).not.toBe(first.body.id);
      // Ждёт одна просьба — последняя; действующее правило не тронуто.
      expect((await rulesOf(tour)).map((r) => [r.id, r.status, r.active])).toEqual([
        [live.id, 'approved', true],
        [first.body.id, 'pending', false],
        [second.body.id, 'pending', true],
      ]);
      expect(await multipliers(tour)).toEqual([0.9]);
      // Одобрение новой выключает прежнюю: две скидки не перемножаются.
      await decideRule(second.body.id, 'approve');
      expect(await multipliers(tour)).toEqual([0.75]);
      // Та же скидка, что уже действует: проверять нечего, просьбы сняты.
      const pendingAgain = await askDiscount(tour, 30);
      const same = await askDiscount(tour, 25);
      expect(same.status).toBe(200);
      expect(same.body).toMatchObject({ state: 'already_live', id: second.body.id });
      expect((await rulesOf(tour)).find((r) => r.id === pendingAgain.body.id)).toMatchObject({ active: false });
      expect(await multipliers(tour)).toEqual([0.75]);
    });

    it('другое окно дней при том же проценте — другая скидка, и она тоже ждёт проверки', async () => {
      const tour = await addTour('Дверь: другое условие');
      await addRule(tour, 0.9, { status: 'approved' }); // −10% за 7 дней
      const wider = await askDiscount(tour, 10, { ruleType: 'last_minute', daysBefore: 30 });
      expect(wider.body.state).toBe('pending');
      const group = await askDiscount(tour, 10, { ruleType: 'group_discount', guestsMin: 4 });
      // Скидка другого рода — отдельная просьба, прежнюю не снимает.
      expect(group.body.state).toBe('pending');
      expect((await rulesOf(tour)).filter((r) => r.active && r.status === 'pending').map((r) => r.type).sort())
        .toEqual(['group_discount', 'last_minute']);
      // То же с размером группы: «от 6 человек» — не та скидка, что «от 4».
      await decideRule(group.body.id, 'approve');
      expect((await askDiscount(tour, 10, { ruleType: 'group_discount', guestsMin: 4 })).body.state).toBe('already_live');
      expect((await askDiscount(tour, 10, { ruleType: 'group_discount', guestsMin: 6 })).body.state).toBe('pending');
      // И с процентом: тот же размер группы, другая скидка.
      expect((await askDiscount(tour, 12, { ruleType: 'group_discount', guestsMin: 4 })).body.state).toBe('pending');
    });

    it('снять действующую — просьба, до решения действует; неодобренную владелец убирает сразу', async () => {
      const tour = await addTour('Дверь: снятие');
      const live = await addRule(tour, 0.9, { status: 'approved' });
      const asked = await dropDiscount(live.id);
      expect(asked.status).toBe(200);
      expect(asked.body.state).toBe('removal_pending');
      expect(await rulesOf(tour)).toEqual([expect.objectContaining({ id: live.id, status: 'approved', active: true, removal: true })]);
      expect(await multipliers(tour)).toEqual([0.9]);
      // Повторная просьба время первой не сдвигает.
      const at = (await pool.query(`SELECT removal_requested_at AS at FROM tour_pricing_rules WHERE id = $1::bigint`, [live.id])).rows[0].at;
      expect((await dropDiscount(live.id)).body.state).toBe('removal_pending');
      expect((await pool.query(`SELECT removal_requested_at AS at FROM tour_pricing_rules WHERE id = $1::bigint`, [live.id])).rows[0].at).toEqual(at);
      // Владелец передумал и попросил ту же скидку: просьба о снятии отменена.
      expect((await askDiscount(tour, 10)).body.state).toBe('already_live');
      expect((await rulesOf(tour))[0]).toMatchObject({ removal: false, active: true });
      // Неодобренная просьба убирается сразу, действующая скидка при этом не тронута.
      const fresh = await askDiscount(tour, 30);
      const gone = await dropDiscount(fresh.body.id);
      expect(gone.body.state).toBe('withdrawn');
      expect((await rulesOf(tour)).map((r) => [r.id, r.active, r.removal])).toEqual([[live.id, true, false], [fresh.body.id, false, false]]);
      // Убранного правила больше нет.
      expect((await dropDiscount(fresh.body.id)).status).toBe(404);
      // Администратор одобрил снятие — цена базовая.
      await dropDiscount(live.id);
      await decideRule(live.id, 'approve');
      expect(await multipliers(tour)).toEqual([]);
    });

    it('чужой тур, чужое правило и удалённый тур — 404, и ни одной записи', async () => {
      const foreign = await addTour('Дверь: чужой тур', { owner: OP2 });
      expect((await askDiscount(foreign, 15)).status).toBe(404);
      expect((await askMarkup(foreign, 15)).status).toBe(404);
      expect(await rulesOf(foreign)).toEqual([]);
      const theirs = await addRule(foreign, 0.9, { status: 'approved' });
      const theirAsk = await addRule(foreign, 0.8, { status: 'pending' });
      expect((await dropDiscount(theirs.id)).status).toBe(404);
      expect((await dropDiscount(theirAsk.id)).status).toBe(404);
      expect((await dropMarkup(`ruleId=${theirAsk.id}`)).status).toBe(404);
      expect((await dropMarkup(`tourId=${foreign}`)).status).toBe(404);
      expect((await rulesOf(foreign)).map((r) => [r.id, r.active, r.removal])).toEqual([[theirs.id, true, false], [theirAsk.id, true, false]]);
      // Свой, но удалённый тур.
      const deleted = await addTour('Дверь: удалённый тур');
      const old = await addRule(deleted, 0.9, { status: 'approved' });
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1::bigint`, [deleted]);
      expect((await askDiscount(deleted, 15)).status).toBe(404);
      expect((await dropDiscount(old.id)).status).toBe(404);
      expect((await rulesOf(deleted)).map((r) => [r.active, r.removal])).toEqual([[true, false]]);
    });

    it('у тура, которого нет на сайте, правило тоже ждёт проверки', async () => {
      // Иначе наценка, заведённая до публикации, вышла бы на сайт вместе с туром никем не виденной.
      const tour = await addTour('Дверь: тур не на сайте', { published: false });
      expect((await askDiscount(tour, 15)).body.state).toBe('pending');
      expect((await askMarkup(tour, 20)).body.state).toBe('pending');
      expect((await rulesOf(tour)).map((r) => r.status)).toEqual(['pending', 'pending']);
      expect(await multipliers(tour)).toEqual([]);
    });

    it('наценка на выходные: просьба; отозвать просьбу — не значит просить снять действующую', async () => {
      const tour = await addTour('Дверь: наценка на выходные');
      const asked = await askMarkup(tour, 15);
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      expect(asked.body.state).toBe('pending');
      expect(await multipliers(tour)).toEqual([]);
      const before = await markupOf(tour);
      expect(before).toMatchObject({ percent: null, ruleId: null, removalAsked: false, request: { percent: 15, status: 'pending', reason: null } });
      expect((await rulesOf(tour))[0]).toMatchObject({ type: 'weekend_sat_sun', by: USER });
      await decideRule(before.request!.ruleId, 'approve');
      expect(await markupOf(tour)).toMatchObject({ percent: 15, ruleId: before.request!.ruleId, request: null });
      expect(await multipliers(tour)).toEqual([1.15]);
      // Та же наценка ещё раз — «уже действует», без новой строки.
      const same = await askMarkup(tour, 15);
      expect(same.status).toBe(200);
      expect(same.body.state).toBe('already_live');
      // Новая просьба рядом с действующей: владелец видит обе раздельно.
      expect((await askMarkup(tour, 20)).body.state).toBe('pending');
      const both = await markupOf(tour);
      expect(both).toMatchObject({ percent: 15, removalAsked: false, request: { percent: 20, status: 'pending' } });
      // Отозвал просьбу: действующая наценка действует, снять её никто не просил.
      const back = await dropMarkup(`ruleId=${both.request!.ruleId}`);
      expect(back.body.state).toBe('withdrawn');
      expect(await markupOf(tour)).toMatchObject({ percent: 15, removalAsked: false, request: null });
      // Скидку через экран наценки не убрать: род правила другой.
      const discount = await askDiscount(tour, 10);
      expect((await dropMarkup(`ruleId=${discount.body.id}`)).status).toBe(404);
      expect((await rulesOf(tour)).find((r) => r.id === discount.body.id)).toMatchObject({ active: true });
      // Снять действующую — просьба; до решения действует.
      const off = await dropMarkup(`ruleId=${both.ruleId}`);
      expect(off.body.state).toBe('removal_pending');
      expect(await markupOf(tour)).toMatchObject({ percent: 15, removalAsked: true });
      expect(await multipliers(tour)).toEqual([1.15]);
      // Не число и ни одного параметра — отказ без записи.
      expect((await dropMarkup('ruleId=1%3B')).status).toBe(404);
      expect((await dropMarkup('')).status).toBe(400);
    });

    it('снять все наценки тура (как из чата): действующая — просьбой, ждущая — сразу', async () => {
      const tour = await addTour('Дверь: снять наценки тура');
      const live = await addRule(tour, 1.1, { status: 'approved' });
      await pool.query(`UPDATE tour_pricing_rules SET rule_type = 'weekend_sat_sun', days_before_min = NULL, days_before_max = NULL WHERE id = $1::bigint`, [live.id]);
      await askMarkup(tour, 25);
      const off = await dropMarkup(`tourId=${tour}`);
      expect(off.body.state).toBe('removal_pending');
      expect(await markupOf(tour)).toMatchObject({ percent: 10, removalAsked: true, request: null });
      // У тура без наценок снимать нечего — и это не просьба.
      const empty = await addTour('Дверь: наценок нет');
      const none = await dropMarkup(`tourId=${empty}`);
      expect(none.status).toBe(200);
      expect(none.body.state).toBe('withdrawn');
      expect(await rulesOf(empty)).toEqual([]);
    });

    it('отклонённую просьбу владелец видит с причиной; новая просьба её заменяет', async () => {
      const tour = await addTour('Дверь: отказ');
      const asked = await askMarkup(tour, 30);
      const rule = (await markupOf(tour)).request!.ruleId;
      expect(asked.body.state).toBe('pending');
      await decideRule(rule, 'reject', 'Наценка 30% без объяснения — уточните.');
      expect(await markupOf(tour)).toMatchObject({
        percent: null, request: { ruleId: rule, percent: 30, status: 'rejected', reason: 'Наценка 30% без объяснения — уточните.' },
      });
      expect(await multipliers(tour)).toEqual([]);
      // Та же наценка после отказа — новая просьба, а не «уже ждёт».
      const again = await askMarkup(tour, 30);
      expect(again.body.state).toBe('pending');
      const now = await markupOf(tour);
      expect(now.request).toMatchObject({ percent: 30, status: 'pending', reason: null });
      expect(now.request!.ruleId).not.toBe(rule);
      expect((await rulesOf(tour)).find((r) => r.id === rule)).toMatchObject({ active: false, status: 'rejected' });
    });

    it('наценка из чата (подтверждение цены) уходит на проверку, а не на сайт', async () => {
      const tour = await addTour('Дверь: наценка из чата');
      const { createPendingChange, confirmPendingChange } = await import('@/lib/crm/price-change');
      const now = Date.now();
      const preview = {
        change: { kind: 'weekend_markup' as const, percent: 10, tourIds: 'all' as const }, sampleDate: soon,
        tours: [{ tourId: Number(tour), title: 'Дверь: наценка из чата', baseBefore: 20000, baseAfter: 20000, saturdayBefore: 20000, saturdayAfter: 22000, tiersOverride: false }],
      };
      const id = await createPendingChange(pool, OP, preview as never, now);
      expect(await confirmPendingChange(pool, OP, id, USER, now)).toEqual({ outcome: 'applied', applied: [], pending: [Number(tour)], skipped: [] });
      expect(await rulesOf(tour)).toEqual([expect.objectContaining({ type: 'weekend_sat_sun', m: 1.1, status: 'pending', active: true, by: USER })]);
      expect(await multipliers(tour)).toEqual([]);
    });

    it('две просьбы разом: вторая ждёт первую и заменяет её — двух ждущих правил не остаётся', async () => {
      const tour = await addTour('Дверь: гонка просьб');
      const { proposePricingRule } = await import('@/lib/tours/pricing-rule-door');
      const want = (multiplier: number) => ({
        operatorId: OP, requestedBy: USER, tourId: tour, ruleType: 'last_minute', multiplier, daysBeforeMin: 0, daysBeforeMax: 7,
      });
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query('BEGIN');
        await proposePricingRule(first, want(0.9));
        await second.query('BEGIN');
        let settled = false;
        const racing = proposePricingRule(second, want(0.8)).then((r) => { settled = true; return r; });
        // Пока первая не зафиксирована, вторая стоит на замке строки тура.
        await new Promise((r) => setTimeout(r, 400));
        expect(settled).toBe(false);
        await first.query('COMMIT');
        expect((await racing).outcome).toBe('pending');
        await second.query('COMMIT');
      } finally {
        await first.query('ROLLBACK').catch(() => {});
        await second.query('ROLLBACK').catch(() => {});
        first.release();
        second.release();
      }
      expect((await rulesOf(tour)).filter((r) => r.active).map((r) => [r.m, r.status])).toEqual([[0.8, 'pending']]);
    });
  });

  describe('очередь администратора и решение', () => {
    const queue = async () => {
      const { GET } = await import('@/app/api/admin/moderation/pricing-rules/route');
      const res = await GET(new NextRequest('http://localhost/api/admin/moderation/pricing-rules'));
      const json = (await res.json()) as { data: { rules: Array<Record<string, unknown> & { id: string; tourId: string; kind: string; seen: string }> } };
      return json.data.rules;
    };
    const decide = async (id: string, body: unknown) => {
      const { POST } = await import('@/app/api/admin/moderation/pricing-rules/[id]/route');
      const res = await POST(
        new NextRequest(`http://localhost/api/admin/moderation/pricing-rules/${id}`, { method: 'POST', body: JSON.stringify(body) }),
        { params: Promise.resolve({ id }) },
      );
      return { status: res.status, body: await res.json() };
    };
    const ruleRow = async (id: string) => (await pool.query(
      `SELECT is_active, moderation_status, moderation_reason, moderated_by::text AS moderated_by,
              removal_requested_at IS NOT NULL AS removal_asked
         FROM tour_pricing_rules WHERE id = $1::bigint`, [id],
    )).rows[0];

    it('новое правило: в очереди — слова, что заменит и как изменится цена; одобрение включает его и выключает прежнее', async () => {
      const tour = await addTour('Очередь: замена скидки');
      const current = await addRule(tour, 0.9, { status: 'approved' });
      const fresh = await addRule(tour, 0.8, { status: 'pending' });
      const card = (await queue()).find((r) => r.id === fresh.id)!;
      expect(card).toMatchObject({
        kind: 'new', tourId: tour, tourTitle: 'Очередь: замена скидки', partnerName: 'Оператор', tourOnSite: true,
        words: 'Скидка на последние места: −20%, когда до выезда 7 дн. и меньше',
        replaces: 'Скидка на последние места: −10%, когда до выезда 7 дн. и меньше',
        basePrice: 20000, priceNow: 18000, priceAfter: 16000,
      });
      // Пока не одобрено — действует прежнее.
      expect(await multipliers(tour)).toEqual([0.9]);

      // Без отпечатка и с чужим отпечатком одобрение не применяется.
      expect((await decide(fresh.id, { action: 'approve' })).status).toBe(400);
      const stale = await decide(fresh.id, { action: 'approve', seen: 'a'.repeat(64) });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('changed');
      expect(await multipliers(tour)).toEqual([0.9]);

      // Отказы выше владельцу ничего не слали и поисковиков не будили.
      expect(sent.alerts).toHaveLength(0);
      expect(pings.tours).toEqual([]);
      const ok = await decide(fresh.id, { action: 'approve', seen: card.seen });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.message).toBe('«Очередь: замена скидки»: правило действует на сайте');
      // Владельцу сказано, что стало с ценой на сайте; поисковикам — о странице тура.
      expect(sent.alerts.map((a) => a.text)).toEqual([[
        '<b>Скидка или наценка одобрена</b>',
        '«Очередь: замена скидки»: Скидка на последние места: −20%, когда до выезда 7 дн. и меньше — действует на сайте.',
      ].join('\n')]);
      expect(pings.tours).toEqual([tour]);
      expect(await multipliers(tour)).toEqual([0.8]);
      expect(await ruleRow(fresh.id)).toMatchObject({ is_active: true, moderation_status: 'approved', moderated_by: ADMIN });
      expect(await ruleRow(current.id)).toMatchObject({ is_active: false, moderation_status: 'approved' });
      // Решено — в очереди его нет; повторное решение не применяется.
      expect((await queue()).some((r) => r.id === fresh.id)).toBe(false);
      expect((await decide(fresh.id, { action: 'approve', seen: card.seen })).status).toBe(409);
    });

    it('отказ новому правилу: цена прежняя, причина записана; без причины — 400', async () => {
      const tour = await addTour('Очередь: отказ');
      await addRule(tour, 0.9, { status: 'approved' });
      const fresh = await addRule(tour, 0.5, { status: 'pending' });
      expect((await decide(fresh.id, { action: 'reject', reason: 'нет' })).status).toBe(400);
      sent.alerts.length = 0;
      pings.tours.length = 0;
      const no = await decide(fresh.id, { action: 'reject', reason: 'Скидка 50% без объяснения — уточните.' });
      expect(no.status).toBe(200);
      expect(sent.alerts[0].text).toContain('Скидка или наценка отклонена');
      expect(sent.alerts[0].text).toContain('цена на сайте прежняя');
      expect(sent.alerts[0].text).toContain('Причина: Скидка 50% без объяснения — уточните.');
      // Цена на сайте не изменилась — поисковикам сообщать нечего.
      expect(pings.tours).toEqual([]);
      expect(no.body.message).toBe('«Очередь: отказ»: правило отклонено, цена прежняя');
      expect(await multipliers(tour)).toEqual([0.9]);
      expect(await ruleRow(fresh.id)).toMatchObject({
        moderation_status: 'rejected', moderation_reason: 'Скидка 50% без объяснения — уточните.', moderated_by: ADMIN,
      });
    });

    it('просьба снять правило: до решения действует; одобрено — выключено; отказано — действует, просьба закрыта с причиной', async () => {
      const tour = await addTour('Очередь: снятие');
      const rule = await addRule(tour, 0.85, { status: 'approved', removal: true });
      const card = (await queue()).find((r) => r.id === rule.id)!;
      expect(card).toMatchObject({ kind: 'removal', replaces: null, priceNow: 17000, priceAfter: 20000 });
      // В снятии отказано: правило действует дальше.
      sent.alerts.length = 0;
      const keep = await decide(rule.id, { action: 'reject', reason: 'Скидка обещана туристам до конца месяца.' });
      expect(keep.body.message).toBe('«Очередь: снятие»: в снятии отказано, правило действует');
      expect(sent.alerts[0].text).toContain('В снятии правила цены отказано');
      expect(sent.alerts[0].text).toContain('продолжает действовать');
      expect(await ruleRow(rule.id)).toMatchObject({
        is_active: true, moderation_status: 'approved', removal_asked: false,
        moderation_reason: 'Скидка обещана туристам до конца месяца.',
      });
      expect(await multipliers(tour)).toEqual([0.85]);
      expect((await queue()).some((r) => r.id === rule.id)).toBe(false);

      // Снова попросили и одобрили: правило выключено, цена — базовая.
      await pool.query(`UPDATE tour_pricing_rules SET removal_requested_at = NOW() WHERE id = $1::bigint`, [rule.id]);
      const again = (await queue()).find((r) => r.id === rule.id)!;
      sent.alerts.length = 0;
      const off = await decide(rule.id, { action: 'approve', seen: again.seen });
      expect(off.body.message).toBe('«Очередь: снятие»: правило снято');
      expect(sent.alerts[0].text).toContain('Правило цены снято');
      expect(sent.alerts[0].text).toContain('больше не действует');
      expect(await ruleRow(rule.id)).toMatchObject({ is_active: false });
      expect(await multipliers(tour)).toEqual([]);
    });

    it('правило, отозванное владельцем или заменённое после показа карточки, по старой карточке не одобрить', async () => {
      const tour = await addTour('Очередь: гонка');
      const first = await addRule(tour, 0.9, { status: 'pending' });
      const card = (await queue()).find((r) => r.id === first.id)!;
      // Владелец поменял процент в том же правиле, пока карточка была открыта.
      await pool.query(`UPDATE tour_pricing_rules SET multiplier = 0.5 WHERE id = $1::bigint`, [first.id]);
      expect((await decide(first.id, { action: 'approve', seen: card.seen })).body.code).toBe('changed');
      expect(await multipliers(tour)).toEqual([]);
      // Владелец отозвал правило.
      await pool.query(`UPDATE tour_pricing_rules SET is_active = FALSE WHERE id = $1::bigint`, [first.id]);
      expect((await decide(first.id, { action: 'approve', seen: card.seen })).status).toBe(409);
      expect((await decide('999999999', { action: 'reject', reason: 'Нет такого правила.' })).status).toBe(404);
      expect((await decide('не-число', { action: 'reject', reason: 'Нет такого правила.' })).status).toBe(400);
    });

    it('в очереди только то, что ждёт решения: действующие, отклонённые и выключенные правила в неё не попадают', async () => {
      const tour = await addTour('Очередь: состав');
      const live = await addRule(tour, 0.9, { status: 'approved' });
      const rejected = await addRule(tour, 0.6, { status: 'rejected' });
      const off = await addRule(tour, 0.7, { status: 'pending', active: false });
      const waiting = await addRule(tour, 0.8, { status: 'pending' });
      const cards = (await queue()).filter((r) => r.tourId === tour);
      expect(cards.map((r) => r.id)).toEqual([waiting.id]);
      // «Заменит действующее» и цена «сейчас» — по действующему правилу, а не по отклонённому
      // или выключенному, хотя те записаны позже.
      expect(cards[0]).toMatchObject({
        replaces: 'Скидка на последние места: −10%, когда до выезда 7 дн. и меньше', priceNow: 18000, priceAfter: 16000,
      });
      for (const id of [live.id, rejected.id, off.id]) {
        expect((await decide(id, { action: 'reject', reason: 'Решать нечего.' })).status, id).toBe(409);
      }
    });

    it('одобрение правила одного рода не выключает действующее правило другого рода', async () => {
      const tour = await addTour('Очередь: два рода');
      const lastMinute = await addRule(tour, 0.9, { status: 'approved' });
      const group = await addRule(tour, 0.95, { status: 'pending' });
      await pool.query(
        `UPDATE tour_pricing_rules SET rule_type = 'group_discount', days_before_min = NULL, days_before_max = NULL, guests_min = 4 WHERE id = $1::bigint`,
        [group.id],
      );
      const card = (await queue()).find((r) => r.id === group.id)!;
      // Правила другого рода оно не заменяет.
      expect(card.replaces).toBeNull();
      expect((await decide(group.id, { action: 'approve', seen: card.seen })).status).toBe(200);
      expect(await ruleRow(lastMinute.id)).toMatchObject({ is_active: true, moderation_status: 'approved' });
      expect(await ruleRow(group.id)).toMatchObject({ is_active: true, moderation_status: 'approved' });
      expect(await multipliers(tour)).toEqual([0.9, 0.95]);
    });

    it('правило удалённого тура в очередь не попадает и не решается', async () => {
      const tour = await addTour('Очередь: удалённый тур');
      const waiting = await addRule(tour, 0.8, { status: 'pending' });
      const card = (await queue()).find((r) => r.id === waiting.id)!;
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1::bigint`, [tour]);
      expect((await queue()).some((r) => r.id === waiting.id)).toBe(false);
      sent.alerts.length = 0;
      expect((await decide(waiting.id, { action: 'approve', seen: card.seen })).status).toBe(404);
      expect(await ruleRow(waiting.id)).toMatchObject({ moderation_status: 'pending' });
      expect(sent.alerts).toHaveLength(0);
    });

    it('тур не на сайте: карточка так и говорит; одобрение без отпечатка не применяется и мимо роута', async () => {
      const tour = await addTour('Очередь: тур не на сайте', { published: false });
      const waiting = await addRule(tour, 0.8, { status: 'pending' });
      expect((await queue()).find((r) => r.id === waiting.id)).toMatchObject({ kind: 'new', tourOnSite: false });
      const published = await addTour('Очередь: тур на сайте');
      const other = await addRule(published, 0.8, { status: 'pending' });
      expect((await queue()).find((r) => r.id === other.id)).toMatchObject({ tourOnSite: true });
      // Схема роута требует отпечаток; прямой вызов решения без него тоже ничего не одобряет.
      const { decidePricingRule } = await import('@/lib/tours/pricing-rule-review');
      expect(await decidePricingRule({ id: waiting.id, action: 'approve', reason: null, moderatedBy: ADMIN, seen: null }))
        .toEqual({ outcome: 'changed' });
      expect(await ruleRow(waiting.id)).toMatchObject({ moderation_status: 'pending' });
      // Отказу отпечаток не нужен: цену он не меняет.
      const no = await decidePricingRule({ id: waiting.id, action: 'reject', reason: 'Проверка отказа без отпечатка.', moderatedBy: ADMIN, seen: null });
      expect(no.outcome).toBe('rejected');
      expect(await ruleRow(waiting.id)).toMatchObject({ moderation_status: 'rejected' });
    });
  });
});
