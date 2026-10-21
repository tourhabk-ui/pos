/**
 * Журнал запроса мест (1306): событие пишется в crm_events без клиента и
 * никогда не роняет запрос.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { recordJournalEventQuietly } from '@/lib/crm/events';

const base = {
  partnerId: '0aaa4f05-b479-418b-9d54-2b909783dfd7',
  sourceKind: 'seat_request' as const,
  sourceId: '11111111-1111-4111-8111-111111111111',
  kind: 'status_change' as const,
  actorKind: 'partner_user' as const,
  title: 'Запрос мест: ждёт ответа → мест нет',
  payload: { from: 'pending', to: 'declined', via: 'max' },
};

describe('recordJournalEventQuietly', () => {
  it('пишет событие с пустым contact_id и видом seat_request', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordJournalEventQuietly(base, { query } as never);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO crm_events/);
    expect(sql).toMatch(/NULL/);
    expect(params.slice(0, 3)).toEqual([base.partnerId, 'seat_request', base.sourceId]);
    expect(JSON.parse(params[6])).toEqual(base.payload);
  });

  it('отказ базы не бросает', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '23514' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordJournalEventQuietly(base, { query } as never)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('запрос мест пишет журнал на каждом исходе', () => {
  const src = readFileSync(join(process.cwd(), 'lib/seat-requests/service.ts'), 'utf8');
  it('создание, доставка, ответ, просрочка, подбор и отправка туристу', () => {
    expect(src).toMatch(/seatStatusEvent\(requestId, tour\.operator_id, null, 'pending'/);
    expect(src).toMatch(/'pending', 'failed', 'system', \{ failure_kind: 'delivery'/);
    expect(src).toMatch(/seatStatusEvent\(claimed\.id, claimed\.operator_id, 'pending', finalStatus, 'partner_user'/);
    expect(src).toMatch(/seatStatusEvent\(r\.id, null, 'pending', 'expired', 'system'\)/);
    expect(src).toMatch(/seatStatusEvent\(r\.id, r\.operator_id, 'pending', status, 'system'/);
    expect(src).toMatch(/Ответ отправлен туристу/);
  });
});
