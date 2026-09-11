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
import {
  COMPLETENESS_TOURS_SQL, buildClientsSql, ANALYTICS_SQL, GUIDES_SQL,
} from '@/lib/operator/screen-queries';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[operator-screens.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'operator_screens_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = '863';

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
    await pool.query(`DELETE FROM _migrations WHERE name >= $1`, [FIRST_AFTER_BASELINE]);
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

  it('«Клиенты»: CTE со статусом исполняется во всех формах (поиск, статус, сортировки)', async () => {
    for (const sortCol of ['total_spent', 'total_bookings', 'last_booking_date', 'name'] as const) {
      const plain = buildClientsSql({ search: false, status: false, sortCol, order: 'DESC' });
      const count = await pool.query<{ total: number }>(plain.countSql, [operatorId]);
      expect(count.rows[0].total).toBe(1);
      const data = await pool.query(plain.dataSql, [operatorId, 20, 0]);
      expect(data.rows[0]).toMatchObject({ name: 'Турист экранов', total_bookings: 1, status: 'active' });
    }
    const both = buildClientsSql({ search: true, status: true, sortCol: 'name', order: 'ASC' });
    const filtered = await pool.query(both.dataSql, [operatorId, '%экранов%', 'active', 20, 0]);
    expect(filtered.rows).toHaveLength(1);
    const miss = await pool.query(both.countSql, [operatorId, '%никого%', 'vip']);
    expect(miss.rows[0].total).toBe(0);
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
