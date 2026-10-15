/**
 * `safety_status` (#2495) на настоящем PostgreSQL: даты пунктов ленты и
 * остаток вне ленты.
 *
 * Юнит-сторож (`tests/unit/safety-status-feed-2495.test.ts`) отвечает на
 * строки, которые сам же и подкладывает. Разбор имён колонок, DISTINCT ON по
 * заголовку и перевод `timestamp` без пояса в ISO делает только сервер — тот
 * же урок, что 42702 в дедупе (`alert-dedup.pg.test.ts`) и 42P08 в §4.0.
 * Первая редакция запроса ленты к тому же споткнулась о статический сторож
 * колонок: псевдонимы из подзапроса читались как колонки таблицы. Поэтому
 * форма двух новых запросов `getCurrentSafetyStatus` — ленты с датами и
 * разбивки остатка — проверяется здесь, на сервере.
 *
 * Пояс сессии базы — московский, как на проде (+03), а не UTC контейнера CI:
 * при UTC любое прочтение стенного времени совпадает, и сторож был бы слеп.
 * `created_at`/`expires_at` — `timestamp` без пояса со стенным временем UTC
 * (ингест пишет датой JS с сервера в UTC). Первая редакция читала их
 * `isoUtcSql` — по поясу сессии — и этот файл поймал сдвиг на три часа назад
 * на каждой строке ленты. Строки вставляются стенным временем UTC явно, а не
 * датой JS: результат не зависит от пояса машины, на которой идёт тест.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[safety-status-feed.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

/** Своя база: запросы идут через пул приложения, а он теряет search_path (см. alert-dedup.pg). */
const TEST_DB = 'safety_status_feed_test';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

if (PG_URL) {
  process.env.DATABASE_URL = withDatabase(PG_URL, TEST_DB);
  process.env.DATABASE_SSL = 'false';
}

/**
 * external_alerts — из самих миграций: CREATE TABLE из 070 и колонки
 * основания из 1212 (лента читает basis_*). Остальные колонки статус не
 * читает.
 */
function externalAlertsDdl(): string {
  const m070 = readFileSync(join(process.cwd(), 'migrations', '070_safety_capacity_layer_fix.sql'), 'utf-8');
  const block = m070.match(/CREATE TABLE IF NOT EXISTS external_alerts \([\s\S]*?\);/);
  if (!block) throw new Error('в миграции 070 не найден CREATE TABLE external_alerts');
  const m1212 = readFileSync(join(process.cwd(), 'migrations', '1212_external_alerts_basis.sql'), 'utf-8');
  return `${block[0]}\n${m1212}`;
}

/**
 * location_real_time_status — НЕ из миграции: в 070 у неё внешний ключ на
 * legacy-таблицу agent_route_knowledge, которой здесь нет. Статус читает из
 * неё одно — MAX(updated_at), тип тот же, что в 070 (`timestamp`).
 */
const LRTS_DDL = 'CREATE TABLE IF NOT EXISTS location_real_time_status (id BIGSERIAL PRIMARY KEY, updated_at TIMESTAMP DEFAULT NOW())';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Даты — относительно «сейчас»: литерал стал бы бомбой с часовым механизмом (alert-dedup.pg, 10.09). */
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

/** Стенное время UTC — так колонку заполняет ингест: «2026-10-15 01:30:00.000». */
const utcWall = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

interface Row {
  alert_type: string; severity: number; title: string; external_id: string; source_url: string | null;
  created: Date; expires: Date;
}

// Сценарий #2495: семь живых, пять тем в ленте, одна тема дважды, одно
// землетрясение; плюс истёкшая строка, которой нет нигде.
const ROWS: Row[] = [
  { alert_type: 'weather', severity: 2, title: 'Штормовое предупреждение: ветер до 25 м/с', external_id: 'mchs/pg-2495-1', source_url: null, created: at(-6 * HOUR), expires: at(18 * HOUR) },
  { alert_type: 'road_closure', severity: 1, title: 'Вилючинский перевал: проезд по пропускам с 15 июля', external_id: 'manual-vilyuchinsky-pass-pg', source_url: 'https://www.ustoym.ru', created: at(-104 * DAY), expires: at(78 * DAY) },
  { alert_type: 'road_closure', severity: 1, title: 'Халактырский пляж: дорога со стороны Дальнего перекрыта', external_id: 'manual-khalaktyrsky-road-pg', source_url: null, created: at(-98 * DAY), expires: at(259 * DAY) },
  // Та же тема из другой ленты, старше ручной записи: лента берёт одну строку
  // на заголовок, эта уходит в «повторы».
  { alert_type: 'road_closure', severity: 1, title: 'Халактырский пляж: дорога со стороны Дальнего перекрыта', external_id: 't.me/pravonarul/pg-2495', source_url: null, created: at(-120 * DAY), expires: at(5 * DAY) },
  { alert_type: 'bear', severity: 1, title: 'Медведи у посёлка Термальный', external_id: 'mchs/pg-2495-2', source_url: null, created: at(-30 * HOUR), expires: at(42 * HOUR) },
  { alert_type: 'volcanic_eruption', severity: 1, title: 'Шивелуч: выброс пепла', external_id: 'kbgs/pg-2495-1', source_url: null, created: at(-20 * HOUR), expires: at(6 * DAY) },
  { alert_type: 'earthquake', severity: 1, title: 'Землетрясение M4.1 в 80 км от Петропавловска', external_id: 'kbgs/pg-2495-2', source_url: null, created: at(-3 * HOUR), expires: at(21 * HOUR) },
  { alert_type: 'road_closure', severity: 2, title: 'Вачкажец: проезд закрыт', external_id: 'manual-vachkazhets-pg', source_url: null, created: at(-90 * DAY), expires: at(-HOUR) },
];

