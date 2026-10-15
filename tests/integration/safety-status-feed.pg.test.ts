/**
 * `safety_status` (#2495) на настоящем PostgreSQL: даты пунктов ленты,
 * остаток вне ленты и время тревог по одному соглашению — стенное UTC.
 *
 * Юнит-сторож (`tests/unit/safety-status-feed-2495.test.ts`) отвечает на
 * строки, которые сам же и подкладывает. Разбор имён колонок, DISTINCT ON по
 * заголовку и перевод `timestamp` без пояса в ISO делает только сервер — тот
 * же урок, что 42702 в дедупе (`alert-dedup.pg.test.ts`) и 42P08 в §4.0.
 *
 * Пояс сессии базы — московский, как на проде (+03), а не UTC контейнера CI:
 * при UTC любое прочтение стенного времени совпадает, и сторож был бы слеп.
 * `created_at`/`expires_at` — `timestamp` без пояса. Ингест пишет их датой JS
 * с сервера в UTC; сравнение `expires_at > NOW()` толковало их поясом сессии,
 * и тревога уходила из ленты на три часа раньше (15.10, владелец «го»).
 * Теперь код сравнивает и пишет стенным UTC, а миграция 1269 приводит лежащие
 * строки: ручные created_at (писались NOW() в поясе сессии), срок по
 * основанию (писался в поясе сессии) и погашенное, которое по новому правилу
 * ожило бы. Сценарий здесь — переход целиком: строки «как до», миграция,
 * новая тревога ингеста после выката, повтор миграции.
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

const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf-8');

/**
 * external_alerts — из самих миграций: CREATE TABLE из 070 и колонки
 * основания из 1212 (лента читает basis_*). Остальные колонки статус не
 * читает.
 */
function externalAlertsDdl(): string {
  const block = migration('070_safety_capacity_layer_fix.sql').match(/CREATE TABLE IF NOT EXISTS external_alerts \([\s\S]*?\);/);
  if (!block) throw new Error('в миграции 070 не найден CREATE TABLE external_alerts');
  return `${block[0]}\n${migration('1212_external_alerts_basis.sql')}`;
}

/**
 * location_real_time_status — НЕ из миграции: в 070 у неё внешний ключ на
 * legacy-таблицу agent_route_knowledge, которой здесь нет. Статус читает из
 * неё одно — MAX(updated_at), тип тот же, что в 070 (`timestamp`).
 */
const LRTS_DDL = 'CREATE TABLE IF NOT EXISTS location_real_time_status (id BIGSERIAL PRIMARY KEY, updated_at TIMESTAMP DEFAULT NOW())';

/** _migrations — как её заводит раннер (scripts/migrate-standalone.js). */
const MIGRATIONS_DDL = 'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())';

const UTC_WALL = '1269_external_alerts_utc_wall.sql';

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

// Сценарий #2495: пять тем в ленте, одна тема дважды, одно землетрясение,
// истёкшая строка. Ручные записи (manual-…) лежат «как до миграции»:
// created_at — стенное время пояса сессии, как его писал NOW().
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

/** Закрытие с основанием: срок продлён до действия приказа (road-basis-queue писал его в поясе сессии). */
const BASIS = {
  title: 'Октябрьская коса: проезд закрыт', external_id: 't.me/pravonarul/pg-basis',
  created: at(-5 * HOUR), validUntil: at(30 * HOUR),
};
/** Отозванное предупреждение: погашено через NOW() час назад — по-старому стенным временем сессии. */
const WITHDRAWN = { title: 'Росгидромет: снег — отозвано', external_id: 'meteoalert/pg-withdrawn', created: at(-10 * HOUR) };
/** Новая тревога ингеста после выката: срок через час — по старому правилу её бы уже не было. */
const LATE = { title: 'Росгидромет: ветер — до конца часа', external_id: 'mchs/pg-2495-late', created: at(-30 * 60_000), expires: at(HOUR) };

