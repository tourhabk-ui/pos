/**
 * Заметки Кузьмича о местах уходят к человеку только с источником (#3514,
 * слово владельца 19.11 «1 поменять ответ из источников»).
 *
 * Мир теста — настоящие файлы миграций: 141 (place/faq/transport без
 * источника), 669 (двадцать «традиционных знаний» с пометкой seed_indigenous),
 * 1377 (расстояния сверены) и 1462 (две записи переписаны фактами из
 * источника). Снимок схемы данных не несёт, поэтому записи 141 и 669 здесь
 * заводит их собственный SQL, а не подложенные строки.
 *
 * Судятся не тексты запросов, а то, что получает человек: область на
 * настоящем PostgreSQL, справка о месте (get_place_info) и ответ стража
 * (get_guardian_context) — вызовом.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { KUZMICH_KNOWLEDGE_SCOPE_SQL } from '@/lib/kuzmich/knowledge-scope';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { placeInfoForKuzmich } from '@/lib/kuzmich/place-info-tool';
import { getGuardianContextDetailed } from '@/lib/kuzmich/guardian-context';

const appDb = vi.hoisted(() => ({
  pool: null as null | { query: (sql: string, params?: unknown[]) => Promise<unknown> },
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => appDb.pool!.query(sql, params) },
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[kuzmich-knowledge-sourced.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'kuzmich_knowledge_sourced_test';
const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf-8');

withPg('заметки Кузьмича — только с источником (#3514)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    appDb.pool = pool;
    await pool.query(`DELETE FROM agent_knowledge`);
    for (const f of [
      '141_kuzmich_agent_knowledge.sql',
      '669_indigenous_knowledge_seed.sql',
      '1377_kuzmich_knowledge_distances.sql',
    ]) {
      await pool.query(migration(f));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  const scoped = async () => (await pool.query<{ slug: string }>(
    `SELECT slug FROM agent_knowledge WHERE ${KUZMICH_KNOWLEDGE_SCOPE_SQL} ORDER BY slug`,
  )).rows.map((r) => r.slug);

  it('до 1462: в базе 30 курируемых записей, и ни одна не проходит — у них нет источника', async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agent_knowledge
        WHERE agent_id = 'kuzmich' AND type IN ('place', 'faq', 'transport', 'indigenous')`,
    );
    expect(rows[0].n).toBe(30);
    expect(await scoped()).toEqual([]);
  });

  it('пометка «seed_indigenous» и адрес без схемы источником не считаются', async () => {
    await pool.query(
      `INSERT INTO agent_knowledge (slug, type, title, compiled_truth, agent_id, metadata) VALUES
         ('t-no-scheme', 'place', 'Тест без схемы', 'текст', 'kuzmich', '{"source_url":"paratunka-sp.ru"}'),
         ('t-blank', 'place', 'Тест пустой', 'текст', 'kuzmich', '{"source_url":"   "}'),
         ('t-with-space', 'place', 'Тест пробел', 'текст', 'kuzmich', '{"source_url":"https://a.ru/ b"}'),
         ('t-ok-other-agent', 'place', 'Тест чужой агент', 'текст', 'scout', '{"source_url":"https://a.ru/x"}'),
         ('t-ok-search', 'search_result', 'Тест поиск', 'текст', 'kuzmich', '{"source_url":"https://a.ru/x"}')`,
    );
    expect(await scoped()).toEqual([]);
    await pool.query(`DELETE FROM agent_knowledge WHERE slug LIKE 't-%'`);
  });

  it('1462 переписывает две записи фактами из источника, остальные 28 не трогает', async () => {
    const before = await pool.query<{ slug: string; compiled_truth: string }>(
      `SELECT slug, compiled_truth FROM agent_knowledge ORDER BY slug`,
    );
    await pool.query(migration('1462_kuzmich_notes_sourced.sql'));
    expect(await scoped()).toEqual(['malkinskie-springs', 'paratunka-thermal']);

    const after = await pool.query<{ slug: string; compiled_truth: string; metadata: Record<string, unknown> }>(
      `SELECT slug, compiled_truth, metadata FROM agent_knowledge ORDER BY slug`,
    );
    const was = new Map(before.rows.map((r) => [r.slug, r.compiled_truth]));
    for (const r of after.rows) {
      if (r.slug === 'paratunka-thermal' || r.slug === 'malkinskie-springs') {
        // Прежний текст сохранён — вернуть можно по одной записи.
        expect(r.metadata.withdrawn_truth).toBe(was.get(r.slug));
        // Ни цены, ни автобуса: в источниках 1377 их не сверяли.
        expect(r.compiled_truth).not.toMatch(/автобус|р\.|₽|руб/);
      } else {
        expect(r.compiled_truth, r.slug).toBe(was.get(r.slug));
      }
    }
    const paratunka = after.rows.find((r) => r.slug === 'paratunka-thermal');
    expect(paratunka?.compiled_truth).toContain('60 км');
    expect(paratunka?.compiled_truth).toContain('paratunka-sp.ru');

    // Повтор миграции ничего не меняет: withdrawn_truth не затирается новым текстом.
    await pool.query(migration('1462_kuzmich_notes_sourced.sql'));
    const again = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM agent_knowledge WHERE slug = 'paratunka-thermal'`,
    );
    expect(again.rows[0].metadata.withdrawn_truth).toBe(was.get('paratunka-thermal'));
  });

  it('get_place_info: о Курильском озере — ни «Камбальным», ни цены вертолёта; о Паратунке — заметка с источником', async () => {
    const kuril = await placeInfoForKuzmich('Курильское озеро');
    expect(kuril ?? '').not.toContain('Камбальным');
    expect(kuril ?? '').not.toContain('Заметка Кузьмича');
    expect(kuril ?? '').not.toContain('25 000');

    const paratunka = await placeInfoForKuzmich('Паратунка');
    expect(paratunka).toContain('Заметка Кузьмича «Паратунка — сколько ехать от Петропавловска»');
    expect(paratunka).toContain('paratunka-sp.ru');
    expect(paratunka).not.toContain('№111');
  });

  it('get_guardian_context: без «традиционных знаний» без источника; с источником — заметка в ответе', async () => {
    const koryak = await getGuardianContextDetailed('Корякский вулкан');
    expect(koryak.text).not.toContain('Кухх');
    expect(koryak.text).not.toContain('[Традиционные знания]');

    const malki = await getGuardianContextDetailed('Малкинские источники');
    expect(malki.text).toContain('130 км');
    expect(malki.text).toContain('topkam.ru');
    expect(malki.text).not.toContain('3000');
  });
});
