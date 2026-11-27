/**
 * tests/unit/agent-tool-scope.test.ts
 *
 * Whitelist прав инструментов по агентствам (issue #327):
 * - инструмент вне scope агентства → SCOPE_DENIED, побочный эффект не выполнен;
 * - инструмент внутри scope → выполняется штатно;
 * - при отказе появляется запись в логе с агентством и инструментом;
 * - неизвестное агентство → запрет (least privilege).
 *
 * 27.11 (разбор находок #1428): инструментов, исполняющих переданный SQL —
 * applySchemaFix и runDiagnosticQuery, — больше нет ни в реестре, ни в
 * диспетчере; остались перепись и сообщение администратору.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
}));

import * as tools from '@/lib/agents/tools/board-executor-tools';
import { isToolInScope, executeBoardTool, BOARD_TOOLS, AGENCY_TOOL_SCOPE } from '@/lib/agents/tools/board-executor-tools';
import { pool } from '@/lib/db-pool';

describe('agent tool scope (#327)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('инструментов, исполняющих SQL, нет ни в реестре, ни в экспорте модуля', () => {
    expect([...BOARD_TOOLS].sort()).toEqual(['scanSQLErrors', 'sendBoardAlert']);
    expect(Object.keys(tools)).not.toContain('applySchemaFix');
    expect(Object.keys(tools)).not.toContain('runDiagnosticQuery');
    for (const [agency, scope] of Object.entries(AGENCY_TOOL_SCOPE)) {
      expect(scope as string[], agency).not.toContain('applySchemaFix');
      expect(scope as string[], agency).not.toContain('runDiagnosticQuery');
    }
  });

  it('rescue-agency: перепись и сообщение можно, удалённые инструменты — нет', () => {
    expect(isToolInScope('rescue-agency', 'scanSQLErrors')).toBe(true);
    expect(isToolInScope('rescue-agency', 'sendBoardAlert')).toBe(true);
    expect(isToolInScope('rescue-agency', 'runDiagnosticQuery')).toBe(false);
    expect(isToolInScope('rescue-agency', 'applySchemaFix')).toBe(false);
    expect(isToolInScope('rescue-agency', 'fixSQLColumnErrors')).toBe(false);
  });

  it('неизвестное агентство — запрет по умолчанию', () => {
    expect(isToolInScope('random-agency', 'scanSQLErrors')).toBe(false);
  });

  it('вызов вне scope → SCOPE_DENIED, без побочного эффекта, отказ залогирован', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await executeBoardTool('random-agency', 'sendBoardAlert', ['a', 'b', 'c']);
    expect(res.success).toBe(false);
    expect(res.details?.code).toBe('SCOPE_DENIED');
    // sendBoardAlert ходит в Telegram — вне scope до сети дело не доходит.
    expect(fetchSpy).not.toHaveBeenCalled();
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const logged = calls.some(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('ai_actions_log') && JSON.stringify(c[1]).includes('scope_denied'),
    );
    expect(logged).toBe(true);
  });

  it('вызов внутри scope выполняется штатно', async () => {
    const res = await executeBoardTool('rescue-agency', 'scanSQLErrors');
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/Просканировано/);
  });
});
