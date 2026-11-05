/**
 * Поиск в шапке сайта (/api/search) по словам — на настоящем PostgreSQL (05.11).
 *
 * До этого дня места, маршруты и парки шапка искала всей строкой одним ILIKE:
 * «озеро Курильское» не находило «Курильское озеро», «Kurile Lake» — ничего;
 * скрытые места (is_visible = false) находились. Запросы lib/search/geo-query
 * здесь ИСПОЛНЯЮТСЯ на схеме прода (baseline + миграции): форму SQL доказывает
 * только сервер — неиспользованный параметр или ORDER BY по псевдониму рядом с
 * выражением статикой не судятся.
 *
 * Своя база `search_geo_test`. Без KERNEL_PG_TEST_URL файл честно пропускается.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { placesSearchQuery, routesSearchQuery, parksSearchQuery } from '@/lib/search/geo-query';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[search-geo-words.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'search_geo_test';
const LAKE = 'Пробное Курильское озеро';
const HIDDEN = 'Пробное Курильское озеро скрытое';
const ALIASED = 'Пробный вулкан Алиасный';
const ROUTE_ID = '7b1c0a52-0000-4000-8000-00000000d051';

withPg('поиск в шапке по словам — настоящий PostgreSQL', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, location_type, is_visible) VALUES
         ('probe-lake', $1, 51.45, 157.1, 'lake', TRUE),
         ('probe-hidden', $2, 51.46, 157.1, 'lake', FALSE),
         ('probe-aliased', $3, 53.3, 158.8, 'volcano', TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [LAKE, HIDDEN, ALIASED],
    );
    await pool.query(
      `INSERT INTO place_aliases (place_id, alias) VALUES ('probe-aliased', 'Пробная сопка Псевдонимная')`,
    );
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, is_visible)
       VALUES ($1, 'trekking', 'Пробная тропа к Курильскому озеру', TRUE)`,
      [ROUTE_ID],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('все три запроса исполняются на схеме прода для одного, двух и шести слов', async () => {
    for (const q of ['озеро', 'озеро Курильское', 'вулкан озеро гейзер медведь сплав рыбалка', '%', 'и']) {
      for (const built of [placesSearchQuery(q, 4), routesSearchQuery(q, 4), parksSearchQuery(q)]) {
        const res = await pool.query(built.sql, built.params);
        expect(Array.isArray(res.rows)).toBe(true);
      }
    }
  });

  it('«озеро Курильское» находит «Курильское озеро» первым по числу слов; скрытое место не находится', async () => {
    const built = placesSearchQuery('озеро Курильское пробное', 20);
    const { rows } = await pool.query<{ title: string; hits: number | string }>(built.sql, built.params);
    const titles = rows.map((r) => r.title);
    expect(titles[0]).toBe(LAKE);
    expect(Number(rows[0].hits)).toBe(3);
    expect(titles).not.toContain(HIDDEN);
    for (let i = 1; i < rows.length; i++) expect(Number(rows[i - 1].hits)).toBeGreaterThanOrEqual(Number(rows[i].hits));
  });

  it('по-английски: «Kurile Lake» находит место и маршрут', async () => {
    const p = placesSearchQuery('Kurile Lake', 50);
    const places = (await pool.query<{ title: string }>(p.sql, p.params)).rows.map((r) => r.title);
    expect(places).toContain(LAKE);
    const r = routesSearchQuery('Kurile Lake', 50);
    const routes = (await pool.query<{ id: string; title: string }>(r.sql, r.params)).rows;
    expect(routes.map((x) => x.title)).toContain('Пробная тропа к Курильскому озеру');
  });

  it('псевдоним тоже ищется по словам: «сопка Псевдонимная» находит место', async () => {
    const built = placesSearchQuery('Псевдонимная сопка', 10);
    const titles = (await pool.query<{ title: string }>(built.sql, built.params)).rows.map((r) => r.title);
    expect(titles[0]).toBe(ALIASED);
  });

  it('«%» ищется буквой, а не маской «всё подряд»', async () => {
    const built = placesSearchQuery('%', 50);
    const { rows } = await pool.query(built.sql, built.params);
    expect(rows).toHaveLength(0);
  });
});
