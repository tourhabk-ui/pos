/**
 * Место по ссылке на карту (`/map?place=…`, `lib/map/map-focus.ts`) на
 * настоящем PostgreSQL из миграций: id, ark_id и slug находят одно место;
 * скрытое, слитое и без координаты — «не найдено», точку «на глаз» карта не
 * ставит; id для листа места — в пространстве `/api/places/[id]` (ark_id).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[map-focus] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const TEST_DB = 'map_focus_test';
const ARK = '11111111-2222-4333-8444-555555555555';

withPg('место по ссылке на карту', () => {
  let pool: Pool;
  let loadMapFocus: typeof import('@/lib/map/map-focus').loadMapFocus;

  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new PgPool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    ({ loadMapFocus } = await import('@/lib/map/map-focus'));

    await pool.query('TRUNCATE route_waypoints, kamchatka_routes, places CASCADE');
    // Тип slug и name у колонок разный — явное приведение (урок 42P08).
    await pool.query(
      `INSERT INTO places (id, ark_id, slug, name, lat, lng, location_type, is_visible)
       VALUES ('place-mutnovsky', $1::uuid, 'mutnovsky', 'Вулкан Мутновский', 52.4497, 158.1956, 'volcano', true)`,
      [ARK],
    );
    await pool.query(
      `INSERT INTO places (id, ark_id, slug, name, lat, lng, location_type, is_visible)
       VALUES ('place-no-ark', NULL, 'no-ark', 'Озеро без ark', 53.1, 158.4, 'lake', true)`,
    );
    await pool.query(
      `INSERT INTO places (id, ark_id, slug, name, lat, lng, location_type, is_visible)
       VALUES ('place-hidden', gen_random_uuid(), 'hidden', 'Скрытое', 53.0, 158.0, 'lake', false)`,
    );
    await pool.query(
      `INSERT INTO places (id, ark_id, slug, name, lat, lng, location_type, is_visible, merged_into_id)
       VALUES ('place-merged', gen_random_uuid(), 'merged', 'Слитое', 53.0, 158.0, 'lake', true, gen_random_uuid())`,
    );
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('по slug, id и ark_id — одно и то же место с записанной координатой; id — ark_id', async () => {
    for (const ref of ['mutnovsky', 'place-mutnovsky', ARK]) {
      expect(await loadMapFocus(ref)).toEqual({
        state: 'place',
        place: { id: ARK, title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.4497, lng: 158.1956 },
      });
    }
  });

  it('без ark_id — id места, тот, что принимает /api/places/[id]', async () => {
    const r = await loadMapFocus('no-ark');
    expect(r).toMatchObject({ state: 'place', place: { id: 'place-no-ark', locationType: 'lake' } });
  });

  it('скрытое, слитое и неизвестное — «не найдено»', async () => {
    for (const ref of ['hidden', 'merged', 'net-takogo']) expect(await loadMapFocus(ref)).toEqual({ state: 'not_found' });
  });

  it('место без координаты — «не найдено»: точку на глаз не ставим', async () => {
    // Колонки координат у прода NOT NULL по CLAUDE.md, у тестовой схемы — нет:
    // правило в запросе, а не в надежде на ограничение.
    const nullable = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'places' AND column_name = 'lat'`,
    );
    if (nullable.rows[0]?.is_nullable === 'YES') {
      await pool.query(
        `INSERT INTO places (id, ark_id, slug, name, lat, lng, location_type, is_visible)
         VALUES ('place-nocoord', gen_random_uuid(), 'nocoord', 'Без координаты', NULL, NULL, 'lake', true)`,
      );
      expect(await loadMapFocus('nocoord')).toEqual({ state: 'not_found' });
    } else {
      expect(nullable.rows[0]?.is_nullable).toBe('NO');
    }
  });
});
