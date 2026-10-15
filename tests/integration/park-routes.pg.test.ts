/**
 * Маршруты на странице парка и ссылка «страница парка» у маршрута — на
 * настоящем PostgreSQL (14.10, миграция 1250).
 *
 * Связь держится на ILIKE свободного `park_name` по корню имени парка, и корень
 * «Южно-Камчат» одинаково находит кластер национального парка «Вулканы
 * Камчатки» и федеральный заказник у Курильского озера (проба 876: четыре
 * маршрута заказника из одиннадцати с этим корнем). Правило «имя со словом
 * „заказник“ — маршрут заказника» живёт в SQL, мок ответил бы на него чем
 * угодно, поэтому здесь исполняются сами запросы из lib/parks — на схеме
 * прода, в своей базе из шаблона (tests/helpers/pg-schema.ts).
 *
 * До 15.10 таблицы здесь писались руками и без `kamchatka_routes.category`,
 * которая у прода NOT NULL: фикстура заводила маршруты, каких прод не примет
 * (аудит 15.10, P2-10).
 *
 * С миграцией 1252 у заказника своя страница с тем же корнем — правило
 * симметрично: заказник не берёт маршруты парка, парк — маршруты заказника.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PARK_ROUTES_SQL } from '../../lib/parks/park-page';
import { routeInParkSql } from '../../lib/parks/route-in-park';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[park-routes] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const TEST_DB = 'park_routes_test';

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
/** Имя и корень — как в миграции 1252. */
const ZAKAZNIK = 'Южно-Камчатский федеральный заказник';

withPg('маршруты парка и заказник-тёзка', () => {
  let pool: Pool;

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    // Миграции 1250 и 1252 сами заводят парки, и сцена должна быть ровно
    // той, что описана выше: своя база — заменяем парки целиком.
    await pool.query('DELETE FROM parks');
    for (const [title, parkName] of ROUTES) {
      // `category` у прода NOT NULL — маршрута без рода прод не примет.
      // Имя и slug — одним параметром, а типы у прода разные: явное приведение.
      await pool.query(
        `INSERT INTO kamchatka_routes (category, title, slug, park_name) VALUES ('hiking', $1::text, $1::text, $2)`,
        [title, parkName],
      );
    }
    await pool.query(`INSERT INTO parks (slug, display_name, search_term) VALUES
      ('yuzhno-kamchatsky', $1, 'Южно-Камчат'),
      ('yuzhno-kamchatsky-zakaznik', $2, 'Южно-Камчатск'),
      ('klyuchevskoy', 'Национальный парк «Вулканы Камчатки» — «Ключевской»', 'Ключевск')`, [NATIONAL, ZAKAZNIK]);
    // Первый файл прогона строит шаблон схемы — это дольше умолчания в 10 с.
  }, 300_000);

  afterAll(async () => {
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

  it('страница заказника берёт свои маршруты — и только их, не парка-тёзки', async () => {
    expect(await parkRoutes('Южно-Камчатск', ZAKAZNIK)).toEqual(['Курильское озеро', 'Кутхины Баты', 'Озеро у кордона'].sort());
    // Корень парка короче — и всё равно не тянет маршруты парка на страницу заказника.
    expect(await parkRoutes('Южно-Камчат', ZAKAZNIK)).toEqual(['Курильское озеро', 'Кутхины Баты', 'Озеро у кордона'].sort());
  });

  it('прочие парки — как прежде', async () => {
    expect(await parkRoutes('Ключевск', 'Национальный парк «Вулканы Камчатки» — «Ключевской»'))
      .toEqual(['Восхождение на Плоский Толбачик']);
  });

  it('карточка маршрута: у парка — страница парка, у заказника — страница заказника', async () => {
    expect(await parkPageOf('Южно-Камчатский')).toBe('yuzhno-kamchatsky');
    expect(await parkPageOf('Южно-Камчатский заказник федерального значения')).toBe('yuzhno-kamchatsky-zakaznik');
    expect(await parkPageOf('Южно-Камчатский заказник имени Т.И. Шпиленка')).toBe('yuzhno-kamchatsky-zakaznik');
    expect(await parkPageOf('Природный парк «Ключевской»')).toBe('klyuchevskoy');
    expect(await parkPageOf(null)).toBeNull();
  });
});
