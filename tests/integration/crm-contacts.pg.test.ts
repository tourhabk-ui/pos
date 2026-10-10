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
import { runTaskReminders } from '@/lib/crm/reminders';
import { loadInbox } from '@/lib/crm/inbox';
import { runInboxReminders } from '@/lib/crm/inbox-reminders';
import { executeCrmTool, crmToolText } from '@/lib/crm/tools';
import { createAgentKey, listAgentKeys, resolveAgentKey, revokeAgentKey, MAX_ACTIVE_KEYS } from '@/lib/crm/agent-keys';

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

  it('напоминания: срок подошёл — одно сообщение, исход записан; окно, «заведена просроченной» и будущее — мимо', async () => {
    // 12:00 по Камчатке; от реального времени SQL отбора не зависит — только от $1.
    const T = new Date('2030-06-01T00:00:00Z');
    const at = (minutes: number) => new Date(T.getTime() + minutes * 60_000).toISOString();
    const ins = async (title: string, due: string, created: string) => (await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, title, due_at, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [P.guide, title, due, created],
    )).rows[0].id;
    const due = await ins('Перезвонить <Ивану>', at(-30), at(-120));
    await ins('Заведена просроченной', at(-1440), at(-10));
    await ins('Неделю назад', at(-8 * 1440), at(-10 * 1440));
    await ins('Ещё не срок', at(60), at(-120));

    const sent: string[] = [];
    const r = await runTaskReminders(T, {
      db: pool,
      reach: async (pid) => (pid === P.guide
        ? { telegramChatId: null, maxChatId: '999', telegramSource: null, reachable: true }
        : { telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false }),
      send: async (p) => { sent.push(p.text); return { channel: 'max', delivered: true, reason: 'ok' }; },
    });
    expect(r.quiet).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Подошёл срок: 1 задача/);
    expect(sent[0]).toMatch(/Перезвонить &lt;Ивану&gt;/);

    const { rows } = await pool.query<{ title: string; reminder_channel: string | null; reminded: boolean }>(
      `SELECT title, reminder_channel, reminded_at IS NOT NULL AS reminded FROM crm_tasks WHERE partner_id = $1 ORDER BY due_at`,
      [P.guide],
    );
    expect(rows.map((x) => [x.title, x.reminder_channel])).toEqual([
      ['Неделю назад', null], ['Заведена просроченной', null], ['Перезвонить <Ивану>', 'max'], ['Ещё не срок', null],
    ]);

    // Второй прогон — не повторяет.
    const again: string[] = [];
    await runTaskReminders(T, { db: pool, reach: async () => null, send: async (p) => { again.push(p.text); return { channel: 'max', delivered: true, reason: 'ok' }; } });
    expect(again).toEqual([]);

    // Перенос срока сбрасывает напоминание; правка заголовка — нет.
    const kept = await updateTask(P.guide, due, { title: 'Перезвонить Ивану' }, pool);
    expect(kept?.reminder?.channel).toBe('max');
    const moved = await updateTask(P.guide, due, { dueAt: new Date(at(90)) }, pool);
    expect(moved?.reminder).toBeNull();
  });

  it('напоминания: исход без момента база не примет', async () => {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO crm_tasks (partner_id, title, due_at) VALUES ($1, 'пара', NOW()) RETURNING id`, [P.guide],
    )).rows[0].id;
    await expect(pool.query(`UPDATE crm_tasks SET reminder_channel = 'max' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE crm_tasks SET reminded_at = NOW(), reminder_channel = 'sms' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('входящие: каждый вид исполняется, ответ партнёра идёт в медиану, автомат и чужое — нет', async () => {
    const mk = async (name: string, category: string) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact) VALUES ($1, $2, '{}') RETURNING id`, [name, category],
      )).rows[0].id;
    const op = await mk('Оператор входящих', 'operator');
    const stay = await mk('Жильё входящих', 'stay');
    const gear = await mk('Прокат входящих', 'gear');
    const carrier = await mk('Перевозчик входящих', 'transfer');
    const guide = await mk('Гид входящих', 'guide');
    const tour = Number((await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price) VALUES ($1, 'Тур входящих', 5000) RETURNING id`, [op],
    )).rows[0].id);
    const age = async (table: string, id: string, interval: string) =>
      pool.query(`UPDATE ${table} SET created_at = NOW() - $2::interval WHERE id::text = $1`, [id, interval]);
    const event = (partner: string, kind: SourceKind, id: string, actor: string, minutesAfter: number, table: string) =>
      pool.query(
        `INSERT INTO crm_events (partner_id, source_kind, source_id, kind, actor_kind, title, occurred_at)
         SELECT $1, $2, $3, 'status_change', $4, 'Ответ', created_at + make_interval(mins => $5::int)
           FROM ${table} WHERE id::text = $3`,
        [partner, kind, id, actor, minutesAfter],
      );

    // Пять броней за сутки с ответом оператора через 10..50 минут, одна —
    // подтверждена автоматом (system) и в медиану не идёт, одна ждёт 3 часа.
    for (const m of [10, 20, 30, 40, 50]) {
      const id = await booking(tour, { name: 'Отвеченный', phone: null });
      await pool.query(`UPDATE operator_bookings SET booking_status = 'confirmed' WHERE id = $1`, [id]);
      await age('operator_bookings', id, '1 day');
      await event(op, 'operator_booking', id, 'partner_user', m, 'operator_bookings');
    }
    const auto = await booking(tour, { name: 'Автомат', phone: null });
    await pool.query(`UPDATE operator_bookings SET booking_status = 'confirmed' WHERE id = $1`, [auto]);
    await event(op, 'operator_booking', auto, 'system', 0, 'operator_bookings');
    // Умолчание колонки — confirmed; живая бронь заводится со статусом new
    // явно (NEW_BOOKING_STATUS в lib/bookings/reserve.ts).
    const waiting = await booking(tour, { name: 'Ждущий Турист', phone: '+79140005566' });
    await pool.query(`UPDATE operator_bookings SET booking_status = 'new' WHERE id = $1`, [waiting]);
    await age('operator_bookings', waiting, '3 hours');
    await link('operator_booking', waiting);

    await pool.query(
      `INSERT INTO tour_seat_requests (tour_id, operator_id, tour_date, participants, tourist_name, tourist_phone,
         reply_channel, status_token_hash, deadline_at, pd_consent_at)
       VALUES ($1, $2, CURRENT_DATE + 20, 3, 'Скрытое Имя', '+79140007788', 'telegram',
               encode(sha256('inbox-seat'::bytea), 'hex'), NOW() + INTERVAL '2 hours', NOW())`,
      [tour, op],
    );
    await pool.query(
      `INSERT INTO leads (name, phone, operator_id, status, route_title) VALUES ('Лид', '+79140009900', $1, 'awaiting_confirm', 'Мутновский')`, [op],
    );
    // Чужая заявка и чужая бронь этому оператору не видны.
    await pool.query(`INSERT INTO leads (name, phone, operator_id, status) VALUES ('Чужой', '+79140009901', $1, 'new')`, [P.opB]);

    const o = await loadInbox(op, 'operator', 'u', { db: pool, unreadChat: async () => 0 });
    expect(o.failed).toEqual([]);
    expect(o.items.map((i) => i.kind).sort()).toEqual(['lead', 'operator_booking', 'seat_request']);
    const b = o.items.find((i) => i.kind === 'operator_booking')!;
    expect(b).toMatchObject({ id: waiting, title: 'Тур входящих', contact_name: 'Ждущий Турист' });
    expect(b.waiting_minutes).toBeGreaterThanOrEqual(179);
    const seat = o.items.find((i) => i.kind === 'seat_request')!;
    expect(seat).toMatchObject({ people: 3, contact_id: null, contact_name: null });
    expect(JSON.stringify(o)).not.toMatch(/Скрытое Имя|7788/);
    expect(o.items.find((i) => i.kind === 'lead')).toMatchObject({ title: 'Мутновский' });
    expect(o.response).toMatchObject({ enough: true, responded: 5, median_minutes: 30, complete: true });

    // Отзыв о туре без ответа — входящее; ответ оператора убирает его; скрытый
    // модерацией и старше окна отзывов — не входящее.
    const rev = (await pool.query<{ id: string }>(
      `INSERT INTO operator_tour_reviews (tour_id, author_name, rating, comment) VALUES ($1, 'Анна Петрова', 4, 'Хорошо') RETURNING id::text`,
      [tour],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO operator_tour_reviews (tour_id, author_name, rating, comment, is_hidden) VALUES ($1, 'Скрытый', 1, 'x', TRUE)`, [tour],
    );
    const withReview = await loadInbox(op, 'operator', 'u', { db: pool, unreadChat: async () => 0 });
    expect(withReview.failed).toEqual([]);
    const tr = withReview.items.filter((i) => i.kind === 'tour_review');
    expect(tr).toHaveLength(1);
    expect(tr[0]).toMatchObject({ id: rev, contact_name: null });
    expect(tr[0].title).toMatch(/Тур входящих · оценка 4 из 5/);
    expect(JSON.stringify(withReview)).not.toMatch(/Петрова/);
    await pool.query(`UPDATE operator_tour_reviews SET operator_reply = 'Спасибо', operator_reply_at = NOW() WHERE id = $1`, [rev]);
    const answered = await loadInbox(op, 'operator', 'u', { db: pool, unreadChat: async () => 0 });
    expect(answered.items.filter((i) => i.kind === 'tour_review')).toEqual([]);

    // Остальные роли: каждый запрос исполняется на настоящей схеме.
    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, moderation_status)
       VALUES ($1, 'Дом у реки', 'hotel', '{"lat":53,"lng":158}', 'approved') RETURNING id`, [stay],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO accommodation_bookings
         (user_id, accommodation_id, check_in_date, check_out_date, nights, adults, room_price_per_night, total_price)
       VALUES ($1, $2, CURRENT_DATE + 3, CURRENT_DATE + 5, 2, 2, 4000, 8000)`, [touristId, acc],
    );
    const gi = (await pool.query<{ id: string }>(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, moderation_status)
       VALUES ($1, 'Спальник', 'sleeping', 300, 'approved') RETURNING id`, [gear],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO gear_rentals (gear_id, customer_name, customer_email, customer_phone, start_date, end_date, days_count, base_price, total_price)
       VALUES ($1, 'Глеб', 'gleb2@example.com', '+79147770000', CURRENT_DATE + 1, CURRENT_DATE + 3, 2, 600, 600)`, [gi],
    );
    const veh = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats) VALUES ($1, 'vahtovka', 'Урал', 20) RETURNING id`, [carrier],
    )).rows[0].id;
    const trip = (await pool.query<{ id: string }>(
      `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total)
       VALUES ($1, CURRENT_DATE + 4, 'Елизово', 'Толбачик', 16) RETURNING id`, [veh],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO transfer_seat_bookings (trip_id, ordered_by_user_id, seats, contact_phone) VALUES ($1, $2, 2, '+79148880000')`,
      [trip, touristId],
    );
    await pool.query(`INSERT INTO guide_operator_invites (operator_id, guide_partner_id) VALUES ($1, $2)`, [op, guide]);
    await pool.query(`INSERT INTO guide_reviews (guide_id, rating, comment) VALUES ($1, 4, 'Хорошо')`, [guide]);
    // Отзыв гостя без ответа (1208) — входящее жилья; скрытый — нет.
    await pool.query(
      `INSERT INTO accommodation_reviews (user_id, accommodation_id, overall_rating, comment) VALUES ($1, $2, 5, 'Отлично')`,
      [touristId, acc],
    );
    await pool.query(
      `INSERT INTO accommodation_reviews (user_id, accommodation_id, overall_rating, comment, is_visible) VALUES ($1, $2, 1, 'x', FALSE)`,
      [touristId, acc],
    );

    const expectKinds = async (partner: string, category: 'stay' | 'gear' | 'transfer' | 'guide', want: string[]) => {
      const r = await loadInbox(partner, category, 'u', { db: pool, unreadChat: async () => 0 });
      expect(r.failed, category).toEqual([]);
      expect(r.items.map((i) => i.kind).sort(), category).toEqual(want);
      expect(r.response.enough, category).toBe(false);
      return r;
    };
    const st = await expectKinds(stay, 'stay', ['accommodation_booking', 'stay_review']);
    expect(st.items.find((i) => i.kind === 'stay_review')).toMatchObject({ title: 'Дом у реки · оценка 5 из 5', contact_name: null });
    // Ответ и его время — парой; без пары база не примет.
    await expect(pool.query(
      `UPDATE accommodation_reviews SET owner_reply = 'x' WHERE accommodation_id = $1`, [acc],
    )).rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE accommodation_reviews SET owner_reply = 'Спасибо', owner_reply_at = NOW() WHERE accommodation_id = $1`, [acc]);
    await expectKinds(stay, 'stay', ['accommodation_booking']);
    await expectKinds(gear, 'gear', ['gear_rental']);
    const t = await expectKinds(carrier, 'transfer', ['transfer_seat_booking']);
    expect(t.items[0]).toMatchObject({ title: 'Елизово — Толбачик', people: 2 });
    const g = await expectKinds(guide, 'guide', ['guide_invite', 'guide_review']);
    expect(g.items.find((i) => i.kind === 'guide_invite')).toMatchObject({ title: 'Оператор входящих' });
    expect(g.items.find((i) => i.kind === 'guide_review')).toMatchObject({ title: 'Оценка 4 из 5' });
    expect((await loadInbox(P.agent, 'agent', 'u', { db: pool })).items).toEqual([]);
  });

  it('напоминание о входящем: 2 часа днём, до 24 часов, одно на предмет; исход записан', async () => {
    // 10:00 по Камчатке — день; метки создания отсчитываются от этого «сейчас».
    const now = new Date('2026-10-09T22:00:00Z');
    const mk = async (name: string, category: string) =>
      (await pool.query<{ id: string }>(`INSERT INTO partners (name, category, contact) VALUES ($1, $2, '{}') RETURNING id`, [name, category])).rows[0].id;
    const stay = await mk('Жильё напоминаний', 'stay');
    const guide = await mk('Гид напоминаний', 'guide');
    const op = await mk('Оператор напоминаний', 'operator');
    const acc = (await pool.query<{ id: string }>(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, moderation_status)
       VALUES ($1, 'Дом напоминаний', 'hotel', '{"lat":53,"lng":158}', 'approved') RETURNING id`, [stay],
    )).rows[0].id;
    const stayBooking = async (ago: string) => (await pool.query<{ id: string }>(
      `INSERT INTO accommodation_bookings
         (user_id, accommodation_id, check_in_date, check_out_date, nights, adults, room_price_per_night, total_price, created_at)
       VALUES ($1, $2, CURRENT_DATE + 3, CURRENT_DATE + 5, 2, 2, 4000, 8000, $3::timestamptz - $4::interval) RETURNING id`,
      [touristId, acc, now.toISOString(), ago],
    )).rows[0].id;
    const due = await stayBooking('3 hours');
    // Бронь привязана к клиенту, как это делает живой хук: имя в MAX — из контакта.
    await link('accommodation_booking', due);
    await stayBooking('1 hour');     // ещё рано
    await stayBooking('30 hours');   // дверь Watchdog
    await pool.query(
      `INSERT INTO guide_operator_invites (operator_id, guide_partner_id, created_at) VALUES ($1, $2, $3::timestamptz - INTERVAL '5 hours')`,
      [op, guide, now.toISOString()],
    );

    const sent: Array<{ text: string; stub: string }> = [];
    const send = async (p: { text: string; stub: string }) => { sent.push(p); return { channel: 'max' as const, delivered: true, reason: 'ok' }; };
    const reach = async (id: string) => (id === guide
      ? { reachable: false, maxChatId: null, telegramChatId: null }
      : { reachable: true, maxChatId: '1', telegramChatId: null }) as never;

    const r = await runInboxReminders(now, { db: pool, reach, send: send as never });
    expect(r.failed_kinds).toEqual([]);
    // Предметы других тестов этого файла создавались «сейчас» по часам базы —
    // их окно от фиксированного now не задевает; считаем свои.
    const mine = await pool.query<{ partner_id: string; item_kind: string; item_id: string; channel: string }>(
      `SELECT partner_id, item_kind, item_id, channel FROM crm_inbox_reminders WHERE partner_id = ANY($1::uuid[]) ORDER BY item_kind`,
      [[stay, guide]],
    );
    expect(mine.rows).toEqual([
      { partner_id: stay, item_kind: 'accommodation_booking', item_id: due, channel: 'max' },
      { partner_id: guide, item_kind: 'guide_invite', item_id: expect.any(String), channel: 'unreachable' },
    ]);
    expect(sent.some((m) => m.text.includes('Бронь жилья «Дом напоминаний»') && m.text.includes('Аккаунт Туриста'))).toBe(true);

    // Второй прогон — о тех же предметах не напоминает.
    const again: string[] = [];
    await runInboxReminders(now, { db: pool, reach, send: (async (p: { text: string }) => { again.push(p.text); return { channel: 'max', delivered: true, reason: 'ok' }; }) as never });
    expect(again.filter((t) => t.includes('Дом напоминаний'))).toEqual([]);

    // Канал без исхода и неизвестный вид база не примет.
    await expect(pool.query(
      `INSERT INTO crm_inbox_reminders (partner_id, item_kind, item_id, channel) VALUES ($1, 'lead', 'x', 'max')`, [stay],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO crm_inbox_reminders (partner_id, item_kind, item_id, channel) VALUES ($1, 'gear_rental', 'x', 'sms')`, [stay],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('инструменты CRM на настоящей базе: подпись без телефона; задача и выполнение — от Кузьмича', async () => {
    const ctx = { partnerId: P.opA, category: 'operator' as const, userId: null, actor: 'kuzmich' as const, canWrite: true };
    const anna = (await pool.query<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE partner_id = $1 AND phone_e164 = '+79141112233'`, [P.opA],
    )).rows[0];

    // Поиск по хвосту телефона находит клиента, но телефона модели не отдаёт.
    const found = crmToolText(await executeCrmTool('crm_find_contact', { query: '2233' }, ctx, pool));
    expect(found).toContain(anna.id);
    expect(found).not.toMatch(/9141112233|@/);
    // Чужой партнёр того же клиента не находит.
    const foreign = await executeCrmTool('crm_find_contact', { query: '2233' }, { ...ctx, partnerId: P.opB }, pool);
    expect(crmToolText(foreign)).not.toContain(anna.id);

    const created = await executeCrmTool('crm_add_task', { title: 'Отправить памятку', due: '2030-05-01', contact_id: anna.id }, ctx, pool);
    if (!created.ok) throw new Error(created.error);
    const taskId = (created.data as { task_id: string }).task_id;
    const row = (await pool.query<{ origin: string; due_at: Date }>(`SELECT origin, due_at FROM crm_tasks WHERE id = $1`, [taskId])).rows[0];
    expect(row.origin).toBe('kuzmich');
    expect(row.due_at.toISOString()).toBe('2030-04-30T22:00:00.000Z'); // 10:00 1 мая по Камчатке

    expect((await executeCrmTool('crm_complete_task', { task_id: taskId }, ctx, pool)).ok).toBe(true);
    const feed = await listContactEvents(P.opA, anna.id, 50, pool);
    expect(feed.find((e) => e.kind === 'task_done' && e.title === 'Отправить памятку')?.actor_kind).toBe('kuzmich');

    expect((await executeCrmTool('crm_add_touch', { contact_id: anna.id, kind: 'call', title: 'Обсудили дату' }, ctx, pool)).ok).toBe(true);
    const card = crmToolText(await executeCrmTool('crm_contact_card', { contact_id: anna.id }, ctx, pool));
    expect(card).toContain('Обсудили дату');
    expect(card).not.toMatch(/9141112233|@/);
    expect((await executeCrmTool('crm_inbox', {}, ctx, pool)).ok).toBe(true);

    // Чужое происхождение задачи база не примет.
    await expect(pool.query(
      `INSERT INTO crm_tasks (partner_id, title, due_at, origin) VALUES ($1, 'x', NOW(), 'robot')`, [P.opA],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('ключи MCP партнёра: хеш в базе, вход по ключу, запись от mcp, отзыв, предел', async () => {
    const made = await createAgentKey(P.opA, { label: 'Claude', canWrite: true, createdBy: null }, pool);
    if (made.outcome !== 'created') throw new Error('ключ не выпущен');
    // В базе ключа нет — только хеш и начало.
    const stored = await pool.query<{ key_hash: string; key_prefix: string }>(
      `SELECT key_hash, key_prefix FROM partner_api_keys WHERE id = $1`, [made.item.id],
    );
    expect(stored.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].key_hash).not.toContain(made.key);
    expect(made.key.startsWith(stored.rows[0].key_prefix)).toBe(true);
    expect(JSON.stringify(await listAgentKeys(P.opA, pool))).not.toContain(made.key);

    const lookup = await resolveAgentKey(made.key, pool);
    expect(lookup).toMatchObject({ outcome: 'ok', key: { partnerId: P.opA, category: 'operator', canWrite: true } });
    if (lookup.outcome !== 'ok') throw new Error('ключ не принят');

    const ctx = { partnerId: lookup.key.partnerId, category: lookup.key.category, userId: lookup.key.userId, actor: 'mcp' as const, canWrite: true };
    const task = await executeCrmTool('crm_add_task', { title: 'Агент: уточнить даты', due: '2030-06-01' }, ctx, pool);
    if (!task.ok) throw new Error(task.error);
    const origin = await pool.query<{ origin: string }>(`SELECT origin FROM crm_tasks WHERE id = $1`, [(task.data as { task_id: string }).task_id]);
    expect(origin.rows[0].origin).toBe('mcp');

    // Чужой партнёр ключ не отзовёт; свой — отзывает, и ключ больше не пускает.
    expect(await revokeAgentKey(P.opB, made.item.id, null, pool)).toBe(false);
    expect(await revokeAgentKey(P.opA, made.item.id, null, pool)).toBe(true);
    expect(await resolveAgentKey(made.key, pool)).toEqual({ outcome: 'invalid' });
    expect(await revokeAgentKey(P.opA, made.item.id, null, pool)).toBe(false);

    // Предел действующих ключей; отозванный в него не считается.
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      expect((await createAgentKey(P.opA, { label: `k${i}`, canWrite: false, createdBy: null }, pool)).outcome).toBe('created');
    }
    expect(await createAgentKey(P.opA, { label: 'лишний', canWrite: false, createdBy: null }, pool)).toEqual({ outcome: 'limit' });
    const list = await listAgentKeys(P.opA, pool);
    expect(list.filter((k) => !k.revoked_at)).toHaveLength(MAX_ACTIVE_KEYS);
    expect(list.at(-1)).toMatchObject({ label: 'Claude', revoked_at: expect.any(String) });
  });

  it('контекст партнёра: профиль по категории, агент — только одобренный', async () => {
    expect(await partnerContextFor(agentUserId, 'agent', pool)).toMatchObject({ outcome: 'ok', partnerId: P.agent });
    await pool.query(`UPDATE partners SET profile_status = 'pending' WHERE id = $1`, [P.agent]);
    expect(await partnerContextFor(agentUserId, 'agent', pool)).toEqual({ outcome: 'none', reason: 'not_approved' });
    expect(await partnerContextFor(touristId, 'operator', pool)).toEqual({ outcome: 'none', reason: 'profile' });
  });
});
