/**
 * Маршруты на странице парка и ссылка «страница парка» у маршрута — на
 * настоящем PostgreSQL (14.10, миграция 1250).
 *
 * Связь держится на ILIKE свободного `park_name` по корню имени парка, и корень
 * «Южно-Камчат» одинаково находит кластер национального парка «Вулканы
 * Камчатки» и федеральный заказник у Курильского озера (проба 876: четыре
 * маршрута заказника из одиннадцати с этим корнем). Правило «имя со словом
 * „заказник“ — маршрут заказника» живёт в SQL, мок ответил бы на него чем
 * угодно, поэтому здесь исполняются сами запросы из lib/parks на таблицах в
 * своей схеме.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PARK_ROUTES_SQL } from '../../lib/parks/park-page';
import { routeInParkSql } from '../../lib/parks/route-in-park';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[park-routes] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const SCHEMA = 'park_routes_test';

/** [название, park_name] — имена park_name взяты с прода (проба 876). */
const ROUTES: Array<[string, string | null]> = [
  ['К подножию вулкана Мутновский', 'Южно-Камчатский'],
  ['Каньон Опасный', 'Южно-Камчатский'],
  ['Курильское озеро', 'Южно-Камчатский заказник федерального значения'],
  ['Кутхины Баты', 'Южно-Камчатский заказник имени Т.И. Шпиленка'],
  ['Озеро у кордона', 'Южно-Камчатский заказник'],
  ['Восхождение на Плоский Толбачик', 'Природный парк «Ключевской»'],
  ['Без парка', null],
];

const NATIONAL = 'Национальный парк «Вулканы Камчатки» — «Южно-Камчатский»';

withPg('маршруты парка и заказник-тёзка', () => {
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(`
      CREATE TABLE kamchatka_routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ark_id uuid, slug text,
        title text NOT NULL, description text, distance_km numeric, elevation_gain_m integer,
        duration_hours numeric, difficulty text, season text, mchs_registration_required boolean,
        hazards text[], park_name varchar(255), is_visible boolean NOT NULL DEFAULT true,
        view_count integer NOT NULL DEFAULT 0
      );
      CREATE TABLE parks (
        slug varchar(64) PRIMARY KEY, display_name varchar(255) NOT NULL,
        search_term varchar(128) NOT NULL, is_active boolean NOT NULL DEFAULT true
      );
    `);
    for (const [title, parkName] of ROUTES) {
      await pool.query(`INSERT INTO kamchatka_routes (title, slug, park_name) VALUES ($1, $1, $2)`, [title, parkName]);
    }
    await pool.query(`INSERT INTO parks (slug, display_name, search_term) VALUES
      ('yuzhno-kamchatsky', $1, 'Южно-Камчат'),
      ('klyuchevskoy', 'Национальный парк «Вулканы Камчатки» — «Ключевской»', 'Ключевск')`, [NATIONAL]);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  async function parkRoutes(searchTerm: string, displayName: string): Promise<string[]> {
    const { rows } = await pool.query<{ title: string }>(PARK_ROUTES_SQL, [searchTerm, displayName]);
    return rows.map((r) => r.title).sort();
  }

  /** Тот же фрагмент, что у карточки маршрута (lib/routes/route-detail). */
  async function parkPageOf(parkName: string | null): Promise<string | null> {
    const { rows } = await pool.query<{ slug: string }>(
      `SELECT slug FROM parks
        WHERE $1::text IS NOT NULL
          AND ${routeInParkSql('$1::text', 'search_term', 'display_name')}
          AND is_active
        LIMIT 1`,
      [parkName],
    );
    return rows[0]?.slug ?? null;
  }

  it('страница национального парка не берёт маршруты заказника-тёзки', async () => {
    expect(await parkRoutes('Южно-Камчат', NATIONAL)).toEqual(['Каньон Опасный', 'К подножию вулкана Мутновский'].sort());
  });

  it('страница заказника — если она появится — свои маршруты берёт', async () => {
    const titles = await parkRoutes('Южно-Камчат', 'Южно-Камчатский федеральный заказник');
    for (const t of ['Курильское озеро', 'Кутхины Баты', 'Озеро у кордона']) expect(titles).toContain(t);
  });

  it('прочие парки — как прежде', async () => {
    expect(await parkRoutes('Ключевск', 'Национальный парк «Вулканы Камчатки» — «Ключевской»'))
      .toEqual(['Восхождение на Плоский Толбачик']);
  });

  it('карточка маршрута: у парка — ссылка на страницу парка, у заказника — нет', async () => {
    expect(await parkPageOf('Южно-Камчатский')).toBe('yuzhno-kamchatsky');
    expect(await parkPageOf('Южно-Камчатский заказник федерального значения')).toBeNull();
    expect(await parkPageOf('Южно-Камчатский заказник имени Т.И. Шпиленка')).toBeNull();
    expect(await parkPageOf('Природный парк «Ключевской»')).toBe('klyuchevskoy');
    expect(await parkPageOf(null)).toBeNull();
  });
});
