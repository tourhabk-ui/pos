/**
 * Editor не берёт места, пока модели запрещено писать их тексты (слово
 * владельца 22.10: «отключи агента выдумывающкюего описание мест такую пургу
 * придумал»; выключатель — lib/places/model-place-text.ts). На настоящем
 * PostgreSQL.
 *
 * Очередь Editor одна на прод и на раннер: editor-job отдаёт её раннеру,
 * editor-result по ней же сверяет присланный id. Мок ответил бы на любой SQL,
 * поэтому здесь судится сам отбор через VIEW agent_route_knowledge: из места
 * и маршрута без описания в очередь встаёт только маршрут.
 *
 * Своя база `editor_places_paused_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[editor-places-paused.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'editor_places_paused_test';

withPg('Editor без мест (слово владельца 22.10)', () => {
  let pool: import('pg').Pool;
  let placeArk = '';
  let routeArk = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query('TRUNCATE places, kamchatka_routes CASCADE');
    const p = await pool.query<{ ark_id: string }>(
      `INSERT INTO places (id, ark_id, name, slug, lat, lng, is_visible, location_type, description)
       VALUES (gen_random_uuid()::text, gen_random_uuid(), 'Озеро без описания', 'ozero-bez-opisaniya',
               53.1, 158.4, TRUE, 'lake', NULL)
       RETURNING ark_id::text`,
    );
    placeArk = p.rows[0].ark_id;
    const r = await pool.query<{ ark: string }>(
      `INSERT INTO kamchatka_routes (category, title, is_visible, description)
       VALUES ('trekking', 'Тропа без описания', TRUE, NULL)
       RETURNING COALESCE(ark_id, id)::text AS ark`,
    );
    routeArk = r.rows[0].ark;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('оба пустых видны в VIEW — сцена честная', async () => {
    const { rows } = await pool.query<{ id: string; kind: string }>(
      `SELECT id::text AS id, kind FROM agent_route_knowledge WHERE id::text = ANY($1::text[])`,
      [[placeArk, routeArk]],
    );
    expect(rows.map((r) => r.kind).sort()).toEqual(['place', 'route']);
  });

  it('очередь Editor берёт маршрут и не берёт место', async () => {
    const { findRoutesNeedingDescription } = await import('@/lib/agents/editor');
    const queue = await findRoutesNeedingDescription();
    const ids = queue.map((r) => String(r.id));
    expect(ids).toContain(routeArk);
    expect(ids).not.toContain(placeArk);
    expect(queue.every((r) => r.kind !== 'place')).toBe(true);
  });
});
