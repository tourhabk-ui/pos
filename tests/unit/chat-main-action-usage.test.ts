import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
import { countMainPress, mainActionOf } from '@/lib/chat-cabinet/main-action-usage';

const P = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

describe('счёт главных действий (разбор 02.11)', () => {
  it('ответы на бронь, заявку, машину, жильё, даты — главные действия; навигация — нет', () => {
    expect(mainActionOf(`bk:c:${ID}`)).toBe('booking_answer');
    expect(mainActionOf(`ld:x:${ID}`)).toBe('booking_answer');
    expect(mainActionOf('ia:ya:l:1')).toBe('request_answer');
    expect(mainActionOf('ia:rs:l:1')).toBe('request_answer');
    expect(mainActionOf('ia:a:l:1')).toBeNull(); // вопрос «Записать?» не запись
    expect(mainActionOf('ia:no')).toBeNull();
    expect(mainActionOf(`rr:y:${ID}`)).toBe('car_answer');
    expect(mainActionOf(`rc:y:${ID}`)).toBe('ride_outcome');
    expect(mainActionOf(`sa:f:${ID}`)).toBe('lodging_answer');
    expect(mainActionOf('od:o:1')).toBe('dates_answer');
    expect(mainActionOf('cb:i')).toBeNull();
    expect(mainActionOf('rm:op:hp')).toBeNull();
  });

  it('пишет строку chat_cabinet_usage карточки нажавшего, без текста и чата', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await countMainPress({ channel: 'max', chatId: 987654321, payload: `sa:f:${ID}` }, {
      nowMs: Date.parse('2026-11-02T00:00:00Z'), db: { query } as never,
      findPartner: async () => ({ outcome: 'found', partner: { partnerId: P } }),
    });
    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params.slice(1)).toEqual([P, 'owner', 'max', 'lodging_answer', 'ok']);
    expect(JSON.stringify(params)).not.toContain('987654321');
  });

  it('не партнёр или не главное действие — не пишет; отказ базы не роняет', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '57014' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await countMainPress({ channel: 'telegram', chatId: 1, payload: 'cb:i' }, { db: { query } as never, findPartner: async () => ({ outcome: 'found', partner: { partnerId: P } }) });
    await countMainPress({ channel: 'telegram', chatId: 1, payload: `rr:y:${ID}` }, { db: { query } as never, findPartner: async () => ({ outcome: 'none' }) });
    expect(query).not.toHaveBeenCalled();
    await expect(countMainPress({ channel: 'telegram', chatId: 1, payload: `rr:y:${ID}` }, { db: { query } as never, findPartner: async () => ({ outcome: 'found', partner: { partnerId: P } }) })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
