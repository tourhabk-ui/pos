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
import { searchSql, searchParams } from '@/lib/mcp/connector-tools';
import { placesSearchQuery, routesSearchQuery, parksSearchQuery } from '@/lib/search/geo-query';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[mcp-search.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'mcp_search_test';

withPg('search коннектора на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });

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

// ── Поиск в шапке сайта (/api/search) тем же правилом слов (05.11) ──────────
//
// До этого дня шапка искала места, маршруты и парки всей строкой одним ILIKE:
// «озеро Курильское» не находило «Курильское озеро», «Kurile Lake» — ничего,
// скрытые места находились. Запросы lib/search/geo-query здесь ИСПОЛНЯЮТСЯ на
// схеме прода: неиспользованный параметр или ORDER BY по псевдониму рядом с
// выражением статикой не судятся. Своя база `search_geo_test`.

const GEO_TEST_DB = 'search_geo_test';
const LAKE = 'Пробное Курильское озеро';
const HIDDEN = 'Пробное Курильское озеро скрытое';
const ALIASED = 'Пробный вулкан Алиасный';
const ROUTE_ID = '7b1c0a52-0000-4000-8000-00000000d051';

withPg('поиск в шапке сайта по словам (lib/search/geo-query, 05.11)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, GEO_TEST_DB);
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
