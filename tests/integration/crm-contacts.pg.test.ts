/**
 * Клиент партнёра на настоящем PostgreSQL (CRM фаза 1, шаг 1а, #2325).
 *
 * Склейка держится на частичных уникальных индексах и на порядке поиска
 * «телефон → почта → аккаунт»; мок на любой текст отвечает `{rows: []}` и
 * такого не проверит (§4.0 «судить статикой запрещено»). Здесь каждый SQL
 * источника, задела, списка и карточки ИСПОЛНЯЕТСЯ на схеме из baseline прода
 * + всех миграций — тем же путём, что у деплоя.
 *
 * Своя база `crm_contacts_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  SOURCE_KINDS, UNLINKED_COUNT_SQL, UNLINKED_PAGE_SQL, cursorStart, linkContactFromSource,
  type SourceKind,
} from '@/lib/crm/contacts';
import {
  createManualContact, getContactCard, listContacts, updateContact,
} from '@/lib/crm/contact-queries';
import { partnerContextFor } from '@/lib/crm/partner-context';
import { getContactCardForAdmin, listAllContacts } from '@/lib/crm/admin-queries';
import { addContactTouch, listContactEvents, recordSourceEvent, statusChangeTitle } from '@/lib/crm/events';
import { completeTask, createTask, deleteTask, listTasks, updateTask } from '@/lib/crm/tasks';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[crm-contacts.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'crm_contacts_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('клиент партнёра на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const P: Record<'opA' | 'opB' | 'stay' | 'gear' | 'carrier' | 'agent' | 'guide', string> = {
    opA: '', opB: '', stay: '', gear: '', carrier: '', agent: '', guide: '',
  };
  let touristId = '';
  let agentUserId = '';
  let tourA = 0;
  let tourB = 0;
  let accommodationId = '';
  let gearId = '';
  let tripId = '';

  const link = (kind: SourceKind, id: string | number) => linkContactFromSource(kind, String(id), pool);

  async function booking(tour: number, f: {
    name?: string | null; phone?: string | null; email?: string | null; userId?: string | null;
    consent?: boolean; guide?: string | null; deleted?: boolean;
  }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings
         (operator_tour_id, booking_date, participants, tourist_name, tourist_phone, tourist_email, user_id,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version, guide_partner_id, deleted_at)
       VALUES ($1, CURRENT_DATE + 10, 2, $2, $3, $4, $5,
               CASE WHEN $6::boolean THEN NOW() END, CASE WHEN $6::boolean THEN '10.0.0.1' END,
               CASE WHEN $6::boolean THEN 'booking-form' END, CASE WHEN $6::boolean THEN '2026-10-08' END,
               $7, CASE WHEN $8::boolean THEN NOW() END)
       RETURNING id::text`,
      [tour, f.name ?? null, f.phone ?? null, f.email ?? null, f.userId ?? null,
       f.consent === true, f.guide ?? null, f.deleted === true],
    );
    return r.rows[0].id;
  }

  async function contactsOf(partnerId: string) {
    const r = await pool.query<{
      id: string; display_name: string | null; phone_e164: string | null; email_norm: string | null;
      user_id: string | null; origin: string; pd_consent_at: Date | null; pd_consent_source: string | null;
    }>(
      `SELECT id, display_name, phone_e164, email_norm, user_id, origin, pd_consent_at, pd_consent_source
         FROM crm_contacts WHERE partner_id = $1 ORDER BY created_at, id`,
      [partnerId],
    );
    return r.rows;
  }

  async function linksOf(contactId: string): Promise<string[]> {
    const r = await pool.query<{ k: string }>(
      `SELECT source_kind || ':' || source_id AS k FROM crm_contact_links WHERE contact_id = $1 ORDER BY id`,
      [contactId],
    );
    return r.rows.map((x) => x.k);
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 6 });
    // Порог сравнивается ЧИСЛОМ: `'1000_...' >= '863'` в тексте ложно.
    await pool.query(
      `DELETE FROM _migrations
        WHERE (substring(name from '^[0-9]+'))::bigint >= $1
           OR substring(name from '^[0-9]+') IS NULL`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    const users = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, phone) VALUES
         ('Tourist@Example.com', 'Аккаунт Туриста', 'x', 'tourist', '+79995550000'),
         ('agent@example.com', 'Агент', 'x', 'agent', NULL)
       RETURNING id`,
    );
    touristId = users.rows[0].id;
    agentUserId = users.rows[1].id;

    const partner = async (name: string, category: string, userId: string | null = null) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, user_id) VALUES ($1, $2, '{}', $3) RETURNING id`,
        [name, category, userId],
      )).rows[0].id;
    P.opA = await partner('Оператор А', 'operator');
    P.opB = await partner('Оператор Б', 'operator');
    P.stay = await partner('Гостиница', 'stay');
    P.gear = await partner('Прокат', 'gear');
    P.carrier = await partner('Перевозчик', 'transfer');
    P.guide = await partner('Гид', 'guide');
    P.agent = await partner('Агент', 'agent', agentUserId);
    await pool.query(`UPDATE partners SET profile_status = 'approved' WHERE id = $1`, [P.agent]);

    const tour = async (operatorId: string, title: string) =>
      Number((await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, base_price) VALUES ($1, $2, 5000) RETURNING id`,
        [operatorId, title],
      )).rows[0].id);
    tourA = await tour(P.opA, 'Тур А');
    tourB = await tour(P.opB, 'Тур Б');

    accommodationId = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, moderation_status)
       VALUES ($1, 'Гостиница у вулкана', 'hotel', '{"lat":53,"lng":158}', 'approved') RETURNING id`, [P.stay],
    )).rows[0].id;
    gearId = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, moderation_status)
       VALUES ($1, 'Палатка', 'tents', 500, 'approved') RETURNING id`, [P.gear],
    )).rows[0].id;
    const vehicle = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats)
       VALUES ($1, 'vahtovka', 'ГАЗ-66', 12) RETURNING id`, [P.carrier],
    )).rows[0].id;
    tripId = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total)
       VALUES ($1, CURRENT_DATE + 5, 'Елизово', 'Мутновский', 10) RETURNING id`, [vehicle],
    )).rows[0].id;
  }, 300_000);

  // Пул приложения тест не трогает: каждой функции передаётся свой.
  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('бронь тура: контакт оператора, телефон в E.164, согласие скопировано', async () => {
    const id = await booking(tourA, { name: 'Анна', phone: '8 (914) 111-22-33', consent: true });
    const r = await link('operator_booking', id);
    expect(r).toMatchObject({ outcome: 'linked', partnerId: P.opA, created: true });
    const [c] = await contactsOf(P.opA);
    expect(c).toMatchObject({
      display_name: 'Анна', phone_e164: '+79141112233', origin: 'operator_booking', pd_consent_source: 'booking-form',
    });
    expect(c.pd_consent_at).not.toBeNull();
    expect(await linksOf(c.id)).toEqual([`operator_booking:${id}`]);
  });

  it('тот же телефон в другой записи — тот же человек; имя не перетирается', async () => {
    const id = await booking(tourA, { name: 'Анна Петрова', phone: '+7 914 111 22 33' });
    const r = await link('operator_booking', id);
    expect(r).toMatchObject({ outcome: 'linked', created: false });
    const list = await contactsOf(P.opA);
    expect(list).toHaveLength(1);
    expect(list[0].display_name).toBe('Анна');
    expect(await linksOf(list[0].id)).toHaveLength(2);
  });

  it('лид оператора с тем же телефоном — к тому же контакту, согласие не перезаписывается', async () => {
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, operator_id, pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ('Аня', '89141112233', $1, NOW(), '10.0.0.2', 'lead-form', '2026-10-08') RETURNING id`, [P.opA],
    )).rows[0].id;
    expect(await link('lead', lead)).toMatchObject({ outcome: 'linked', created: false });
    const [c] = await contactsOf(P.opA);
    expect(c.pd_consent_source).toBe('booking-form');
  });

  it('свой лид владельца и лид без оператора клиентом не становятся', async () => {
    const own = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, operator_id, is_self) VALUES ('Проба', '+79140000001', $1, TRUE) RETURNING id`, [P.opA],
    )).rows[0].id;
    const platform = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone) VALUES ('Платформе', '+79140000002') RETURNING id`,
    )).rows[0].id;
    expect(await link('lead', own)).toEqual({ outcome: 'no_source' });
    expect(await link('lead', platform)).toEqual({ outcome: 'no_source' });
  });

  it('между партнёрами контакты не склеиваются', async () => {
    const id = await booking(tourB, { name: 'Анна', phone: '+79141112233' });
    expect(await link('operator_booking', id)).toMatchObject({ outcome: 'linked', partnerId: P.opB, created: true });
    expect(await contactsOf(P.opB)).toHaveLength(1);
    expect(await contactsOf(P.opA)).toHaveLength(1);
  });

  it('сперва почта, потом телефон с той же почтой — один контакт, телефон дописан', async () => {
    const byEmail = await booking(tourA, { name: 'Борис', email: 'Boris@Mail.ru' });
    const first = await link('operator_booking', byEmail);
    expect(first).toMatchObject({ outcome: 'linked', created: true });
    const withPhone = await booking(tourA, { name: 'Борис', phone: '+79142223344', email: 'boris@mail.ru' });
    const second = await link('operator_booking', withPhone);
    expect(second).toMatchObject({ outcome: 'linked', created: false });
    if (first.outcome !== 'linked' || second.outcome !== 'linked') throw new Error('не привязано');
    expect(second.contactId).toBe(first.contactId);
    const c = (await contactsOf(P.opA)).find((x) => x.id === first.contactId);
    expect(c).toMatchObject({ phone_e164: '+79142223344', email_norm: 'boris@mail.ru' });
  });

  it('оператор: брони сказать нечего — имя, телефон и почта из аккаунта туриста', async () => {
    const id = await booking(tourA, { userId: touristId });
    const r = await link('operator_booking', id);
    expect(r).toMatchObject({ outcome: 'linked', created: true });
    if (r.outcome !== 'linked') throw new Error('не привязано');
    const c = (await contactsOf(P.opA)).find((x) => x.id === r.contactId);
    expect(c).toMatchObject({
      user_id: touristId, phone_e164: '+79995550000', email_norm: 'tourist@example.com', display_name: 'Аккаунт Туриста',
    });
  });

  it('оператор: поле брони важнее аккаунта', async () => {
    const id = await booking(tourA, { userId: touristId, name: 'Турист под поездку', phone: '+79140000303' });
    const r = await link('operator_booking', id);
    if (r.outcome !== 'linked') throw new Error('не привязано');
    const c = (await contactsOf(P.opA)).find((x) => x.id === r.contactId);
    expect(c).toMatchObject({ phone_e164: '+79140000303', display_name: 'Турист под поездку' });
  });

  it('назначенный гид контакта не получает: доступ гида к туристу временный', async () => {
    const id = await booking(tourA, { name: 'Вера', phone: '+79143334455', guide: P.guide });
    expect(await link('operator_booking', id)).toMatchObject({ outcome: 'linked', partnerId: P.opA });
    expect(await contactsOf(P.guide)).toEqual([]);
  });

  it('удалённая бронь и бронь без единой приметы', async () => {
    const deleted = await booking(tourA, { name: 'Удалённая', phone: '+79145556677', deleted: true });
    expect(await link('operator_booking', deleted)).toEqual({ outcome: 'no_source' });
    const blank = await booking(tourA, {});
    expect(await link('operator_booking', blank)).toEqual({ outcome: 'no_contact' });
  });

  it('жильё: имя, телефон и почта аккаунта гостя — как в уведомлении о брони', async () => {
    const ab = (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings
         (user_id, accommodation_id, check_in_date, check_out_date, nights, adults, room_price_per_night, total_price)
       VALUES ($1, $2, CURRENT_DATE + 3, CURRENT_DATE + 5, 2, 2, 4000, 8000) RETURNING id`,
      [touristId, accommodationId],
    )).rows[0].id;
    expect(await link('accommodation_booking', ab)).toMatchObject({ outcome: 'linked', partnerId: P.stay, created: true });
    const [c] = await contactsOf(P.stay);
    expect(c).toMatchObject({
      display_name: 'Аккаунт Туриста', email_norm: 'tourist@example.com', phone_e164: '+79995550000',
      user_id: touristId, pd_consent_at: null,
    });
  });

  it('прокат: имя, телефон и почта заказа, согласия нет', async () => {
    const gr = (await pool.query<{ id: string }>(
      `INSERT INTO gear_rentals
         (gear_id, customer_name, customer_email, customer_phone, start_date, end_date, days_count, base_price, total_price)
       VALUES ($1, 'Глеб', 'gleb@example.com', '+7 (914) 777-88-99', CURRENT_DATE + 1, CURRENT_DATE + 3, 2, 1000, 1000)
       RETURNING id`, [gearId],
    )).rows[0].id;
    expect(await link('gear_rental', gr)).toMatchObject({ outcome: 'linked', partnerId: P.gear });
    const [c] = await contactsOf(P.gear);
    expect(c).toMatchObject({ display_name: 'Глеб', phone_e164: '+79147778899', pd_consent_at: null });
  });

  it('перевозчик: телефон заказа; имя — только у заказавшего партнёра', async () => {
    const byTourist = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, contact_phone)
       VALUES ($1, $2, 2, '+79148889900') RETURNING id`, [tripId, touristId],
    )).rows[0].id;
    const byOperator = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_partner_id, seats, contact_phone)
       VALUES ($1, $2, 4, '+79149990011') RETURNING id`, [tripId, P.opA],
    )).rows[0].id;
    expect(await link('transfer_seat_booking', byTourist)).toMatchObject({ outcome: 'linked', partnerId: P.carrier });
    expect(await link('transfer_seat_booking', byOperator)).toMatchObject({ outcome: 'linked', partnerId: P.carrier });
    const list = await contactsOf(P.carrier);
    expect(list.map((c) => [c.display_name, c.phone_e164, c.email_norm])).toEqual([
      [null, '+79148889900', null],
      ['Оператор А', '+79149990011', null],
    ]);
  });

  it('клиент агента — контакт его партнёрской строки', async () => {
    const ac = (await pool.query<{ id: string }>(
      `INSERT INTO agent_clients (agent_id, name, phone, email) VALUES ($1, 'Дина', '+79140001122', 'dina@example.com') RETURNING id`,
      [agentUserId],
    )).rows[0].id;
    expect(await link('agent_client', ac)).toMatchObject({ outcome: 'linked', partnerId: P.agent, created: true });
  });

  it('повтор и гонка одного источника — одна связь', async () => {
    const id = await booking(tourA, { name: 'Ева', phone: '+79141230000' });
    const [a, b] = await Promise.all([link('operator_booking', id), link('operator_booking', id)]);
    if (a.outcome !== 'linked' || b.outcome !== 'linked') throw new Error('не привязано');
    expect(a.contactId).toBe(b.contactId);
    expect(await linksOf(a.contactId)).toEqual([`operator_booking:${id}`]);
    expect(await link('operator_booking', id)).toMatchObject({ outcome: 'linked', created: false, contactId: a.contactId });
  });

  it('гонка двух источников с новым телефоном — один контакт (23505 разводится повтором)', async () => {
    const x = await booking(tourA, { name: 'Жанна', phone: '+79145550101' });
    const y = await booking(tourA, { name: 'Жанна', phone: '89145550101' });
    const [a, b] = await Promise.all([link('operator_booking', x), link('operator_booking', y)]);
    if (a.outcome !== 'linked' || b.outcome !== 'linked') throw new Error('не привязано');
    expect(a.contactId).toBe(b.contactId);
    expect(await linksOf(a.contactId)).toHaveLength(2);
  });

  it('задел: считает непривязанное и проходит его курсором, пропуская строку без примет', async () => {
    const fresh = await booking(tourA, { name: 'Зоя', phone: '+79146660000' });
    const counts = Object.fromEntries(await Promise.all(SOURCE_KINDS.map(async (k) =>
      [k, (await pool.query<{ n: number }>(UNLINKED_COUNT_SQL[k])).rows[0].n] as const)));
    // Непривязаны: свежая бронь и бронь без примет (no_contact связи не даёт);
    // удалённая бронь, свой лид и лид платформе в отбор не входят вовсе.
    expect(counts.operator_booking).toBe(2);
    expect(counts.lead).toBe(0);

    const page = await pool.query<{ id: string }>(UNLINKED_PAGE_SQL.operator_booking, [cursorStart('operator_booking'), 1]);
    expect(page.rows).toHaveLength(1);
    const next = await pool.query<{ id: string }>(UNLINKED_PAGE_SQL.operator_booking, [page.rows[0].id, 10]);
    expect([page.rows[0].id, ...next.rows.map((r) => r.id)]).toContain(fresh);
    for (const k of SOURCE_KINDS) {
      await pool.query(UNLINKED_PAGE_SQL[k], [cursorStart(k), 5]);
    }
  });

  it('список, поиск, метки и карточка — только свои', async () => {
    const all = await listContacts(P.opA, { limit: 50, offset: 0 }, pool);
    expect(all.total).toBe(all.items.length);
    expect(all.items.every((i) => typeof i.last_activity_at === 'string')).toBe(true);

    const byTail = await listContacts(P.opA, { q: '11-22-33', limit: 50, offset: 0 }, pool);
    expect(byTail.items.map((i) => i.display_name)).toEqual(['Анна']);
    const byName = await listContacts(P.opA, { q: 'БОР', limit: 50, offset: 0 }, pool);
    expect(byName.items.map((i) => i.display_name)).toEqual(['Борис']);
    const byPercent = await listContacts(P.opA, { q: '%', limit: 50, offset: 0 }, pool);
    expect(byPercent.total).toBe(0);

    const anna = byTail.items[0];
    expect(await updateContact(P.opA, anna.id, { tags: ['vip'], notes: 'любит вулканы' }, pool)).toBe(true);
    expect((await listContacts(P.opA, { tag: 'vip', limit: 50, offset: 0 }, pool)).items.map((i) => i.id)).toEqual([anna.id]);
    // Чужой партнёр не правит и не видит.
    expect(await updateContact(P.opB, anna.id, { notes: 'чужое' }, pool)).toBe(false);
    expect(await getContactCard(P.opB, anna.id, pool)).toBeNull();

    const card = await getContactCard(P.opA, anna.id, pool);
    expect(card).not.toBeNull();
    expect(card!.notes).toBe('любит вулканы');
    expect(card!.consent).toMatchObject({ source: 'booking-form', version: '2026-10-08' });
    expect(card!.sources.map((s) => s.kind).sort()).toEqual(['lead', 'operator_booking', 'operator_booking']);
    expect(card!.sources.find((s) => s.kind === 'operator_booking')).toMatchObject({ title: 'Тур А', people: 2 });
    // Деньги в сводку не идут.
    expect(JSON.stringify(card)).not.toMatch(/price/);
  });

  it('ручной контакт: согласие NULL, дубль по телефону и почте, плохой номер', async () => {
    const created = await createManualContact(P.opA, { display_name: 'Иван', phone: '+7 914 000-99-88', tags: ['звонок'] }, pool);
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') throw new Error('не создан');
    const row = (await pool.query<{ origin: string; pd_consent_at: Date | null }>(
      `SELECT origin, pd_consent_at FROM crm_contacts WHERE id = $1`, [created.id],
    )).rows[0];
    expect(row).toEqual({ origin: 'manual', pd_consent_at: null });
    expect(await createManualContact(P.opA, { display_name: 'Иван 2', phone: '89140009988' }, pool))
      .toEqual({ outcome: 'exists', id: created.id });
    expect(await createManualContact(P.opA, { display_name: 'Борис', email: 'BORIS@mail.ru' }, pool))
      .toMatchObject({ outcome: 'exists' });
    expect(await createManualContact(P.opA, { display_name: 'Кто-то', phone: '12' }, pool))
      .toEqual({ outcome: 'bad_phone' });
    // Тот же телефон у другого партнёра — не дубль.
    expect((await createManualContact(P.opB, { display_name: 'Иван', phone: '+79140009988' }, pool)).outcome).toBe('created');
  });

  it('администратор: клиенты всех партнёров, фильтры по роли, партнёру и поиску', async () => {
    const all = await listAllContacts({ limit: 200, offset: 0 }, pool);
    expect(all.total).toBe(all.items.length);
    const seen = new Set(all.items.map((i) => i.partner.id));
    for (const id of [P.opA, P.opB, P.stay, P.gear, P.carrier, P.agent]) expect(seen.has(id), id).toBe(true);
    expect(seen.has(P.guide)).toBe(false);

    const stay = await listAllContacts({ category: 'stay', limit: 50, offset: 0 }, pool);
    expect(stay.items.map((i) => i.partner.id)).toEqual([P.stay]);

    const onlyB = await listAllContacts({ partnerId: P.opB, limit: 50, offset: 0 }, pool);
    expect(new Set(onlyB.items.map((i) => i.partner.id))).toEqual(new Set([P.opB]));

    // Один телефон у двух операторов — два клиента, у каждого свой партнёр.
    const anna = await listAllContacts({ q: '11-22-33', limit: 50, offset: 0 }, pool);
    expect(anna.items.map((i) => i.partner.id).sort()).toEqual([P.opA, P.opB].sort());

    const op = all.facets.categories.find((c) => c.category === 'operator');
    expect(op?.n).toBeGreaterThan(0);
    expect(all.facets.partners.find((p) => p.id === P.stay)).toMatchObject({ name: 'Гостиница', category: 'stay', n: 1 });
  });

  it('администратор: карточка любого клиента — с его партнёром и той же сводкой', async () => {
    const [annaB] = (await listAllContacts({ partnerId: P.opB, q: '11-22-33', limit: 5, offset: 0 }, pool)).items;
    const card = await getContactCardForAdmin(annaB.id, pool);
    expect(card?.partner).toEqual({ id: P.opB, name: 'Оператор Б', category: 'operator' });
    expect(card?.sources.map((x) => x.kind)).toEqual(['operator_booking']);
    expect(await getContactCardForAdmin('00000000-0000-4000-8000-000000000000', pool)).toBeNull();
  });

  it('лента: событие источника находит клиента по связи и поднимает last_activity_at', async () => {
    const id = await booking(tourA, { name: 'Лента Тест', phone: '+79140001010' });
    const linked = await link('operator_booking', id);
    if (linked.outcome !== 'linked') throw new Error('не привязано');
    const r = await recordSourceEvent({
      kind: 'status_change', sourceKind: 'operator_booking', sourceId: id, actorKind: 'partner_user',
      title: statusChangeTitle('operator_booking', 'new', 'confirmed'), payload: { from: 'new', to: 'confirmed' },
      occurredAt: new Date('2030-01-01T00:00:00Z'),
    }, pool);
    expect(r).toMatchObject({ outcome: 'recorded', partnerId: P.opA, contactId: linked.contactId });
    const events = await listContactEvents(P.opA, linked.contactId, 50, pool);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'status_change', actor_kind: 'partner_user', title: 'Бронь тура: новая → подтверждена',
      source_kind: 'operator_booking', source_id: id, details: null,
    });
    const { rows: [c] } = await pool.query<{ y: number }>(
      `SELECT EXTRACT(YEAR FROM last_activity_at)::int AS y FROM crm_contacts WHERE id = $1`, [linked.contactId],
    );
    expect(c.y).toBe(2030);
  });

  it('лента: источник без связи сначала привязывается — хук мог отказать', async () => {
    const id = await booking(tourA, { name: 'Без хука', phone: '+79140002020' });
    const r = await recordSourceEvent({
      kind: 'status_change', sourceKind: 'operator_booking', sourceId: id, actorKind: 'system',
      title: statusChangeTitle('operator_booking', null, 'confirmed'),
    }, pool);
    expect(r.outcome).toBe('recorded');
    if (r.outcome !== 'recorded') throw new Error('не записано');
    expect(await linksOf(r.contactId)).toEqual([`operator_booking:${id}`]);
    expect((await listContactEvents(P.opA, r.contactId, 50, pool))[0]?.title).toBe('Бронь тура: подтверждена');
  });

  it('лента: источник без партнёра — no_contact, а не запись в никуда', async () => {
    const platform = (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone) VALUES ('Платформе 2', '+79140000003') RETURNING id`,
    )).rows[0].id;
    expect(await recordSourceEvent({
      kind: 'status_change', sourceKind: 'lead', sourceId: platform, actorKind: 'system', title: 'Заявка: разобрана',
    }, pool)).toEqual({ outcome: 'no_contact' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM crm_events WHERE source_kind = 'lead' AND source_id = $1`, [platform])).rows[0].n).toBe(0);
  });

  it('лента: касание — только своему клиенту; чужой партнёр не пишет и не читает', async () => {
    const anna = (await pool.query<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE partner_id = $1 AND phone_e164 = '+79141112233'`, [P.opA],
    )).rows[0];
    const t = await addContactTouch(P.opA, anna.id, {
      kind: 'call', title: 'Позвонил, перенесли на август', details: 'Просила перезвонить после 20-го', actorUserId: null,
    }, pool);
    expect(t.outcome).toBe('recorded');
    expect(await addContactTouch(P.opB, anna.id, { kind: 'note', title: 'чужое' }, pool)).toEqual({ outcome: 'not_found' });
    expect(await listContactEvents(P.opB, anna.id, 50, pool)).toEqual([]);
    const card = await getContactCard(P.opA, anna.id, pool);
    expect(card?.events[0]).toMatchObject({
      kind: 'call', actor_kind: 'partner_user', title: 'Позвонил, перенесли на август',
      details: 'Просила перезвонить после 20-го', source_kind: null,
    });
    // Карточка администратора несёт ту же ленту.
    expect((await getContactCardForAdmin(anna.id, pool))?.events[0]?.title).toBe('Позвонил, перенесли на август');
  });

  it('задачи: своему клиенту — да, чужому — contact_not_found; без клиента — можно', async () => {
    const anna = (await pool.query<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE partner_id = $1 AND phone_e164 = '+79141112233'`, [P.opA],
    )).rows[0];
    const later = await createTask(P.opA, {
      title: '  Уточнить   состав группы ', dueAt: new Date('2030-03-01T00:00:00Z'), contactId: anna.id,
    }, pool);
    expect(later).toMatchObject({ outcome: 'created', task: { title: 'Уточнить состав группы', done_at: null, contact: { id: anna.id, display_name: 'Анна' } } });
    const overdue = await createTask(P.opA, { title: 'Перезвонить', dueAt: new Date('2020-01-01T00:00:00Z'), contactId: anna.id }, pool);
    expect(overdue.outcome).toBe('created');
    expect(await createTask(P.opB, { title: 'чужое', dueAt: new Date(), contactId: anna.id }, pool)).toEqual({ outcome: 'contact_not_found' });
    expect(await createTask(P.opB, { title: 'Своё без клиента', dueAt: new Date('2030-01-01T00:00:00Z') }, pool))
      .toMatchObject({ outcome: 'created', task: { contact: null } });

    // Открытые — по сроку, просроченная первой; чужой партнёр не видит.
    const open = await listTasks(P.opA, { status: 'open' }, pool);
    expect(open.map((t) => t.title)).toEqual(['Перезвонить', 'Уточнить состав группы']);
    expect((await listTasks(P.opA, { status: 'open', contactId: anna.id }, pool))).toHaveLength(2);
    expect((await listTasks(P.opB, { status: 'open' }, pool)).map((t) => t.title)).toEqual(['Своё без клиента']);
  });

  it('задачи: выполнение пишет task_done в ленту один раз; выполненная не правится', async () => {
    const [first] = await listTasks(P.opA, { status: 'open' }, pool);
    if (!first?.contact) throw new Error('нет задачи с клиентом');
    // Чужой партнёр не отмечает, не правит и не удаляет.
    expect(await completeTask(P.opB, first.id, null, pool)).toEqual({ outcome: 'not_found' });
    expect(await updateTask(P.opB, first.id, { title: 'чужое' }, pool)).toBeNull();
    expect(await deleteTask(P.opB, first.id, pool)).toBe(false);

    const moved = await updateTask(P.opA, first.id, { dueAt: new Date('2029-12-31T21:00:00Z'), details: 'после 20-го' }, pool);
    expect(moved).toMatchObject({ title: 'Перезвонить', details: 'после 20-го', due_at: '2029-12-31T21:00:00.000Z' });

    const done = await completeTask(P.opA, first.id, null, pool);
    expect(done).toMatchObject({ outcome: 'done', task: { id: first.id } });
    if (done.outcome !== 'done') throw new Error('не выполнено');
    expect(done.task.done_at).not.toBeNull();
    expect(await completeTask(P.opA, first.id, null, pool)).toEqual({ outcome: 'not_found' });
    expect(await updateTask(P.opA, first.id, { title: 'после выполнения' }, pool)).toBeNull();

    const feed = await listContactEvents(P.opA, first.contact.id, 50, pool);
    const taskEvents = feed.filter((e) => e.kind === 'task_done');
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]).toMatchObject({ actor_kind: 'partner_user', title: 'Перезвонить', source_kind: null });

    expect((await listTasks(P.opA, { status: 'done' }, pool)).map((t) => t.id)).toEqual([first.id]);
    // Удаление выполненной не трогает ленту: факт уже записан.
    expect(await deleteTask(P.opA, first.id, pool)).toBe(true);
    expect((await listContactEvents(P.opA, first.contact.id, 50, pool)).filter((e) => e.kind === 'task_done')).toHaveLength(1);
  });

  it('задачи: клиент удалён — его задачи уходят вместе с ним (CASCADE)', async () => {
    const c = await createManualContact(P.opB, { display_name: 'Временный', phone: '+79140007777' }, pool);
    if (c.outcome !== 'created') throw new Error('не заведён');
    await createTask(P.opB, { title: 'Про временного', dueAt: new Date(), contactId: c.id }, pool);
    await pool.query(`DELETE FROM crm_contacts WHERE id = $1`, [c.id]);
    expect((await listTasks(P.opB, { status: 'open' }, pool)).map((t) => t.title)).toEqual(['Своё без клиента']);
  });

  it('контекст партнёра: профиль по категории, агент — только одобренный', async () => {
    expect(await partnerContextFor(agentUserId, 'agent', pool)).toMatchObject({ outcome: 'ok', partnerId: P.agent });
    await pool.query(`UPDATE partners SET profile_status = 'pending' WHERE id = $1`, [P.agent]);
    expect(await partnerContextFor(agentUserId, 'agent', pool)).toEqual({ outcome: 'none', reason: 'not_approved' });
    expect(await partnerContextFor(touristId, 'operator', pool)).toEqual({ outcome: 'none', reason: 'profile' });
  });
});
