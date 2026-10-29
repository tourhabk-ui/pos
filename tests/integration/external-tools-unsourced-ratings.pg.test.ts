/**
 * Каталог /ai-tools не показывает рейтинг, которого никто не ставил
 * (миграция 1341, 29.10). На настоящем PostgreSQL.
 *
 * 666 посеяла 48 инструментам «рейтинг» 4.2–4.9 без единой оценки, а
 * iNaturalist — «500 млн наблюдений от 7 млн натуралистов» без источника.
 * Судится то, что решает база:
 *  - реестр 1341 покрывает каждую посеянную пару (slug, rating) из 666 —
 *    пары вынимаются из самих файлов, а не переписаны в тест руками;
 *  - посев 666, затем 1341 — ни у одного посеянного инструмента нет числа;
 *  - число, которое поставил администратор (не совпадает с посевом), остаётся;
 *  - описание iNaturalist меняется, только если это текст 666; повтор
 *    миграции ничего не меняет.
 *
 * Своя база `external_tools_ratings_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[external-tools-unsourced-ratings.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'external_tools_ratings_test';
const read = (f: string) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8');
const SEED_666 = read('666_external_tools.sql');
const MIGRATION_1341 = read('1341_external_tools_unsourced_ratings.sql');

/** Посеянные пары 666: строка VALUES кончается на `is_free, api_available, rating)`. */
const SEEDED = [...SEED_666.matchAll(/^\('([a-z0-9-]+)',.*?, (?:true|false), (?:true|false), ([0-9.]+)\),?$/gm)]
  .map((m) => `${m[1]}=${Number(m[2])}`);
/** Пары реестра 1341. */
const REGISTRY = [...MIGRATION_1341.matchAll(/\('([a-z0-9-]+)', ([0-9.]+)\)/g)]
  .map((m) => `${m[1]}=${Number(m[2])}`);

/** Сам оператор посева 666: шаблонная база собрана из baseline — схема есть, данных 666 нет. */
const SEED_INSERT = (() => {
  const start = SEED_666.indexOf('INSERT INTO external_tools');
  const end = SEED_666.indexOf('ON CONFLICT (slug) DO NOTHING;', start);
  return SEED_666.slice(start, end + 'ON CONFLICT (slug) DO NOTHING;'.length);
})();

const INAT_666 = 'Определение животных, растений, грибов по фото. База из 500 млн наблюдений от 7 млн натуралистов.';

withPg('каталог внешних инструментов: рейтинг без оценок снят (1341)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    await pool.query(SEED_INSERT);
    await pool.query(MIGRATION_1341);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('реестр 1341 — ровно посев 666, ни одной пары не забыто и не придумано', () => {
    expect(SEEDED.length).toBeGreaterThan(40);
    expect([...REGISTRY].sort()).toEqual([...SEEDED].sort());
  });

  it('посев 666, затем 1341: у посеянных инструментов числа нет, описание iNaturalist без цифр', async () => {
    const slugs = SEEDED.map((p) => p.split('=')[0]);
    const r = await pool.query<{ slug: string; rating: string | null }>(
      'SELECT slug, rating FROM external_tools WHERE slug = ANY($1::text[])', [slugs],
    );
    expect(r.rows.length).toBe(slugs.length);
    expect(r.rows.filter((row) => row.rating !== null)).toEqual([]);
    const inat = await pool.query<{ description: string }>(`SELECT description FROM external_tools WHERE slug = 'inaturalist'`);
    expect(inat.rows[0].description).not.toMatch(/млн/);
  });

  it('посев снимается, число администратора остаётся, повтор ничего не меняет', async () => {
    await pool.query(`UPDATE external_tools SET rating = 4.8 WHERE slug = 'windy'`);
    await pool.query(`UPDATE external_tools SET rating = 3.0 WHERE slug = 'deepl'`);
    await pool.query(`UPDATE external_tools SET description = $1 WHERE slug = 'inaturalist'`, [INAT_666]);
    await pool.query(`UPDATE external_tools SET description = 'Своё описание администратора' WHERE slug = 'plantnet'`);

    await pool.query(MIGRATION_1341);
    const snapshot = async () => (await pool.query<{ slug: string; rating: string | null; description: string }>(
      `SELECT slug, rating, description FROM external_tools WHERE slug IN ('windy', 'deepl', 'inaturalist', 'plantnet') ORDER BY slug`,
    )).rows;
    const after = await snapshot();
    const by = Object.fromEntries(after.map((row) => [row.slug, row]));
    expect(by.windy.rating).toBeNull();
    expect(Number(by.deepl.rating)).toBe(3);
    expect(by.inaturalist.description).not.toBe(INAT_666);
    expect(by.inaturalist.description).not.toMatch(/млн/);
    expect(by.plantnet.description).toBe('Своё описание администратора');

    await pool.query(MIGRATION_1341);
    expect(await snapshot()).toEqual(after);
  });
});
