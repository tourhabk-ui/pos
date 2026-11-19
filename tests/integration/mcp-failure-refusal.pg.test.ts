/**
 * Сбой и отказ MCP — на настоящем PostgreSQL (владелец 08.10, панель MCP).
 *
 * Колонка «Ошибок» складывала падения инструментов с отказами по входу: из 36
 * внешних ошибок месяца сбоем после 04.10 не было ни одной, а get_place_info
 * горел красными «16». Теперь срез панели и перепись считают раздельно, и
 * вопросы здесь — серверные, мок ответил бы на любой SQL:
 *
 *  - строка без рода (`error_kind IS NULL`) — сбой, а не отказ: `NULL = ANY`
 *    даёт NULL, и неосторожный FILTER потерял бы её из обоих счётов;
 *  - сбой раньше первой строки `refused` — смесь (до #2191 отказ писался
 *    сбоем), позже — чистый сбой;
 *  - по дням сбои и отказы в сумме равны ошибкам — ни одна строка не выпала
 *    и не посчитана дважды;
 *  - перепись раскладывает внешние ошибки по клиенту, а проверки (смоук) в
 *    неё не попадают.
 *
 * Вторая часть файла — заметки Кузьмича только с источником (#3514).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';

const holder = vi.hoisted(() => ({ pool: null as null | { query: (sql: string, params?: unknown[]) => Promise<unknown> } }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => holder.pool!.query(sql, params) },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin', role: 'admin' }) }));

import { GET as panelGet } from '@/app/api/admin/analytics/mcp/route';
import { GET as censusGet } from '@/app/api/cron/mcp-census/route';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { KUZMICH_KNOWLEDGE_SCOPE_SQL } from '@/lib/kuzmich/knowledge-scope';
import { placeInfoForKuzmich } from '@/lib/kuzmich/place-info-tool';
import { getGuardianContextDetailed } from '@/lib/kuzmich/guardian-context';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

const TEST_DB = 'mcp_failure_refusal_test';

if (!PG_URL) {
  console.warn('[mcp-failure-refusal] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

/**
 * h1 — внешний клиент, h2 — смоук деплоя (проверка, в срез не входит).
 * Первая строка `refused` — 7 дней назад: сбой 10 дней назад — смесь,
 * сбой 5 дней назад — чистый.
 */
const SEED = `
INSERT INTO mcp_clients (caller_hash, day, client_name)
  SELECT 'h1', (NOW() - (d || ' days')::interval)::date, 'BrickBlueBot' FROM generate_series(0, 12) d;
INSERT INTO mcp_clients (caller_hash, day, client_name)
  SELECT 'h2', (NOW() - (d || ' days')::interval)::date, 'vedar-deploy-smoke' FROM generate_series(0, 12) d;
INSERT INTO mcp_tool_calls (tool, ok, error_kind, caller_hash, created_at, error_code, arg_key) VALUES
  ('get_place_info',   TRUE,  NULL,           'h1', NOW() - interval '1 day',   NULL,                 'name'),
  ('get_place_info',   FALSE, 'refused',      'h1', NOW() - interval '1 day',   'invalid_args:empty', NULL),
  ('get_place_info',   FALSE, 'execution',    'h1', NOW() - interval '5 days',  'pg:28P01',           'name'),
  ('get_tour_details', FALSE, 'execution',    'h1', NOW() - interval '10 days', NULL,                 NULL),
  ('get_tour_details', FALSE, 'refused',      'h1', NOW() - interval '7 days',  NULL,                 NULL),
  ('get_place_info',   FALSE, 'execution',    'h2', NOW() - interval '2 days',  'tool_failed',        'name'),
  ('unknown',          FALSE, 'unknown_tool', 'h1', NOW() - interval '2 days',  'unknown_tool',       NULL),
  ('get_weather',      FALSE, NULL,           'h1', NOW() - interval '3 days',  NULL,                 NULL);
`;

interface ToolRow { tool: string; calls_30d: number; errors_30d: number; failures_30d: number; failures_unsplit_30d: number; refusals_30d: number }
interface DayRow { errors: number; failures: number; refusals: number }

