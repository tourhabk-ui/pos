/**
 * tests/unit/chat-request-links.test.ts
 *
 * Заявка, созданная Кузьмичом в чате MAX или Telegram, связывается с этим
 * чатом ключами, выданными вызовом (#2970, миграция 1416) — на этой связи
 * стоит «Моя поездка». Веб-чат связи не даёт, отказ и «не записана» — тоже.
 * Сама таблица и её запросы — на настоящем PostgreSQL
 * (tests/integration/request-chat.pg.test.ts, блок 1416).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Out = { kind: string; text?: string; handoffUrl?: null; structured?: Record<string, unknown> };
const runPublicToolMock = vi.fn(async (_c: Record<string, unknown>): Promise<Out> => ({ kind: 'ok', text: '' }));
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool: (c: Record<string, unknown>) => runPublicToolMock(c) }));
vi.mock('@/lib/kuzmich/write-journal', () => ({
  journaledWrite: (_m: unknown, fn: () => Promise<unknown>) => fn(),
  WriteInFlightError: class WriteInFlightError extends Error {},
}));
const linkMock = vi.fn(async () => 1);
vi.mock('@/lib/requests/chat-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/requests/chat-links')>()),
  linkChatToKeys: (...a: unknown[]) => linkMock(...(a as [])),
}));

import { submitChatRequest } from '@/lib/kuzmich/chat-request-submit';
import { issuedKeysOf, linkChannelOf } from '@/lib/requests/chat-links';

const PLAN = { tool: 'create_trip_request', args: { name: 'Иван', phone: '+79001234567', consent: true } } as const;

/** Ответ инструмента, который chatRequestCreated признаёт записанной заявкой, с двумя ключами частей. */
function accepted(): Out {
  return {
    kind: 'ok',
    text: 'Заявка передана оператору. Ключ статуса заявки: K1.',
    handoffUrl: null,
    structured: { test: false, accepted: 2, requests: [
      { tool: 'create_booking_request', outcome: 'accepted', status_key: 'KEY_ONE', status_page: null, notify: null },
      { tool: 'create_stay_request', outcome: 'accepted', status_key: 'KEY_TWO', status_page: null, notify: null },
      { tool: 'create_lead', outcome: 'accepted', status_key: null, status_page: null, notify: null },
    ] },
  };
}

beforeEach(() => { runPublicToolMock.mockReset(); linkMock.mockClear(); });

describe('заявка из чата → связь с чатом', () => {
  it.each([
    ['max:900100200', 'max', '900100200'],
    ['tg:700100200', 'telegram', '700100200'],
  ])('%s: ключи итога связаны с чатом %s', async (ip, channel, chatId) => {
    runPublicToolMock.mockResolvedValue(accepted());
    const r = await submitChatRequest(PLAN as never, { ip, userAgent: 'kuzmich-test' });
    expect(r.ok).toBe(true);
    expect(linkMock).toHaveBeenCalledTimes(1);
    expect(linkMock).toHaveBeenCalledWith(channel, chatId, ['KEY_ONE', 'KEY_TWO'], 'created');
  });

  it('веб-чат связи не даёт', async () => {
    runPublicToolMock.mockResolvedValue(accepted());
    await submitChatRequest(PLAN as never, { ip: '10.9.0.7', userAgent: 'kuzmich-test' });
    expect(linkMock).not.toHaveBeenCalled();
  });

  it('отказ инструмента — заявки нет, связи нет', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'refused', text: 'Мест на эту дату нет — заявка не создана.' });
    const r = await submitChatRequest(PLAN as never, { ip: 'max:900100200', userAgent: 'kuzmich-test' });
    expect(r.ok).toBe(false);
    expect(linkMock).not.toHaveBeenCalled();
  });
});

describe('разбор итога и канала', () => {
  it('ключи берутся только строками из requests[].status_key', () => {
    expect(issuedKeysOf(accepted().structured)).toEqual(['KEY_ONE', 'KEY_TWO']);
    expect(issuedKeysOf(null)).toEqual([]);
    expect(issuedKeysOf({ requests: 'нет' })).toEqual([]);
    expect(issuedKeysOf({ requests: [{ status_key: 42 }, null] })).toEqual([]);
  });

  it('канал записи → канал связи; веб — нет', () => {
    expect(linkChannelOf('max')).toBe('max');
    expect(linkChannelOf('tg')).toBe('telegram');
    expect(linkChannelOf('telegram')).toBe('telegram');
    expect(linkChannelOf('web')).toBeNull();
  });
});
