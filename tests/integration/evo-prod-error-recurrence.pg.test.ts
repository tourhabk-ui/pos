/**
 * Повтор прод-ошибки после закрытия находки снова доходит до трекера
 * (разбор очереди 26.11, слово владельца «да»).
 *
 * Дедуп находок эволюции считал принятую находку дублем навсегда. Issue
 * «Прод 500: /operators/[slug]», закрытая как сделанная, глушила ту же ошибку
 * и после починки: повтор не заводил новую находку. Теперь событие прода несёт
 * время последней строки журнала, и находка, принятая раньше него, повтор не
 * глушит. Находки по коду (без времени события) — как прежде.
 *
 * Сцена — на настоящем PostgreSQL: настоящий объектив `scanProdErrors` читает
 * журнал, настоящий `persistGrowthIssues` решает, дубль это или нет.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[evo-prod-error-recurrence.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'evo_prod_error_recurrence_test';
const ROUTE = '/operators/[slug]';
const TITLE = `Прод 500: ${ROUTE}`;

withPg('повтор прод-ошибки после закрытия находки', () => {
  let pool: import('pg').Pool;
  let scanId: string;
  let growth: typeof import('@/lib/agents/evo/growth-agent');

  const logError = (minutesAgo: number) =>
    pool.query(
      `INSERT INTO ai_actions_log (action_type, metadata, created_at)
       VALUES ('server_error', $1, NOW() - make_interval(mins => $2::int))`,
      [JSON.stringify({ route: ROUTE, method: 'GET', message: 'timeout exceeded when trying to connect' }), minutesAgo],
    );
  const rowsFor = async (title: string) =>
    (await pool.query<{ status: string }>(`SELECT status FROM evo_growth_issues WHERE title = $1 ORDER BY created_at`, [title])).rows;
  const scanAndPersist = async () => growth.persistGrowthIssues(scanId, await growth.scanProdErrors());

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    await pool.query('TRUNCATE ai_actions_log, evo_growth_issues CASCADE');
    scanId = (await pool.query<{ id: string }>(
      `INSERT INTO evo_growth_scans (scan_type, status) VALUES ('test', 'complete') RETURNING id::text AS id`,
    )).rows[0]!.id;
    growth = await import('@/lib/agents/evo/growth-agent');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('объектив называет время последней ошибки', async () => {
    await logError(120);
    await logError(90);
    const [issue] = (await growth.scanProdErrors()).filter((i) => i.title === TITLE);
    expect(issue).toBeDefined();
    const seen = Date.parse(issue!.last_seen_at ?? '');
    expect(Number.isFinite(seen)).toBe(true);
    // Последняя строка — 90 минут назад, не 120.
    expect(Math.abs(Date.now() - 90 * 60_000 - seen)).toBeLessThan(5 * 60_000);
  });

  it('первая ошибка заводит находку, повторный прогон — нет', async () => {
    expect(await scanAndPersist()).toBe(1);
    expect(await scanAndPersist()).toBe(0);
    expect(await rowsFor(TITLE)).toEqual([{ status: 'open' }]);
  });

  it('находку закрыли как сделанную после этих ошибок — те же ошибки повтором не считаются', async () => {
    await pool.query(
      `UPDATE evo_growth_issues SET status = 'accepted', resolved_at = NOW() - INTERVAL '30 minutes' WHERE title = $1`, [TITLE],
    );
    expect(await scanAndPersist()).toBe(0);
  });

  it('ошибка после закрытия — новая находка', async () => {
    await logError(5);
    expect(await scanAndPersist()).toBe(1);
    expect(await rowsFor(TITLE)).toEqual([{ status: 'accepted' }, { status: 'open' }]);
    // И она сама — дубль для следующего прогона.
    expect(await scanAndPersist()).toBe(0);
  });

  it('находка по коду без времени события: принятая по-прежнему дубль', async () => {
    const code = { category: 'bug' as const, severity: 'medium' as const, file_path: 'lib/x.ts', title: 'Пустой catch глушит отказ (тест)', description: 'd', suggestion: 's' };
    expect(await growth.persistGrowthIssues(scanId, [code])).toBe(1);
    await pool.query(`UPDATE evo_growth_issues SET status = 'accepted', resolved_at = NOW() - INTERVAL '1 day' WHERE title = $1`, [code.title]);
    expect(await growth.persistGrowthIssues(scanId, [code])).toBe(0);
  });

  it('принятая без времени закрытия — дубль и при свежей ошибке', async () => {
    const title = 'Прод 500: /articles';
    await pool.query(
      `INSERT INTO evo_growth_issues (category, severity, title, description, suggestion, status)
       VALUES ('bug', 'medium', $1, 'd', 's', 'accepted')`, [title],
    );
    expect(await growth.persistGrowthIssues(scanId, [
      { category: 'bug', severity: 'medium', title, description: 'd', suggestion: 's', last_seen_at: new Date().toISOString() },
    ])).toBe(0);
  });
});
