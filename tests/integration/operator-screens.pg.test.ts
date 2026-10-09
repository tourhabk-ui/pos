/**
 * Четыре экрана кабинета оператора на настоящем PostgreSQL (#1794).
 *
 * «Полнота туров», «Клиенты», «Аналитика» и «Гиды» отвечали 500 на любой
 * запрос: колонок `ot.transportation`, `tp.amount`, `g.specializations` нет,
 * а алиас CTE `cs` использовался внутри собственного определения. Полный
 * юнит-прогон был зелёным — моки отвечают `{rowCount: 0}` на любой текст.
 * Форму SQL доказывает только сервер (§4.0 «судить статикой запрещено»),
 * поэтому запросы вынесены в `lib/operator/screen-queries.ts` и каждый
 * ИСПОЛНЯЕТСЯ здесь на схеме из baseline прода + всех миграций — тем же
 * путём, что у деплоя.
 *
 * Своя база `operator_screens_test` (приём alert-dedup / tourist-cabinet).
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  COMPLETENESS_TOURS_SQL, ANALYTICS_SQL, GUIDES_SQL,
} from '@/lib/operator/screen-queries';
import {
  OPERATOR_CLIENTS_LIST_SQL, OPERATOR_CLIENTS_COUNT_SQL, OPERATOR_CLIENTS_SUMMARY_SQL, listOperatorClients,
} from '@/lib/crm/operator-clients';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[operator-screens.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'operator_screens_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('экраны оператора на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let operatorId = '';
  let touristId = '';
  let guideId = '';
  let tourId = 0;
  let bookingId = 0;
  let contactId = '';
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    // Порог сравнивается ЧИСЛОМ, а не строкой. `name >= '863'` в Postgres —
    // сравнение текста, и `'1000_...' >= '863'` ЛОЖНО (`'1' < '8'`): миграция
    // 1000 и все следующие остались бы помеченными применёнными и не
    // переигрались бы в тестовой базе — их DDL просто не попал бы в схему.
    await pool.query(
      `DELETE FROM _migrations
        WHERE (substring(name from '^[0-9]+'))::bigint >= $1
           OR substring(name from '^[0-9]+') IS NULL`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    // Посев: оператор, гид с подтверждённой аттестацией, тур, турист с
    // оплаченной бронью и выпущенным платежом.
    const op = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Оператор экранов', 'operator', '{"phone":"+70000000000"}', TRUE, TRUE, 'scr-op') RETURNING id`,
    );
    operatorId = op.rows[0].id;
    const g = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, guide_operator_id, rating, is_available)
       VALUES ('Гид экранов', 'guide', '{}', TRUE, TRUE, 'scr-guide', $1, 4.8, TRUE) RETURNING id`, [operatorId],
    );
    guideId = g.rows[0].id;
    await pool.query(
      `INSERT INTO guide_certifications (guide_id, name, issuing_authority, is_verified)
       VALUES ($1, 'Инструктор-проводник', 'ФСТР', TRUE), ($1, 'Первая помощь', 'РКК', FALSE)`, [guideId],
    );
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, phone) VALUES ('scr-tourist@example.com', 'Турист экранов', 'x', 'tourist', '+79990000000') RETURNING id`,
    );
    touristId = u.rows[0].id;
    const t = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty, duration_hours)
       VALUES ($1, 'Тур экранов', 5000, 10, TRUE, TRUE, 'hiking', 'easy', 6) RETURNING id`, [operatorId],
    );
    tourId = Number(t.rows[0].id);
    const b = await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, user_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, tourist_name)
       VALUES ($1, $2, CURRENT_DATE + 7, 2, 10000, 10000, 'confirmed', 'paid', 'Турист экранов') RETURNING id`,
      [tourId, touristId],
    );
    bookingId = Number(b.rows[0].id);
    await pool.query(
      `INSERT INTO tour_payments (booking_id, operator_id, retail_amount, net_amount, commission_amount, commission_rate, status, paid_at, released_at)
       VALUES ($1, $2, 10000, 9000, 1000, 10, 'RELEASED', NOW(), NOW())`,
      [Number(b.rows[0].id), operatorId],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('«Полнота туров»: запрос исполняется и видит тур оператора', async () => {
    const r = await pool.query(COMPLETENESS_TOURS_SQL, [operatorId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ title: 'Тур экранов', is_published: true });
    expect(r.rows[0]).not.toHaveProperty('transportation');
  });

  it('«Клиенты» на CRM: сумма, сегмент и итоги считаются по привязанным броням', async () => {
    // Контакт туриста с бронью (подтверждена, 10 000) и отменённой бронью,
    // и клиент, заведённый руками, — без броней.
    const c = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (partner_id, user_id, display_name, phone, phone_e164, origin, tags)
       VALUES ($1, $2, 'Турист экранов', '+79990000000', '+79990000000', 'operator_booking', '{постоянный}') RETURNING id`,
      [operatorId, touristId],
    );
    contactId = c.rows[0].id;
    await pool.query(
      `INSERT INTO crm_contact_links (contact_id, partner_id, source_kind, source_id, occurred_at)
       VALUES ($1, $2, 'operator_booking', $3, NOW())`, [contactId, operatorId, String(bookingId)],
    );
    const cancelled = await pool.query<{ id: string }>(
      // Создана 60 дней назад — вне окна аналитики (30 дней), чтобы не сдвинуть её счёт.
      `INSERT INTO operator_bookings (operator_tour_id, user_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, tourist_name, created_at)
       VALUES ($1, $2, CURRENT_DATE + 9, 1, 900000, 900000, 'cancelled', 'pending', 'Турист экранов', NOW() - INTERVAL '60 days') RETURNING id`,
      [tourId, touristId],
    );
    await pool.query(
      `INSERT INTO crm_contact_links (contact_id, partner_id, source_kind, source_id, occurred_at)
       VALUES ($1, $2, 'operator_booking', $3, NOW())`, [contactId, operatorId, String(cancelled.rows[0].id)],
    );
    await pool.query(
      `INSERT INTO crm_contacts (partner_id, display_name, origin) VALUES ($1, 'Знакомый с рыбалки', 'manual')`, [operatorId],
    );

    const { items, total, summary } = await listOperatorClients(operatorId, { limit: 20, offset: 0, sort: 'sum' }, pool);
    expect(total).toBe(2);
    // Отменённая бронь на 900 000 не делает клиента VIP и не идёт ни в число, ни в сумму.
    expect(items[0]).toMatchObject({ id: contactId, stats: { bookings: 1, booked_sum: 10000, segment: 'active' } });
    expect(items[1].stats).toMatchObject({ bookings: 0, booked_sum: 0, last_booking_at: null, segment: 'none' });
    expect(summary).toEqual({ clients: 2, vip: 0, bookings: 1, booked_sum: 10000 });

    const onlyNone = await listOperatorClients(operatorId, { limit: 20, offset: 0, segment: 'none' }, pool);
    expect(onlyNone.items.map((i) => i.display_name)).toEqual(['Знакомый с рыбалки']);
    // Итоги — по всей базе, фильтр их не сужает.
    expect(onlyNone.summary.clients).toBe(2);
    const byTag = await listOperatorClients(operatorId, { limit: 20, offset: 0, tag: 'постоянный' }, pool);
    expect(byTag.total).toBe(1);
    const byPhone = await listOperatorClients(operatorId, { limit: 20, offset: 0, q: '0000000' }, pool);
    expect(byPhone.items.map((i) => i.id)).toEqual([contactId]);

    // Чужой оператор этих клиентов не видит.
    const other = await pool.query(OPERATOR_CLIENTS_COUNT_SQL, ['00000000-0000-0000-0000-000000000000', null, null, null, null]);
    expect(other.rows[0].total).toBe(0);
    // Все три текста разбираются и с заполненными параметрами.
    for (const sort of ['recent', 'sum', 'bookings']) {
      await pool.query(OPERATOR_CLIENTS_LIST_SQL, [operatorId, '%тур%', '%000%', 'постоянный', 'vip', sort, 5, 0]);
    }
    await pool.query(OPERATOR_CLIENTS_SUMMARY_SQL, [operatorId, null, null, null]);
  });

  it('миграция 1200: метки и Telegram старого экрана — в клиента CRM, повтор ничего не дублирует', async () => {
    await pool.query(
      `INSERT INTO operator_client_notes (operator_id, user_id, tags, telegram)
       VALUES ($1, $2, '{VIP-лично,постоянный,"  "}', 'tourist_tg')`, [operatorId, touristId],
    );
    const sql = readFileSync(join(process.cwd(), 'migrations', '1200_operator_client_notes_to_crm.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const r = await pool.query<{ tags: string[]; notes: string | null }>(
      `SELECT tags, notes FROM crm_contacts WHERE id = $1`, [contactId],
    );
    // Порядок меток контакта сохранён, новая — в конце, пустая не перенесена.
    expect(r.rows[0].tags).toEqual(['постоянный', 'VIP-лично']);
    expect(r.rows[0].notes).toBe('Telegram: @tourist_tg');
    // Клиент без аккаунта заметок не получил.
    const manual = await pool.query<{ tags: string[]; notes: string | null }>(
      `SELECT tags, notes FROM crm_contacts WHERE partner_id = $1 AND origin = 'manual'`, [operatorId],
    );
    expect(manual.rows[0]).toEqual({ tags: [], notes: null });
  });

  it('«Аналитика»: все пять запросов исполняются, выручка — retail_amount', async () => {
    const revenue = await pool.query<{ total_revenue: string }>(ANALYTICS_SQL.revenueByMonth, [operatorId, since]);
    expect(Number(revenue.rows[0]?.total_revenue)).toBe(10000);
    const top = await pool.query<{ tour_title: string; total_revenue: string }>(ANALYTICS_SQL.topTours, [operatorId, since]);
    expect(top.rows[0]).toMatchObject({ tour_title: 'Тур экранов' });
    expect(Number(top.rows[0].total_revenue)).toBe(10000);
    const conv = await pool.query<{ total_bookings: number; conversion_rate: string }>(ANALYTICS_SQL.conversion, [operatorId, since]);
    expect(conv.rows[0].total_bookings).toBe(1);
    const st = await pool.query<{ status: string; count: string }>(ANALYTICS_SQL.statusBreakdown, [operatorId, since]);
    expect(st.rows.map((r) => r.status)).toEqual(['confirmed']);
    const sum = await pool.query<{ total_revenue: string; total_bookings: string }>(ANALYTICS_SQL.summary, [operatorId, since]);
    expect(Number(sum.rows[0].total_revenue)).toBe(10000);
    expect(Number(sum.rows[0].total_bookings)).toBe(1);
  });

  it('«Гиды»: запрос исполняется, считает подтверждённые аттестации, чужих гидов не показывает', async () => {
    const r = await pool.query<{ name: string; verified_certifications: string; tours_count: string }>(GUIDES_SQL, [operatorId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: 'Гид экранов', verified_certifications: '1', tours_count: '0' });
    const other = await pool.query(GUIDES_SQL, ['00000000-0000-0000-0000-000000000000']);
    expect(other.rows).toHaveLength(0);
  });
});