withPg('сбой и отказ MCP на настоящем PostgreSQL', () => {
  let pool: Pool;

  beforeAll(async () => {
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);

    pool = new Pool({ connectionString: dbUrl, max: 2 });
    // Сид не глушится: молчаливый отказ вставки сделал бы проверку счёта
    // проверкой пустоты.
    await pool.query(SEED);
    holder.pool = pool;
    process.env.CRON_SECRET = 'mcp-failure-refusal-secret';
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.end();
  });

  it('панель: сбои и отказы по инструменту раздельно, смесь до первого refused названа', async () => {
    const res = await panelGet(new NextRequest('http://localhost/api/admin/analytics/mcp'));
    expect(res.status).toBe(200);
    const json = await res.json() as { by_tool_30d: ToolRow[]; daily_30d: DayRow[]; origins_30d: { refused_since: string | null } };
    const by = Object.fromEntries(json.by_tool_30d.map((r) => [r.tool, r]));

    // Смоук (h2) не входит: у get_place_info три внешних вызова, сбой один.
    expect(by.get_place_info).toMatchObject({ calls_30d: 3, errors_30d: 2, failures_30d: 1, failures_unsplit_30d: 0, refusals_30d: 1 });
    // Сбой за три дня до первого refused — смесь.
    expect(by.get_tour_details).toMatchObject({ errors_30d: 2, failures_30d: 1, failures_unsplit_30d: 1, refusals_30d: 1 });
    // Строка без рода — сбой, а не потерянная.
    expect(by.get_weather).toMatchObject({ errors_30d: 1, failures_30d: 1, refusals_30d: 0 });
    expect(by.unknown).toMatchObject({ failures_30d: 0, refusals_30d: 1 });

    expect(json.daily_30d).toHaveLength(30);
    expect(json.daily_30d.every((d) => d.failures + d.refusals === d.errors)).toBe(true);
    expect(json.daily_30d.reduce((a, d) => a + d.failures, 0)).toBe(3);
    expect(json.daily_30d.reduce((a, d) => a + d.refusals, 0)).toBe(3);

    expect(json.origins_30d.refused_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('перепись: внешние ошибки по клиенту, проверки не входят; refused_since в отметках', async () => {
    const res = await censusGet(new NextRequest('http://localhost/api/cron/mcp-census?days=30', {
      headers: { authorization: 'Bearer mcp-failure-refusal-secret' },
    }));
    const json = await res.json() as {
      ok: boolean; failed_measures: unknown[];
      errors_by_client_external: Array<{ client: string; tool: string; error_code: string | null; n: number }>;
      marks: { refused_since: string | null };
    };
    expect(json.failed_measures).toEqual([]);
    expect(json.ok).toBe(true);
    expect(json.errors_by_client_external.length).toBeGreaterThan(0);
    expect(json.errors_by_client_external.every((r) => r.client === 'BrickBlueBot')).toBe(true);
    expect(json.errors_by_client_external.find((r) => r.error_code === 'invalid_args:empty')).toMatchObject({ tool: 'get_place_info', n: 1 });
    expect(json.marks.refused_since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

/**
 * ── Вторая часть файла: заметки Кузьмича (#3514) ──
 *
 * Здесь, а не отдельным файлом: число pg-файлов держит сторож
 * pg-tests-run-in-ci, а файл должен быть на шаблоне прода
 * (pg-tests-use-real-schema). Своя база, тот же мок пула приложения.
 *
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
const SOURCED_TEST_DB = 'kuzmich_knowledge_sourced_test';
const migrationFile = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf-8');

withPg('заметки Кузьмича — только с источником (#3514)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const dbUrl = await createTestDatabase(PG_URL, SOURCED_TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    holder.pool = pool;
    await pool.query(`DELETE FROM agent_knowledge`);
    for (const f of [
      '141_kuzmich_agent_knowledge.sql',
      '669_indigenous_knowledge_seed.sql',
      '1377_kuzmich_knowledge_distances.sql',
    ]) {
      await pool.query(migrationFile(f));
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (PG_URL) await dropTestDatabase(PG_URL, SOURCED_TEST_DB);
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

  it('пометка «seed_indigenous» и адрес без схемы источником не считаются; роды из разговоров не проходят и с адресом', async () => {
    await pool.query(
      `INSERT INTO agent_knowledge (slug, type, title, compiled_truth, agent_id, metadata) VALUES
         ('t-no-scheme', 'place', 'Тест без схемы', 'текст', 'kuzmich', '{"source_url":"paratunka-sp.ru"}'),
         ('t-blank', 'place', 'Тест пустой', 'текст', 'kuzmich', '{"source_url":"   "}'),
         ('t-with-space', 'place', 'Тест пробел', 'текст', 'kuzmich', '{"source_url":"https://a.ru/ b"}'),
         ('t-ok-other-agent', 'place', 'Тест чужой агент', 'текст', 'scout', '{"source_url":"https://a.ru/x"}'),
         ('t-ok-search', 'search_result', 'Тест поиск', 'текст', 'kuzmich', '{"source_url":"https://a.ru/x"}'),
         ('t-ok-outcome', 'outcome', 'Тест оценка', 'Вопрос: реплика человека', 'kuzmich', '{"source_url":"https://a.ru/x"}')`,
    );
    expect(await scoped()).toEqual([]);
    await pool.query(`DELETE FROM agent_knowledge WHERE slug LIKE 't-%'`);
  });

  it('1462 переписывает две записи фактами из источника, остальные 28 не трогает', async () => {
    const before = await pool.query<{ slug: string; compiled_truth: string }>(
      `SELECT slug, compiled_truth FROM agent_knowledge ORDER BY slug`,
    );
    await pool.query(migrationFile('1462_kuzmich_notes_sourced.sql'));
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
    await pool.query(migrationFile('1462_kuzmich_notes_sourced.sql'));
    const again = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM agent_knowledge WHERE slug = 'paratunka-thermal'`,
    );
    expect(again.rows[0].metadata.withdrawn_truth).toBe(was.get('paratunka-thermal'));
  });

  it('1464 снимает «по прямой 120 км» с заметки о Малки и больше ничего не трогает', async () => {
    const read = async () => new Map((await pool.query<{ slug: string; compiled_truth: string; metadata: Record<string, unknown> }>(
      `SELECT slug, compiled_truth, metadata FROM agent_knowledge ORDER BY slug`,
    )).rows.map((r) => [r.slug, r]));
    const before = await read();
    expect(before.get('malkinskie-springs')?.compiled_truth).toContain('по прямой — 120 км');

    await pool.query(migrationFile('1464_kuzmich_malki_no_straight_line.sql'));
    const after = await read();
    const malki = after.get('malkinskie-springs');
    expect(malki?.compiled_truth).toBe(
      'Малкинские горячие источники — у посёлка Малки, около 130 км от Петропавловска-Камчатского '
      + 'по трассе на Мильково, источники в 4 км от трассы (источники: topkam.ru, kamchatskiytour.ru, '
      + 'nextroute.ru, Википедия «Малки (Камчатский край)»).',
    );
    // Прежний текст 141 по-прежнему восстановим, источник на месте.
    expect(malki?.metadata.withdrawn_truth).toBe(before.get('malkinskie-springs')?.metadata.withdrawn_truth);
    expect(malki?.metadata.source_url).toBe(before.get('malkinskie-springs')?.metadata.source_url);
    for (const [slug, r] of after) {
      if (slug === 'malkinskie-springs') continue;
      expect(r.compiled_truth, slug).toBe(before.get(slug)?.compiled_truth);
      expect(r.metadata, slug).toEqual(before.get(slug)?.metadata);
    }
    expect(await scoped()).toEqual(['malkinskie-springs', 'paratunka-thermal']);

    // Повтор ничего не меняет.
    await pool.query(migrationFile('1464_kuzmich_malki_no_straight_line.sql'));
    expect((await read()).get('malkinskie-springs')?.compiled_truth).toBe(malki?.compiled_truth);
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
    expect(malki.text).not.toContain('120 км');
  });
});
