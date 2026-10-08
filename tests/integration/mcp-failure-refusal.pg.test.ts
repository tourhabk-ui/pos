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
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';

const holder = vi.hoisted(() => ({ pool: null as null | { query: (sql: string, params?: unknown[]) => Promise<unknown> } }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => holder.pool!.query(sql, params) },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin', role: 'admin' }) }));

import { GET as panelGet } from '@/app/api/admin/analytics/mcp/route';
import { GET as censusGet } from '@/app/api/cron/mcp-census/route';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

const TEST_DB = 'mcp_failure_refusal_test';
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

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
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    const admin = new Pool({ connectionString: dbUrl, max: 1 });
    await admin.query(
      `DELETE FROM _migrations
        WHERE (substring(name from '^[0-9]+'))::bigint >= $1
           OR substring(name from '^[0-9]+') IS NULL`,
      [FIRST_AFTER_BASELINE],
    );
    await admin.end();
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

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
