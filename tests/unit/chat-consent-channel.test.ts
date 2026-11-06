/**
 * Заявка из чата Кузьмича в MAX и Telegram записывает согласие человека
 * каналом чата, а не 'mcp' (ревью правки ПД 06.11), и id чата в поле адреса
 * согласия не кладёт: адрес у мессенджера неизвестен, связь с разговором
 * держит журнал записи. Ключ лимита записи (ip) остаётся прежним.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runPublicToolMock = vi.fn(async (_c: Record<string, unknown>) => ({ kind: 'ok', text: 'Заявка передана оператору', handoffUrl: null }));
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool: (c: Record<string, unknown>) => runPublicToolMock(c) }));
vi.mock('@/lib/kuzmich/write-journal', () => ({
  journaledWrite: (_m: unknown, fn: () => Promise<unknown>) => fn(),
  WriteInFlightError: class WriteInFlightError extends Error {},
}));

import { submitChatRequest } from '@/lib/kuzmich/chat-request-submit';

const PLAN = { tool: 'create_lead', args: { name: 'Иван', phone: '+79001234567', comment: 'Хотим на вулкан в августе', consent: true } } as const;

beforeEach(() => runPublicToolMock.mockClear());

describe('канал согласия из чата Кузьмича', () => {
  it.each([
    ['max:900100200', 'kuzmich-max'],
    ['tg:700100200', 'kuzmich-tg'],
  ])('%s → %s, адрес согласия не id чата', async (ip, source) => {
    await submitChatRequest(PLAN as never, { ip, userAgent: 'kuzmich-test' });
    const call = runPublicToolMock.mock.calls[0]![0];
    expect(call).toMatchObject({ ip, consentFrom: { source, ip: null } });
  });

  it('веб-чат: канал kuzmich-web и настоящий адрес', async () => {
    await submitChatRequest(PLAN as never, { ip: '10.9.0.7', userAgent: 'kuzmich-test' });
    expect(runPublicToolMock.mock.calls[0]![0]).toMatchObject({ consentFrom: { source: 'kuzmich-web', ip: '10.9.0.7' } });
  });
});