withPg('safety_status на настоящем PostgreSQL: даты, остаток и время тревог по UTC', () => {
  let pool: import('pg').Pool;
  let status: Awaited<ReturnType<typeof import('@/lib/safety/current-status').getCurrentSafetyStatus>>;
  let cs: typeof import('@/lib/safety/current-status');

  const rawCreated = async (externalId: string) =>
    (await pool.query<{ v: string }>(`SELECT created_at::text AS v FROM external_alerts WHERE external_id = $1`, [externalId])).rows[0]?.v;

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
    await pool.query(MIGRATIONS_DDL);
    await pool.query('TRUNCATE external_alerts, location_real_time_status, _migrations');
    await pool.query('INSERT INTO location_real_time_status (updated_at) VALUES (NOW())');

    // ── «Как до миграции» ──────────────────────────────────────────────────
    for (const r of ROWS) {
      // Ручная запись: created_at — как от NOW(), стенное время пояса сессии.
      // Ингест: стенное время UTC. Срок у обоих — стенное время UTC.
      const manual = r.external_id.startsWith('manual-');
      await pool.query(
        `INSERT INTO external_alerts (alert_type, severity, title, external_id, source_url, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, ${manual ? `($6::timestamptz AT TIME ZONE current_setting('TimeZone'))` : '$6::timestamp'}, $7::timestamp)`,
        [r.alert_type, r.severity, r.title, r.external_id, r.source_url,
          manual ? r.created.toISOString() : utcWall(r.created), utcWall(r.expires)],
      );
    }
    // Основание продлило срок: GREATEST(expires_at, $4::timestamptz) в колонку
    // timestamp — стенное время пояса сессии.
    await pool.query(
      `INSERT INTO external_alerts (alert_type, severity, title, external_id, created_at, expires_at,
                                    basis_title, basis_origin, basis_valid_until)
       VALUES ('road_closure', 1, $1, $2, $3::timestamp, ($4::timestamptz AT TIME ZONE current_setting('TimeZone')),
               'Приказ КГКУ «Камчатуправтодор» о закрытии', 'manual', $4::timestamptz)`,
      [BASIS.title, BASIS.external_id, utcWall(BASIS.created), BASIS.validUntil.toISOString()],
    );
    // Отозвано час назад: SET expires_at = NOW() — стенное время сессии.
    await pool.query(
      `INSERT INTO external_alerts (alert_type, severity, title, external_id, created_at, expires_at)
       VALUES ('weather', 1, $1, $2, $3::timestamp, LOCALTIMESTAMP - INTERVAL '1 hour')`,
      [WITHDRAWN.title, WITHDRAWN.external_id, utcWall(WITHDRAWN.created)],
    );

    // ── Выкат: миграция 1269, затем новая тревога ингеста ──────────────────
    await pool.query(migration(UTC_WALL));
    await pool.query(
      `INSERT INTO external_alerts (alert_type, severity, title, external_id, created_at, expires_at)
       VALUES ('weather', 1, $1, $2, $3::timestamp, $4::timestamp)`,
      [LATE.title, LATE.external_id, utcWall(LATE.created), utcWall(LATE.expires)],
    );

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

  it('счёт, лента и разбивка — по стенному UTC: тревога со сроком через час жива, отозванное погашено', () => {
    expect(status).not.toBeNull();
    // Живые: 7 из ROWS + основание + новая тревога; истёкшая и отозванная — нет.
    expect(status!.activeCount).toBe(9);
    expect(status!.feedCount).toBe(7);
    expect(status!.feedTitles).toContain(LATE.title);
    expect(status!.feedTitles).toContain(BASIS.title);
    expect(status!.feedTitles).not.toContain(WITHDRAWN.title);
    expect(status!.feedTitles).not.toContain(ROWS[7].title);
    expect(status!.outsideFeed).toEqual({ byType: [{ type: 'earthquake', count: 1 }], repeats: 1 });
  });

  it('даты пункта — тот же момент, что у события: и у ингеста, и у ручной записи после миграции', () => {
    const iso = (d: Date) => d.toISOString();
    const when = (title: string) => status!.feedWhen![status!.feedTitles!.indexOf(title)];

    expect(when(ROWS[1].title)).toEqual({ createdAt: iso(ROWS[1].created), expiresAt: iso(ROWS[1].expires), manual: true });
    // Из двух строк Халактырского лента держит ручную — у неё свежее created_at.
    expect(when(ROWS[2].title)).toEqual({ createdAt: iso(ROWS[2].created), expiresAt: iso(ROWS[2].expires), manual: true });
    expect(when(ROWS[0].title)).toEqual({ createdAt: iso(ROWS[0].created), expiresAt: iso(ROWS[0].expires), manual: false });
    // Срок по основанию — момент действия приказа, а не на три часа позже.
    expect(when(BASIS.title)?.expiresAt).toBe(iso(BASIS.validUntil));
  });

  it('миграция однократна: повтор ничего не сдвигает', async () => {
    const before = await rawCreated(ROWS[1].external_id);
    await pool.query(migration(UTC_WALL));
    expect(await rawCreated(ROWS[1].external_id)).toBe(before);
  });

  it('пропущенное время по умолчанию — стенное UTC, а не пояс сессии', async () => {
    const { rows } = await pool.query<{ created: string }>(
      `INSERT INTO external_alerts (alert_type, severity, title, external_id, expires_at)
       VALUES ('info', 0, 'Проверка умолчания', 'pg-default-check', (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 hour')
       RETURNING to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created`,
    );
    expect(Math.abs(Date.parse(rows[0].created) - Date.now())).toBeLessThan(60_000);
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
