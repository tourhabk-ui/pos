/**
 * search коннектора на настоящем PostgreSQL (12.10, #2371).
 *
 * Форму SQL доказывает только сервер (§4.0 «судить статикой запрещено»):
 * четыре запроса поиска собираются из слов запроса (lib/mcp/search-terms) с
 * параметром на каждое слово и рангом `hits` в ORDER BY — здесь они
 * ИСПОЛНЯЮТСЯ на схеме из baseline прода + всех миграций, тем же путём, что
 * у деплоя. Живой случай: «Курильское озеро медведи» на проде отвечал пусто,
 * пока вся строка шла в ILIKE одним куском.
 *
 * Своя база `mcp_search_test` (приём operator-screens). Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { searchSql, searchParams } from '@/lib/mcp/connector-tools';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[mcp-search.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'mcp_search_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('search коннектора на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;

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
    // Порог — ЧИСЛОМ (как в operator-screens.pg): текстовое сравнение
    // оставило бы миграции от 1000 помеченными применёнными.
    await pool.query(
      `DELETE FROM _migrations
        WHERE (regexp_match(name, '^(\\d+)_'))[1]::int >= $1`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    // Посев: оператор и два опубликованных тура; в описании одного — медведи.
    // База не пуста: миграции (1176, 1217) сами вставляют туры про Курильское
    // озеро, поэтому названия тестовых строк уникальны, а ожидания — о порядке
    // и присутствии, не о точном списке.
    const op = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Оператор поиска', 'operator', '{"phone":"+70000000000"}', TRUE, TRUE, 'search-op') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO operator_tours (operator_id, title, description, base_price, max_participants, is_active, is_published, activity_type, difficulty, duration_hours)
       VALUES ($1, 'Курильское озеро — проба трёх слов', 'Медведи на нересте лосося, вертолётная экскурсия.', 105000, 10, TRUE, TRUE, 'helicopter', 'easy', 6),
              ($1, 'Озеро проба одного слова', 'Джип-тур к озеру.', 14000, 10, TRUE, TRUE, 'jeep', 'easy', 8),
              ($1, 'Черновик проба медведей', 'Медведи, но тур не опубликован.', 1000, 10, TRUE, FALSE, 'jeep', 'easy', 8)`,
      [op.rows[0].id],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('четыре запроса исполняются на схеме прода для одного, трёх и шести слов', async () => {
    for (const q of ['сплав', 'Курильское озеро медведи', 'вулкан озеро гейзер медведь сплав рыбалка']) {
      const params = searchParams(q);
      const sql = searchSql(params.length - 1);
      for (const kind of ['tour', 'place', 'stay', 'route'] as const) {
        const res = await pool.query(sql[kind], params);
        expect(Array.isArray(res.rows)).toBe(true);
      }
    }
  });

  it('«Курильское озеро медведи»: тур с тремя словами выше тура с одним, выдача упорядочена по hits; неопубликованный не виден', async () => {
    const params = searchParams('Курильское озеро медведи');
    const res = await pool.query<{ title: string; hits: number | string }>(searchSql(params.length - 1).tour, params);
    const titles = res.rows.map((r) => r.title);
    const three = titles.indexOf('Курильское озеро — проба трёх слов');
    const one = titles.indexOf('Озеро проба одного слова');
    expect(three).toBeGreaterThanOrEqual(0);
    expect(Number(res.rows[three].hits)).toBe(3);
    // Строка с одним словом либо ниже, либо не влезла в десятку — но не выше.
    if (one >= 0) {
      expect(one).toBeGreaterThan(three);
      expect(Number(res.rows[one].hits)).toBe(1);
    }
    const hits = res.rows.map((r) => Number(r.hits));
    expect([...hits].sort((a, b) => b - a)).toEqual(hits);
    expect(titles).not.toContain('Черновик проба медведей');
  });

  it('«Kurile Lake bears» находит то же через словарь — тот же тур с тремя совпадениями', async () => {
    const params = searchParams('Kurile Lake bears');
    const res = await pool.query<{ title: string; hits: number | string }>(searchSql(params.length - 1).tour, params);
    const row = res.rows.find((r) => r.title === 'Курильское озеро — проба трёх слов');
    expect(row).toBeDefined();
    expect(Number(row!.hits)).toBe(3);
  });
});