withPg('safety_status на настоящем PostgreSQL: даты пунктов и остаток вне ленты', () => {
  let pool: import('pg').Pool;
  let status: Awaited<ReturnType<typeof import('@/lib/safety/current-status').getCurrentSafetyStatus>>;
  let cs: typeof import('@/lib/safety/current-status');

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    const { rows } = await bootstrap.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEST_DB]);
    if (rows.length === 0) await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    // Пояс прода — для КАЖДОЙ новой сессии этой базы, включая пул приложения.
    await bootstrap.query(`ALTER DATABASE ${TEST_DB} SET timezone TO 'Europe/Moscow'`);
    await bootstrap.end();

    pool = new Pool({ connectionString: withDatabase(PG_URL, TEST_DB), max: 2 });
    const tz = await pool.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    expect(tz.rows[0].tz).toBe('Europe/Moscow');
    await pool.query(externalAlertsDdl());
    await pool.query(LRTS_DDL);
    await pool.query('TRUNCATE external_alerts, location_real_time_status');
    await pool.query('INSERT INTO location_real_time_status (updated_at) VALUES (NOW())');
    for (const r of ROWS) {
      await pool.query(
        `INSERT INTO external_alerts (alert_type, severity, title, external_id, source_url, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp)`,
        [r.alert_type, r.severity, r.title, r.external_id, r.source_url, utcWall(r.created), utcWall(r.expires)],
      );
    }
    cs = await import('@/lib/safety/current-status');
    status = await cs.getCurrentSafetyStatus();
  }, 60_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
    await bootstrap.end().catch(() => undefined);
  });

  it('оба запроса выполнились: счёт, лента и разбивка на месте', () => {
    expect(status).not.toBeNull();
    expect(status!.activeCount).toBe(7);
    expect(status!.feedCount).toBe(5);
    expect(status!.feedTitles).toHaveLength(5);
    expect(status!.outsideFeed).toEqual({ byType: [{ type: 'earthquake', count: 1 }], repeats: 1 });
  });

  it('даты пункта — тот же момент, которым строка вставлена; ручная запись узнана по external_id', () => {
    const iso = (d: Date) => d.toISOString();
    const byTitle = (t: string) => status!.feedTitles!.indexOf(t);

    const vil = byTitle(ROWS[1].title);
    expect(status!.feedWhen![vil]).toEqual({ createdAt: iso(ROWS[1].created), expiresAt: iso(ROWS[1].expires), manual: true });
    // Из двух строк Халактырского лента держит ручную — у неё свежее created_at.
    const khal = byTitle(ROWS[2].title);
    expect(status!.feedWhen![khal]).toEqual({ createdAt: iso(ROWS[2].created), expiresAt: iso(ROWS[2].expires), manual: true });
    const storm = byTitle(ROWS[0].title);
    expect(status!.feedWhen![storm]).toEqual({ createdAt: iso(ROWS[0].created), expiresAt: iso(ROWS[0].expires), manual: false });
    // Истёкшей строки нет нигде.
    expect(status!.feedTitles).not.toContain(ROWS[7].title);
  });

  it('ответ агенту: под пунктом — когда появился и до какого числа в ленте; остаток назван', async () => {
    const { alertDayLabel } = await import('@/lib/safety/alert-dates');
    const now = Date.now();
    const lines = cs.formatSafetyStatusForAgent(status, undefined, now).split('\n');
    const vil = lines.indexOf(`- ${ROWS[1].title}`);
    expect(vil).toBeGreaterThan(-1);
    expect(lines[vil + 1]).toBe(
      `  внесено вручную ${alertDayLabel(ROWS[1].created.toISOString(), now)}; в ленте до ${alertDayLabel(ROWS[1].expires.toISOString(), now)}`,
    );
    expect(lines).toContain('Остальные 2 — вне ленты туриста: землетрясения — 1, повторы уже названной темы — 1.');
  });
});
