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
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, profile_status, is_public, max_chat_id)
       VALUES ($1, 'Оператор', 'operator', '{}'::jsonb, 'approved', TRUE, 555003)`,
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
  });
});
