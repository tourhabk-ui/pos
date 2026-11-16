/**
 * Дубли индексов (#3388 п.4, шаг 1) — запрос к каталогу на настоящем
 * PostgreSQL: модель схемы прода (baseline + все миграции) и сцена с
 * известными индексами. Что считается точным дублем, решает сервер: порядок
 * сортировки, условие частичного индекса и выражение различают индексы.
 *
 * Своя база `duplicate_indexes_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';
import { DUPLICATE_INDEXES_SQL, planDuplicateDrops, type DuplicateGroup } from '@/lib/db/duplicate-indexes';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[duplicate-indexes.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

withPg('дубли индексов на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, 'duplicate_indexes_test');
    pool = new Pool({ connectionString: dbUrl, max: 2 });
  }, 300_000);

  afterAll(async () => { await pool?.end().catch(() => undefined); });

  const groups = async () => (await pool.query<DuplicateGroup>(DUPLICATE_INDEXES_SQL)).rows;

  it('модель схемы прода: пары с другим порядком сортировки — не дубли, под ограничением ничего не снимается', async () => {
    const g = await groups();
    const tables = g.map((x) => x.table_name);
    expect(tables).not.toContain('conversation_messages');
    expect(tables).not.toContain('cancellation_policies');
    const plan = planDuplicateDrops(g);
    const byName = new Map(g.flatMap((x) => x.indexes).map((i) => [i.name, i]));
    for (const d of plan.drops) {
      for (const name of d.drop) {
        const i = byName.get(name)!;
        expect(i.primary || i.backs_constraint, `${name} держит ограничение`).toBe(false);
      }
    }
    // Сколько групп на модели — называет сам прогон; на 16.11 их 28.
    expect(g.length).toBeGreaterThan(0);
  });

  it('сцена: точный дубль найден, порядок сортировки, предикат и выражение различают', async () => {
    await pool.query(`CREATE TABLE dup_scene (a int, b int, s text)`);
    await pool.query(`CREATE INDEX dup_scene_a_b ON dup_scene (a, b)`);
    await pool.query(`CREATE INDEX dup_scene_a_b_twin ON dup_scene (a, b)`);
    await pool.query(`CREATE INDEX dup_scene_a_b_desc ON dup_scene (a, b DESC)`);
    await pool.query(`CREATE INDEX dup_scene_a_partial ON dup_scene (a) WHERE b IS NOT NULL`);
    await pool.query(`CREATE INDEX dup_scene_a ON dup_scene (a)`);
    await pool.query(`CREATE INDEX dup_scene_lower ON dup_scene (lower(s))`);
    await pool.query(`CREATE INDEX dup_scene_s ON dup_scene (s)`);
    const mine = (await groups()).filter((x) => x.table_name === 'dup_scene');
    expect(mine.map((x) => x.indexes.map((i) => i.name))).toEqual([['dup_scene_a_b', 'dup_scene_a_b_twin']]);
    expect(planDuplicateDrops(mine).drops).toEqual([
      { table: 'dup_scene', keep: 'dup_scene_a_b_twin', drop: ['dup_scene_a_b'] },
    ]);
  });
});
