/**
 * AI-помощник оператора получает users.id UUID-строкой.
 *
 * /api/agents/operator делал parseInt(authResult.userId): UUID «5f3c…»
 * превращался в 5, «a1b2…» — в NaN. OperatorAgency искала partners по
 * чужому или несуществующему id, и помощник отвечал «Профиль оператора не
 * найден» своему же оператору. Типы userId в DispatchParams / UserContext /
 * агентствах были number и узаконивали это.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import { OperatorAgency } from '@/lib/agents/agencies/operator-agency';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const UID = '5f3c1a2b-0000-4000-8000-000000000000';

beforeEach(() => queryMock.mockReset());

describe('userId — строка UUID по всей цепочке', () => {
  it('роут не делает parseInt(userId)', () => {
    const src = read('app/api/agents/operator/route.ts');
    expect(src).not.toMatch(/parseInt\(authResult\.userId/);
    expect(src).toMatch(/userId: authResult\.userId,/);
  });

  it('чат не делает parseInt(user.userId) для PlatformAgent', () => {
    expect(read('app/api/ai/chat/route.ts')).not.toMatch(/parseInt\(user\.userId/);
  });

  it('типы userId — string', () => {
    expect(read('lib/agents/platform-agent.ts')).toMatch(/userId\?: string;/);
    expect(read('lib/agents/context-hub.ts')).toMatch(/userId\?: string;/);
    expect(read('lib/agents/agencies/operator-agency.ts')).toMatch(/getPartnerId\(userId: string \| undefined\)/);
  });

  it('OperatorAgency ищет partners по той же UUID-строке', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const agency = new OperatorAgency();
    const ctx = {
      user: { userId: UID, role: 'operator' },
      task: {},
      platform: { routesCount: 0, activeOperators: 0, toursCount: 0 },
      execution: { agentName: 't', startedAt: new Date() },
    };
    await agency.getToursSummary(ctx);
    expect(queryMock.mock.calls[0][1]).toEqual([UID]);
    expect(String(queryMock.mock.calls[0][0])).toMatch(/category = 'operator'/);
  });
});
