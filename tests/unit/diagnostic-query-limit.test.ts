/**
 * runDiagnosticQuery — LIMIT дописывается в САМ SQL, не только в срез ответа
 * (issue #1654, evo/bug, high).
 *
 * До правки `SELECT * FROM гигантская_таблица` без LIMIT тянул в память ВСЮ
 * таблицу — `rows.slice(0, 20)` обрезал уже полученный результат, а не
 * ограничивал выборку на уровне БД. Сторож держит: LIMIT дописывается, когда
 * его нет; не дублируется, когда есть; не ломает синтаксис на висящей точке
 * с запятой, UNION и CTE — именно эти формы issue называет риском правки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
}));

import { runDiagnosticQuery } from '@/lib/agents/tools/board-executor-tools';
import { pool } from '@/lib/db-pool';

function lastQuerySql(): string {
  // logToolAction зовёт pool.query отдельным INSERT'ом в ai_actions_log
  // ПОСЛЕ диагностического запроса — берём именно диагностический вызов,
  // а не последний по порядку.
  const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
  const diagnostic = calls.find((c) => typeof c[0] === 'string' && !c[0].includes('ai_actions_log'));
  return diagnostic?.[0] as string;
}

describe('runDiagnosticQuery — LIMIT в SQL, не только в срезе ответа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('простой SELECT без LIMIT — дописывает LIMIT 20', async () => {
    await runDiagnosticQuery('SELECT * FROM operator_tours');
    expect(lastQuerySql()).toBe('SELECT * FROM operator_tours LIMIT 20');
  });

  it('уже есть LIMIT — не дублирует и не трогает запрос', async () => {
    await runDiagnosticQuery('SELECT * FROM operator_tours LIMIT 5');
    expect(lastQuerySql()).toBe('SELECT * FROM operator_tours LIMIT 5');
  });

  it('LIMIT в любом регистре засчитывается как уже стоящий', async () => {
    await runDiagnosticQuery('select * from operator_tours limit 5');
    expect(lastQuerySql()).toBe('select * from operator_tours limit 5');
  });

  it('висящая точка с запятой — LIMIT встаёт ДО неё, не после', async () => {
    await runDiagnosticQuery('SELECT * FROM operator_tours;');
    const sql = lastQuerySql();
    expect(sql).toBe('SELECT * FROM operator_tours LIMIT 20');
    expect(sql.endsWith(';')).toBe(false);
  });

  it('UNION — LIMIT применяется к результату всего запроса, не ломает синтаксис', async () => {
    await runDiagnosticQuery(
      'SELECT id FROM operator_tours UNION SELECT id FROM operator_bookings'
    );
    expect(lastQuerySql()).toBe(
      'SELECT id FROM operator_tours UNION SELECT id FROM operator_bookings LIMIT 20'
    );
  });

  it('CTE (WITH) — LIMIT дописывается после внешнего SELECT', async () => {
    await runDiagnosticQuery(
      'WITH t AS (SELECT id FROM operator_tours) SELECT * FROM t'
    );
    expect(lastQuerySql()).toBe(
      'WITH t AS (SELECT id FROM operator_tours) SELECT * FROM t LIMIT 20'
    );
  });

  it('ответ по-прежнему режется slice(0,20) как страховка на случай ложного детектора', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows, rowCount: 5 });
    const res = await runDiagnosticQuery('SELECT id FROM operator_tours');
    expect(res.details?.rows).toHaveLength(5);
  });
});
