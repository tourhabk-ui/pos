/**
 * tests/unit/agent-tool-scope.test.ts
 *
 * Whitelist прав инструментов по агентствам (issue #327):
 * - инструмент вне scope агентства → SCOPE_DENIED, побочный эффект не выполнен;
 * - инструмент внутри scope → выполняется штатно;
 * - при отказе появляется запись в логе с агентством и инструментом;
 * - неизвестное агентство → запрет (least privilege).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
}));

import { isToolInScope, executeBoardTool } from '@/lib/agents/tools/board-executor-tools';
import { pool } from '@/lib/db-pool';

describe('agent tool scope (#327)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('rescue-agency: диагностика можно, запись схемы нельзя', () => {
    expect(isToolInScope('rescue-agency', 'runDiagnosticQuery')).toBe(true);
    expect(isToolInScope('rescue-agency', 'applySchemaFix')).toBe(false);
    expect(isToolInScope('rescue-agency', 'fixSQLColumnErrors')).toBe(false);
  });

  it('неизвестное агентство — запрет по умолчанию', () => {
    expect(isToolInScope('random-agency', 'runDiagnosticQuery')).toBe(false);
  });

  it('вызов вне scope → SCOPE_DENIED и без побочного эффекта', async () => {
    const res = await executeBoardTool('rescue-agency', 'applySchemaFix', ['desc', 'CREATE INDEX i ON t(x)']);
    expect(res.success).toBe(false);
    expect(res.details?.code).toBe('SCOPE_DENIED');
    // applySchemaFix открывает клиента через pool.connect — он не должен вызваться
    expect(pool.connect).not.toHaveBeenCalled();
    // отказ залогирован
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const logged = calls.some(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('ai_actions_log') && JSON.stringify(c[1]).includes('scope_denied'),
    );
    expect(logged).toBe(true);
  });

  it('вызов внутри scope выполняется штатно', async () => {
    const res = await executeBoardTool('quality-agency', 'runDiagnosticQuery', ['SELECT 1', 'test']);
    expect(res.success).toBe(true);
  });
});
