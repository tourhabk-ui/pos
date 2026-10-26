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
 *     ни с адресатом, ни после удаления прокатчика, когда адресат обнулён;
 *   - посев «Лагуна Прокат» (1318) — поведением загрузчиков на настоящей
 *     схеме: перевозчик с двумя машинами и двумя тарифами за день разных
 *     видов, прокатчик с тремя машинами и условиями, оба — один партнёр;
 *     повтор 1318 ничего не плодит;
 *   - посев «Лагуна Экспедиция» (1323, слово владельца 23.10 «Сделай еще
 *     лагуна экспедиция и телефон такой же»): одна видимая карточка
 *     туроператора с реквизитами ООО «Экспедиция», телефон взят из строки
 *     «Лагуны Прокат», имён людей и аккаунта нет (репозиторий открытый, полное
 *     имя — ПД), список компаний её видит, повтор правку администратора не
 *     перетирает.
 *
 * Своя база `car_rental_test` — копия шаблона схемы, в котором доиграны ВСЕ
 * миграции каталога, то есть и посев 1318: партнёр `laguna-prokat` в базе
 * есть с самого начала, и фикстуры теста названы иначе, чтобы порядок по
 * имени не зависел от id. Без KERNEL_PG_TEST_URL файл честно пропускается —
 * «не прогнано», а не «прошло».
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
const SEED = join(process.cwd(), 'migrations', '1318_laguna_prokat_carrier_and_rental.sql');
const EXPEDITION_SEED = join(process.cwd(), 'migrations', '1323_laguna_expedition_operator_card.sql');

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
    // Не «Лагуна Прокат»: посев 1318 уже в шаблоне, и тёзка сделал бы порядок по имени делом id.
    partner.laguna = await addPartner('Прокат у залива', 'transfer', 'bay-rental');
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
    // Пять строк фикстур и три строки посева 1318 из шаблона.
    expect(rows[0]!.n).toBe(8);
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
    expect(companies.map((c) => c.slug)).toEqual(['laguna-prokat', 'op-rental', 'bay-rental']);
    const laguna = companies.find((c) => c.slug === 'bay-rental')!;
    expect(laguna.offers.map((o) => o.title)).toEqual(['Toyota Land Cruiser Prado', 'ГАЗ Соболь']);
    expect(laguna.offers[0]).toMatchObject({ seats: null, depositRub: 30000, driver: 'optional', priceIsFrom: false, pricesSeenOn: null });
    expect(laguna.offers[1]).toMatchObject({ seats: 7, priceIsFrom: true, depositRub: null });
    expect(laguna.phone).toBe('+79001112233');
    // Посев 1318 + 1319: у «Лагуны Прокат» обложка, галерея и снимок у каждой машины — с подписью.
    const seeded = companies.find((c) => c.slug === 'laguna-prokat')!;
    // Логотип — из 1320; у фикстур теста логотипа нет, и это честный null.
    expect(seeded.logo).toBe('/images/laguna-prokat/laguna-logo.png');
    expect(laguna.logo).toBeNull();
    expect(seeded.photos).toHaveLength(9);
    expect(seeded.photos[0]).toEqual({ url: '/images/laguna-prokat/laguna-fleet-tank300.jpg', credit: 'Лагуна Прокат' });
    expect(seeded.offers.map((o) => o.photo)).toEqual([
      { url: '/images/laguna-prokat/laguna-suzuki-jimny.jpg', credit: 'Лагуна Прокат' },
      { url: '/images/laguna-prokat/laguna-tank300-row.jpg', credit: 'Лагуна Прокат' },
      { url: '/images/laguna-prokat/laguna-sever-truck.jpg', credit: 'Лагуна Прокат' },
    ]);
    // Строка без снимка — null, не пустая строка и не выдуманный путь.
    expect(laguna.offers.map((o) => o.photo)).toEqual([null, null]);
  });

  it('loadRentalCompanyBySlug: условия, реквизиты, «также перевозчик»; скрытый и без живых строк — null', async () => {
    const { loadRentalCompanyBySlug, partnerHasRentalOffers } = await import('@/lib/rental/rental');
    const laguna = await loadRentalCompanyBySlug('bay-rental');
    expect(laguna).toMatchObject({
      name: 'Прокат у залива', verified: false, alsoCarrier: true,
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
    await lead('Арендатор', partner.laguna, { kind: 'car_rental', company_slug: 'bay-rental' }, PD_CONSENT_RENTAL_VERSION);
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

  it('посев 1318 «Лагуна Прокат»: перевозчик с двумя тарифами за день разных видов и прокатчик с тремя машинами — один партнёр', async () => {
    const { loadCarrierBySlug } = await import('@/lib/transfers/charter');
    const { loadRentalCompanyBySlug } = await import('@/lib/rental/rental');

    const carrier = await loadCarrierBySlug('laguna-prokat');
    expect(carrier).not.toBeNull();
    expect(carrier!.vehicles.map((v) => [v.kind, v.title, v.seats])).toEqual([
      ['minibus', 'Ford Transit', 17], ['vahtovka', 'Урал ГИРД (вахтовка)', 25],
    ]);
    expect(carrier!.destinations).toEqual([]);
    expect(carrier!.rates.map((r) => [r.unit, r.vehicleKind, r.priceRub, r.validYear])).toEqual([
      ['day', 'minibus', 25000, null], ['day', 'vahtovka', 50000, null],
    ]);
    expect(carrier!.rates.every((r) => r.note === 'цена «от» — точную назовёт перевозчик')).toBe(true);
    // Чего сайт не называл, того нет: юрлицо, лицензия. Отметка «проверен» —
    // по слову владельца 26.10 («лагуна дала добро», 1335).
    expect(carrier).toMatchObject({ legal: null, license: null, verified: true, phone: '+79060835070' });
    // 1319: обложка и галерея партнёра общие для перевозчика и прокатчика — девять кадров с подписью.
    expect(carrier.photos).toHaveLength(9);
    expect(carrier.logo).toBe('/images/laguna-prokat/laguna-logo.png');
    expect(carrier.photos[0]).toEqual({ url: '/images/laguna-prokat/laguna-fleet-tank300.jpg', credit: 'Лагуна Прокат' });
    expect(carrier.photos.map((ph) => ph.credit)).toEqual(Array(9).fill('Лагуна Прокат'));

    const rental = await loadRentalCompanyBySlug('laguna-prokat');
    expect(rental).not.toBeNull();
    expect(rental!.partnerId).toBe(carrier!.partnerId);
    expect(rental!.offers.map((o) => [o.title, o.seats, o.driver, o.priceRubPerDay, o.priceIsFrom, o.depositRub])).toEqual([
      ['Suzuki Jimny', 4, 'self', 7000, false, 15000],
      ['Tank-300', 5, 'self', 15000, false, 30000],
      ['Sever Truck', 8, 'optional', 35000, true, 50000],
    ]);
    expect(rental!.terms?.items).toHaveLength(8);
    expect(rental!.terms?.seenOn).toBe('2026-10-23');
    expect(rental).toMatchObject({ alsoCarrier: true, legal: null, verified: true });

    // Повтор посева на настоящей схеме ничего не плодит.
    const before = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM car_rental_offers)::int + (SELECT count(*) FROM transfer_charter_prices)::int
            + (SELECT count(*) FROM transfer_fleet_vehicles)::int + (SELECT count(*) FROM partners WHERE slug = 'laguna-prokat')::int AS n`,
    );
    await pool.query(readFileSync(SEED, 'utf8'));
    const after = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM car_rental_offers)::int + (SELECT count(*) FROM transfer_charter_prices)::int
            + (SELECT count(*) FROM transfer_fleet_vehicles)::int + (SELECT count(*) FROM partners WHERE slug = 'laguna-prokat')::int AS n`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  describe('посев 1323 «Лагуна Экспедиция»', () => {
    interface CardRow {
      name: string; category: string; is_public: boolean; is_verified: boolean; user_id: string | null;
      contact: Record<string, unknown>; contacts: Record<string, unknown>; legal_info: Record<string, unknown>;
      registry_number: string | null; website: string | null;
    }
    const card = async (): Promise<CardRow[]> => (await pool.query<CardRow>(
      `SELECT name, category, is_public, is_verified, user_id::text AS user_id,
              contact, contacts, legal_info, registry_number, website
         FROM partners WHERE slug = 'laguna-expedition' OR legal_info->>'inn' = '9717173941'`,
    )).rows;

    it('одна видимая карточка туроператора с реквизитами ООО «Экспедиция», без отметки «проверено»', async () => {
      const rows = await card();
      expect(rows).toHaveLength(1);
      const c = rows[0]!;
      expect(c).toMatchObject({ name: 'Лагуна Экспедиция', category: 'operator', is_public: true, is_verified: false });
      expect(c.legal_info).toEqual({
        companyName: 'ООО «Экспедиция»', inn: '9717173941', ogrn: '1247700802546',
        address: '127521, г. Москва, проезд 12-й Марьиной Рощи, д. 8, стр. 1',
      });
      expect(c.registry_number).toBe('РТО В031-00161-77/01703236');
      expect(c.website).toBe('https://laguna-expedition.ru');
      expect(c.contacts).toMatchObject({
        telegram_channel: 'https://t.me/laguna_expedition',
        website: 'https://laguna-expedition.ru',
        address: 'Паратунка, ул. Невельского, 6, на территории СПА-отеля «Лагуна», павильон «Река»',
      });
    });

    it('телефон — тот же, что у «Лагуны Прокат», и на витрине, и в админке', async () => {
      const { rows: [lp] } = await pool.query<{ contacts: Record<string, unknown> }>(
        `SELECT contacts FROM partners WHERE slug = 'laguna-prokat'`,
      );
      expect(typeof lp?.contacts.phone).toBe('string');
      const [c] = await card();
      expect(c!.contacts.phone).toBe(lp!.contacts.phone);
      expect(c!.contact.phone).toBe(lp!.contacts.phone);
      expect(c!.contacts.telegram_contact).toBe(lp!.contacts.telegram_contact);
    });

    it('имён людей и аккаунта нет: аккаунт на имя заводит владелец из админки', async () => {
      const [c] = await card();
      expect(c!.user_id).toBeNull();
      for (const field of [c!.contact, c!.contacts]) {
        expect(Object.keys(field).filter((k) => /name/i.test(k))).toEqual([]);
      }
    });

    it('список компаний /operators видит её — тем же правилом, что у страницы', async () => {
      const { queryOperators, OperatorsQuerySchema } = await import('@/lib/operators/list-query');
      const res = await queryOperators(OperatorsQuerySchema.parse({ search: 'Лагуна', limit: 50 }));
      expect(res.items.map((i) => i.name)).toContain('Лагуна Экспедиция');
    });

    it('повтор миграции ничего не плодит и правку администратора не перетирает', async () => {
      await pool.query(`UPDATE partners SET short_description = 'Правка администратора' WHERE slug = 'laguna-expedition'`);
      await pool.query(readFileSync(EXPEDITION_SEED, 'utf8'));
      expect(await card()).toHaveLength(1);
      const { rows: [r] } = await pool.query<{ short_description: string }>(
        `SELECT short_description FROM partners WHERE slug = 'laguna-expedition'`,
      );
      expect(r!.short_description).toBe('Правка администратора');
    });

    // Последним: портит телефон «Лагуны Прокат» в базе этого файла.
    it('у «Лагуны Прокат» нет телефона — карточки без связи не будет', async () => {
      await pool.query(`DELETE FROM partners WHERE slug = 'laguna-expedition'`);
      await pool.query(`UPDATE partners SET contacts = contacts - 'phone' WHERE slug = 'laguna-prokat'`);
      await pool.query(readFileSync(EXPEDITION_SEED, 'utf8'));
      expect(await card()).toHaveLength(0);
    });
  });

  it('календарь 1325: отметку пишет только хозяин машины, чужой источник не проходит', async () => {
    const file = join(process.cwd(), 'migrations', '1325_rental_car_busy.sql');
    await pool.query(readFileSync(file, 'utf8'));
    await pool.query(readFileSync(file, 'utf8'));
    const { rows: [offer] } = await pool.query<{ id: string; partner_id: string }>(
      `SELECT o.id::text AS id, o.partner_id::text AS partner_id
         FROM car_rental_offers o
         JOIN partners p ON p.id = o.partner_id
        WHERE p.slug = 'laguna-prokat' AND o.title = 'Suzuki Jimny'`,
    );
    expect(offer?.id).toBeTruthy();
    const { setOperatorMark, loadCalendarMarks } = await import('@/lib/rental/car-calendar-store');
    const day = '2026-11-01';
    expect(await setOperatorMark(offer!.partner_id, offer!.id, day, true)).toBe('saved');
    expect(await setOperatorMark('00000000-0000-4000-8000-000000000099', offer!.id, day, false)).toBe('not_yours');
    const marks = await loadCalendarMarks(offer!.id, day, day);
    expect(marks).not.toBe('db_error');
    if (marks === 'db_error') return;
    expect(marks.get(day)).toBe(true);
    expect(await setOperatorMark(offer!.partner_id, offer!.id, day, false)).toBe('saved');
    const cleared = await loadCalendarMarks(offer!.id, day, day);
    expect(cleared).not.toBe('db_error');
    if (cleared === 'db_error') return;
    expect(cleared.get(day)).toBe(false);
    const { rows: count } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rental_car_busy WHERE offer_id = $1 AND day = $2::date`,
      [offer!.id, day],
    );
    expect(count[0]?.n).toBe(1);
    expect(await sqlState(pool.query(
      `INSERT INTO rental_car_busy (offer_id, day, busy, source) VALUES ($1, '2026-11-02', true, 'nope')`,
      [offer!.id],
    ))).toBe('23514');
  });

  it('«Беру» отмечает дни заявки source=request и пишет журнал; чужая машина — нет', async () => {
    const { rows: [offer] } = await pool.query<{ id: string; partner_id: string }>(
      `SELECT o.id::text AS id, o.partner_id::text AS partner_id
         FROM car_rental_offers o
         JOIN partners p ON p.id = o.partner_id
        WHERE p.slug = 'laguna-prokat' AND o.title = 'Suzuki Jimny'`,
    );
    expect(offer?.id).toBeTruthy();
    const { rows: [lead] } = await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, created_at)
       VALUES ('Заказчик', '+79990001122', 'тест', 'new', $1, $2::jsonb, NOW())
       RETURNING id::text AS id`,
      [offer!.partner_id, JSON.stringify({
        kind: 'car_rental', company_id: offer!.partner_id, offer_id: offer!.id,
        offer_title: 'Suzuki Jimny', date_from: '2026-11-10', date_to: '2026-11-12',
      })],
    );
    const {
      claimPartnerAnswer, loadOwnedRentalRequest, readPartnerAnswer,
    } = await import('@/lib/rental/request-answer-store');
    const loaded = await loadOwnedRentalRequest(offer!.partner_id, lead!.id);
    expect(loaded.outcome).toBe('ok');
    if (loaded.outcome !== 'ok') return;
    expect(loaded.request.offerId).toBe(offer!.id);
    expect(await readPartnerAnswer(lead!.id)).toBe('none');
    const claim = {
      leadId: lead!.id,
      partnerId: offer!.partner_id,
      offerId: offer!.id,
      carTitle: 'Suzuki Jimny',
      dateFrom: '2026-11-10',
      dateTo: '2026-11-12',
      mark: { offerId: offer!.id, dateFrom: '2026-11-10', dateTo: '2026-11-12' },
    };
    const [first, second] = await Promise.all([
      claimPartnerAnswer({ ...claim, answer: 'take' }),
      claimPartnerAnswer({ ...claim, answer: 'take' }),
    ]);
    expect([first, second].filter((r) => r.outcome === 'saved')).toEqual([{ outcome: 'saved', marked: 3 }]);
    expect([first, second].filter((r) => r.outcome === 'already')).toEqual([{ outcome: 'already', answer: 'take' }]);
    expect(await readPartnerAnswer(lead!.id)).toBe('take');
    expect(await claimPartnerAnswer({ ...claim, answer: 'decline' })).toEqual({ outcome: 'already', answer: 'take' });
    const { rows: busy } = await pool.query<{ day: string; source: string; lead_id: string; busy: boolean }>(
      `SELECT day::text AS day, source, lead_id::text AS lead_id, busy
         FROM rental_car_busy WHERE offer_id = $1 AND day >= '2026-11-10' AND day <= '2026-11-12'
         ORDER BY day`,
      [offer!.id],
    );
    expect(busy.map((r) => r.day)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(busy.every((r) => r.busy && r.source === 'request' && r.lead_id === lead!.id)).toBe(true);
    const { rows: answers } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lead_activity_log WHERE lead_id = $1 AND action = 'partner_answered'`,
      [lead!.id],
    );
    expect(answers[0]?.n).toBe(1);
    expect(await loadOwnedRentalRequest('00000000-0000-4000-8000-000000000099', lead!.id)).toEqual({ outcome: 'not_yours' });
  });

  it('черновик цены и описания не меняет прайс; одобрение меняет, отказ — нет', async () => {
    const { rows: [jimny] } = await pool.query<{
      id: string; partner_id: string; price: number; conditions: string | null;
    }>(
      `SELECT o.id::text AS id, o.partner_id::text AS partner_id,
              o.price_rub_per_day AS price, o.conditions
         FROM car_rental_offers o
         JOIN partners p ON p.id = o.partner_id
        WHERE p.slug = 'laguna-prokat' AND o.title = 'Suzuki Jimny'`,
    );
    expect(jimny?.price).toBe(7000);
    expect(jimny?.conditions).toBeNull();
    const {
      findOwnedOffer, savePendingOfferEdit, decideOfferEdit,
    } = await import('@/lib/rental/offer-edit-store');
    const found = await findOwnedOffer(jimny!.partner_id, 'suzuki jimny');
    expect(found.outcome).toBe('one');
    if (found.outcome !== 'one') return;
    expect(await savePendingOfferEdit({
      partnerId: jimny!.partner_id, offer: found.offer, priceRub: 8500, conditions: null,
    })).toMatchObject({ outcome: 'saved', draftPrice: 8500, draftConditions: null });
    expect(await savePendingOfferEdit({
      partnerId: jimny!.partner_id, offer: found.offer, priceRub: null, conditions: 'Без ограничения пробега по асфальту',
    })).toMatchObject({
      outcome: 'saved', draftPrice: 8500, draftConditions: 'Без ограничения пробега по асфальту',
    });
    const mid = await pool.query<{ price_rub_per_day: number; conditions: string | null }>(
      `SELECT price_rub_per_day, conditions FROM car_rental_offers WHERE id = $1`,
      [jimny!.id],
    );
    expect(mid.rows[0]).toEqual({ price_rub_per_day: 7000, conditions: null });
    const { rows: pending } = await pool.query<{ id: string; n: number }>(
      `SELECT id::text AS id, count(*) OVER ()::int AS n
         FROM rental_offer_edits WHERE offer_id = $1 AND moderation_status = 'pending'`,
      [jimny!.id],
    );
    expect(pending).toHaveLength(1);
    // Модератор открыл карточку после первой правки (8 500, без описания), а
    // описание пришло в ту же строку позже: одобрение увиденного — «изменился».
    expect(await decideOfferEdit({
      id: pending[0]!.id, action: 'approve', reason: null, moderatedBy: null,
      seen: { price: 8500, conditions: null },
    })).toEqual({ outcome: 'changed' });
    const stale = await pool.query<{ price_rub_per_day: number; conditions: string | null; status: string }>(
      `SELECT o.price_rub_per_day, o.conditions, e.moderation_status AS status
         FROM car_rental_offers o JOIN rental_offer_edits e ON e.offer_id = o.id
        WHERE e.id = $1`,
      [pending[0]!.id],
    );
    expect(stale.rows[0]).toEqual({ price_rub_per_day: 7000, conditions: null, status: 'pending' });
    expect(await decideOfferEdit({
      id: pending[0]!.id, action: 'approve', reason: null, moderatedBy: null,
      seen: { price: 8500, conditions: 'Без ограничения пробега по асфальту' },
    })).toMatchObject({ outcome: 'approved', title: 'Suzuki Jimny' });
    const after = await pool.query<{ price_rub_per_day: number; conditions: string | null }>(
      `SELECT price_rub_per_day, conditions FROM car_rental_offers WHERE id = $1`,
      [jimny!.id],
    );
    expect(after.rows[0]).toEqual({
      price_rub_per_day: 8500, conditions: 'Без ограничения пробега по асфальту',
    });
    expect(await decideOfferEdit({
      id: pending[0]!.id, action: 'reject', reason: 'повтор', moderatedBy: null, seen: null,
    })).toEqual({ outcome: 'already' });
    const still = await pool.query<{ price_rub_per_day: number; conditions: string | null }>(
      `SELECT price_rub_per_day, conditions FROM car_rental_offers WHERE id = $1`,
      [jimny!.id],
    );
    expect(still.rows[0]).toEqual({
      price_rub_per_day: 8500, conditions: 'Без ограничения пробега по асфальту',
    });

    const { rows: [tank] } = await pool.query<{ id: string; partner_id: string }>(
      `SELECT o.id::text AS id, o.partner_id::text AS partner_id
         FROM car_rental_offers o
         JOIN partners p ON p.id = o.partner_id
        WHERE p.slug = 'laguna-prokat' AND o.title = 'Tank-300'`,
    );
    const tankFound = await findOwnedOffer(tank!.partner_id, 'Tank-300');
    expect(tankFound.outcome).toBe('one');
    if (tankFound.outcome !== 'one') return;
    expect(await savePendingOfferEdit({
      partnerId: tank!.partner_id, offer: tankFound.offer, priceRub: 16000, conditions: null,
    })).toMatchObject({ outcome: 'saved', draftPrice: 16000 });
    const { rows: [tankEdit] } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM rental_offer_edits WHERE offer_id = $1 AND moderation_status = 'pending'`,
      [tank!.id],
    );
    expect(await decideOfferEdit({
      id: tankEdit!.id, action: 'reject', reason: 'не та цифра', moderatedBy: null, seen: null,
    })).toMatchObject({ outcome: 'rejected' });
    const tankLive = await pool.query<{ price_rub_per_day: number }>(
      `SELECT price_rub_per_day FROM car_rental_offers WHERE id = $1`,
      [tank!.id],
    );
    expect(tankLive.rows[0]?.price_rub_per_day).toBe(15000);

    expect(await findOwnedOffer(partner.operatorWithPrice, 'Suzuki Jimny')).toEqual({ outcome: 'missing' });
    expect(await sqlState(pool.query(
      `INSERT INTO rental_offer_edits (offer_id, partner_id, price_rub_per_day) VALUES ($1, $2, 0)`,
      [jimny!.id, jimny!.partner_id],
    ))).toBe('23514');
    expect(await sqlState(pool.query(
      `INSERT INTO rental_offer_edits (offer_id, partner_id) VALUES ($1, $2)`,
      [jimny!.id, jimny!.partner_id],
    ))).toBe('23514');
  });
});
