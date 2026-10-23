/**
 * Прокат автомобилей на настоящем PostgreSQL (схема 1317, решение владельца
 * 23.10 «пока берем аренду автомобилей и трансфер»).
 *
 * Мок ответил бы на любой SQL; здесь решает сервер:
 *   - миграция 1317 применяется повторно без ошибки (ограничения
 *     пересоздаются по имени, таблицы и индекс IF NOT EXISTS);
 *   - CHECK отвергают места 0, водителя 'included', кузов 'bus', цену 0 и
 *     условия с пустым списком; UNIQUE (partner_id, title) — вторую строку с
 *     тем же названием;
 *   - loadRentalCompanies видит партнёра только с активной строкой прайса и
 *     не спрашивает категорию: оператор с прайсом — прокатчик, партнёр
 *     категории cars без живой строки — нет, непубличный — нет;
 *   - loadRentalCompanyBySlug читает условия, реквизиты и признак «также
 *     перевозчик» тем же запросом; partnerHasRentalOffers — три исхода у
 *     вызывающего;
 *   - отбор добивки лидов (FOLLOWUP_LEADS_SQL) не берёт заявку на прокат —
 *     ни с адресатом, ни после удаления прокатчика, когда адресат обнулён.
 *
 * Своя база `car_rental_test` — копия шаблона схемы. Без KERNEL_PG_TEST_URL
 * файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PD_CONSENT_RENTAL_VERSION } from '@/lib/legal/pd-consent';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[car-rental.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'car_rental_test';
const MIGRATION = join(process.cwd(), 'migrations', '1317_car_rental_offers.sql');

withPg('прокат автомобилей на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const partner = { operatorWithPrice: '', carsInactive: '', hidden: '', laguna: '' };

  const sqlState = async (p: Promise<unknown>): Promise<string | null> => {
    try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'без кода'; }
  };

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    const addPartner = async (name: string, category: string, slug: string, isPublic = true) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, contacts, is_verified, is_public, slug, short_description, legal_info)
         VALUES ($1, $2, '{"phone":"+70000000000"}', '{"phone":"+7 900 111-22-33"}', FALSE, $4, $3, 'Машины без водителя',
                 '{"companyName":"ИП Лагунова Анна Петровна","inn":"410100000011"}'::jsonb) RETURNING id`,
        [name, category, slug, isPublic],
      );
      return r.rows[0].id;
    };
    const addOffer = (partnerId: string, title: string, over: Record<string, unknown> = {}) => pool.query(
      `INSERT INTO car_rental_offers (partner_id, title, body_kind, seats, price_rub_per_day, price_is_from, deposit_rub, driver, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        // `seats: null` — «не записано» и обязано дойти до базы как NULL, а не замениться умолчанием.
        partnerId, title, over.body_kind ?? 'suv', 'seats' in over ? over.seats : 5, over.price_rub_per_day ?? 7000,
        over.price_is_from ?? false, over.deposit_rub ?? null, over.driver ?? 'self', over.is_active ?? true,
      ],
    );

    partner.operatorWithPrice = await addPartner('Оператор с прокатом', 'operator', 'op-rental');
    await addOffer(partner.operatorWithPrice, 'УАЗ Патриот', { body_kind: 'suv', seats: 5, price_rub_per_day: 5000 });
    partner.carsInactive = await addPartner('Прокат без живых строк', 'cars', 'cars-inactive');
    await addOffer(partner.carsInactive, 'Снятая машина', { is_active: false });
    partner.hidden = await addPartner('Скрытый прокат', 'cars', 'cars-hidden', false);
    await addOffer(partner.hidden, 'Скрытая машина');
    partner.laguna = await addPartner('Лагуна Прокат', 'transfer', 'laguna');
    await addOffer(partner.laguna, 'Toyota Land Cruiser Prado', { seats: null, price_rub_per_day: 7000, deposit_rub: 30000, driver: 'optional' });
    await addOffer(partner.laguna, 'ГАЗ Соболь', { body_kind: 'minibus', seats: 7, price_rub_per_day: 25000, price_is_from: true });
    await pool.query(
      `INSERT INTO car_rental_terms (partner_id, items, seen_on) VALUES ($1, $2::text[], '2026-10-23')`,
      [partner.laguna, ['Залог возвращается при возврате машины без повреждений', 'Выдача в городе']],
    );
    // «Лагуна» возит и целой машиной с водителем — прайс перевозчика (1185).
    await pool.query(
      `INSERT INTO transfer_charter_prices (partner_id, vehicle_kind, line_kind, from_text, to_text, price_rub)
       VALUES ($1, 'vahtovka', 'destination', 'Петропавловск-Камчатский', 'Вулкан Горелый', 75000)`,
      [partner.laguna],
    );
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('миграция 1317 применяется повторно без ошибки, данные остаются', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM car_rental_offers');
    expect(rows[0]!.n).toBe(5);
    const cons = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'car_rental_offers'::regclass ORDER BY conname`,
    );
    expect(cons.rows.map((r) => r.conname)).toContain('car_rental_offers_partner_title');
    expect(cons.rows.filter((r) => r.conname === 'car_rental_offers_driver_check')).toHaveLength(1);
  });

  it('CHECK отвергают места 0, водителя included, кузов bus, цену 0, условия с пустым списком; UNIQUE — повтор названия', async () => {
    const insert = (over: Record<string, unknown>) => pool.query(
      `INSERT INTO car_rental_offers (partner_id, title, body_kind, seats, price_rub_per_day, driver)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [partner.laguna, over.title ?? 'Проба', over.body_kind ?? 'car', over.seats ?? null, over.price_rub_per_day ?? 1000, over.driver ?? 'self'],
    );
    expect(await sqlState(insert({ seats: 0 }))).toBe('23514');
    expect(await sqlState(insert({ driver: 'included' }))).toBe('23514');
    expect(await sqlState(insert({ body_kind: 'bus' }))).toBe('23514');
    expect(await sqlState(insert({ price_rub_per_day: 0 }))).toBe('23514');
    expect(await sqlState(insert({ title: 'ГАЗ Соболь' }))).toBe('23505');
    expect(await sqlState(pool.query(
      `INSERT INTO car_rental_terms (partner_id, items) VALUES ($1, '{}'::text[])`, [partner.operatorWithPrice],
    ))).toBe('23514');
    // Положительный контроль: правильная строка проходит — отказы выше не от чужой причины.
    expect(await sqlState(insert({ title: 'Проба верная', seats: 4 }))).toBeNull();
    await pool.query(`DELETE FROM car_rental_offers WHERE title = 'Проба верная'`);
  });

  it('loadRentalCompanies: только партнёр с активной строкой, категория не спрашивается, порядок по алфавиту', async () => {
    const { loadRentalCompanies } = await import('@/lib/rental/rental');
    const companies = await loadRentalCompanies();
    expect(companies.map((c) => c.slug)).toEqual(['laguna', 'op-rental']);
    const laguna = companies.find((c) => c.slug === 'laguna')!;
    expect(laguna.offers.map((o) => o.title)).toEqual(['Toyota Land Cruiser Prado', 'ГАЗ Соболь']);
    expect(laguna.offers[0]).toMatchObject({ seats: null, depositRub: 30000, driver: 'optional', priceIsFrom: false, pricesSeenOn: null });
    expect(laguna.offers[1]).toMatchObject({ seats: 7, priceIsFrom: true, depositRub: null });
    expect(laguna.phone).toBe('+79001112233');
  });

  it('loadRentalCompanyBySlug: условия, реквизиты, «также перевозчик»; скрытый и без живых строк — null', async () => {
    const { loadRentalCompanyBySlug, partnerHasRentalOffers } = await import('@/lib/rental/rental');
    const laguna = await loadRentalCompanyBySlug('laguna');
    expect(laguna).toMatchObject({
      name: 'Лагуна Прокат', verified: false, alsoCarrier: true,
      legal: { name: 'ИП Лагунова Анна Петровна', inn: '410100000011', ogrn: null },
      terms: { items: ['Залог возвращается при возврате машины без повреждений', 'Выдача в городе'], sourceUrl: null, seenOn: '2026-10-23' },
    });
    const op = await loadRentalCompanyBySlug('op-rental');
    expect(op).toMatchObject({ alsoCarrier: false, terms: null });
    expect(await loadRentalCompanyBySlug('cars-inactive')).toBeNull();
    expect(await loadRentalCompanyBySlug('cars-hidden')).toBeNull();
    expect(await partnerHasRentalOffers(partner.laguna)).toBe(true);
    expect(await partnerHasRentalOffers(partner.carsInactive)).toBe(false);
  });

  it('отбор добивки не берёт заявку на прокат — с адресатом и после удаления прокатчика', async () => {
    const lead = async (name: string, operatorId: string | null, sourceData: object, consent: string | null) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, created_at, pd_consent_version)
         VALUES ($1, '+79990001122', 'тест', 'new', $2, $3::jsonb, NOW() - INTERVAL '3 hours', $4) RETURNING id::text AS id`,
        [name, operatorId, JSON.stringify(sourceData), consent],
      );
      return r.rows[0].id;
    };
    const plain = await lead('Без адресата', null, { interests: ['hiking'] }, null);
    await lead('Арендатор', partner.laguna, { kind: 'car_rental', company_slug: 'laguna' }, PD_CONSENT_RENTAL_VERSION);
    const doomed = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Прокат на удаление', 'cars', '{"phone":"+70000000000"}', FALSE, TRUE, 'cars-doomed') RETURNING id`,
    );
    const orphanId = await lead('Прокат удалённого', doomed.rows[0].id, { kind: 'car_rental' }, PD_CONSENT_RENTAL_VERSION);
    // Только по версии согласия, без kind: второй замок срабатывает и один.
    await lead('Только согласие прокату', null, {}, PD_CONSENT_RENTAL_VERSION);
    await pool.query(`DELETE FROM partners WHERE id = $1`, [doomed.rows[0].id]);
    const orphan = await pool.query<{ operator_id: string | null }>(`SELECT operator_id::text AS operator_id FROM leads WHERE id = $1`, [orphanId]);
    expect(orphan.rows[0]?.operator_id).toBeNull();

    const { FOLLOWUP_LEADS_SQL, FOLLOWUP_LEADS_PARAMS } = await import('@/lib/leads/followup-scope');
    const { rows } = await pool.query<{ id: string }>(FOLLOWUP_LEADS_SQL, [...FOLLOWUP_LEADS_PARAMS]);
    expect(rows.map((r) => r.id)).toEqual([plain]);
  });
});
