/**
 * tests/unit/agent-tool-scope.test.ts
 *
 * Whitelist прав инструментов по агентствам (issue #327):
 * - инструмент вне scope агентства → SCOPE_DENIED, побочный эффект не выполнен;
 * - инструмент внутри scope → выполняется штатно;
 * - при отказе появляется запись в логе с агентством и инструментом;
 * - неизвестное агентство → запрет (least privilege).
 *
 * С 27.11 (разбор #1428, слово владельца «удалить если её никто не вызывает»)
 * инструментов, исполняющих SQL вызывающего, нет: runDiagnosticQuery и
 * applySchemaFix удалены. Запрет держится вызовом модуля: таких экспортов нет,
 * и ни одно агентство не получает их по имени.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
}));

import * as board from '@/lib/agents/tools/board-executor-tools';
import { isToolInScope, executeBoardTool, AGENCY_TOOL_SCOPE, BOARD_TOOLS } from '@/lib/agents/tools/board-executor-tools';
import { pool } from '@/lib/db-pool';

describe('agent tool scope (#327)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('rescue-agency: перепись и алерт можно, запись схемы и чужой SQL — нет', () => {
    expect(isToolInScope('rescue-agency', 'scanSQLErrors')).toBe(true);
    expect(isToolInScope('rescue-agency', 'sendBoardAlert')).toBe(true);
    expect(isToolInScope('rescue-agency', 'applySchemaFix')).toBe(false);
    expect(isToolInScope('rescue-agency', 'runDiagnosticQuery')).toBe(false);
    expect(isToolInScope('rescue-agency', 'fixSQLColumnErrors')).toBe(false);
  });

  it('неизвестное агентство — запрет по умолчанию', () => {
    expect(isToolInScope('random-agency', 'scanSQLErrors')).toBe(false);
  });

  it('вызов вне scope → SCOPE_DENIED и без побочного эффекта', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await executeBoardTool('random-agency', 'sendBoardAlert', ['agent', 'action', 'details']);
    expect(res.success).toBe(false);
    expect(res.details?.code).toBe('SCOPE_DENIED');
    expect(fetchSpy).not.toHaveBeenCalled();
    // отказ залогирован
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const logged = calls.some(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('ai_actions_log') && JSON.stringify(c[1]).includes('scope_denied'),
    );
    expect(logged).toBe(true);
    fetchSpy.mockRestore();
  });

  it('вызов внутри scope выполняется штатно', async () => {
    // Агентство берётся ЖИВОЕ (находка аудита 08.09).
    const res = await executeBoardTool('rescue-agency', 'scanSQLErrors');
    expect(res.success).toBe(true);
  });
});

describe('исполнения SQL вызывающего нет (27.11, #1428)', () => {
  it('модуль не отдаёт runDiagnosticQuery, applySchemaFix и обёртку лимита', () => {
    for (const name of ['runDiagnosticQuery', 'applySchemaFix', 'withDiagnosticLimit', 'DIAGNOSTIC_ROW_LIMIT']) {
      expect(name in board, name).toBe(false);
    }
  });

  it('ни в списке инструментов, ни в правах агентств их нет', () => {
    expect([...BOARD_TOOLS]).toEqual(['sendBoardAlert', 'scanSQLErrors']);
    for (const [agency, tools] of Object.entries(AGENCY_TOOL_SCOPE)) {
      expect(tools as string[], agency).not.toContain('runDiagnosticQuery');
      expect(tools as string[], agency).not.toContain('applySchemaFix');
    }
  });

  it('пул базы инструментами не трогается напрямую: нет pool.connect', async () => {
    await executeBoardTool('rescue-agency', 'scanSQLErrors');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
