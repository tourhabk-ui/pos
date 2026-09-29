/**
 * MCP create_booking_request для тура БЕЗ расписания (29.09).
 *
 * Раньше такой тур получал «нет свободных мест» — ложь: оператор просто не
 * ведёт календарь. Теперь запрос мест уходит оператору в мессенджер
 * (lib/seat-requests), а агенту возвращается ссылка на страницу статуса.
 * Границы, которые держит сторож:
 *   - расписание есть, а мест нет — прежний честный отказ, запрос оператору
 *     НЕ уходит (иначе оператора дёргали бы по заведомо занятой дате);
 *   - «не смог проверить расписание» — ошибка, а не «нет мест» и не запрос;
 *   - бронь из MCP по-прежнему не создаётся агентом: ни INSERT, ни оплат —
 *     её заводит оператор своим нажатием;
 *   - согласие на ПД проверяется ДО отправки, как у обеих заявок.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createLeadMock = vi.hoisted(() => vi.fn(async () => 'lead-1'));
const createSeatMock = vi.hoisted(() => vi.fn());
const keepsScheduleMock = vi.hoisted(() => vi.fn());
const slotsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/leads/create', () => ({
  createLead: (...a: unknown[]) => createLeadMock(...(a as [])),
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/tool-schemas', () => ({
  TOOL_REGISTRY: {},
  validateToolArgs: () => ({ ok: true, args: {} }),
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/kuzmich/tour-availability-tool', () => ({
  resolveTourByQuery: async () => ({ id: '7', title: 'Тур без календаря' }),
}));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => slotsMock(...a),
}));
vi.mock('@/lib/seat-requests/service', () => ({
  createSeatRequest: (...a: unknown[]) => createSeatMock(...a),
  tourKeepsSchedule: (...a: unknown[]) => keepsScheduleMock(...a),
  statusUrl: (t: string) => `https://vedarai.ru/seat-request#${t}`,
}));
vi.mock('@/lib/db-pool', () => {
  const q = async (sql: string) =>
    /COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] };
  return { pool: { query: q, connect: async () => ({ query: q, release: () => {} }) } };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POST } from '@/app/api/mcp/route';

function call(args: Record<string, unknown>) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_booking_request', arguments: args } }),
  }) as unknown as Parameters<typeof POST>[0];
}

const args = { tour: 'Тур без календаря', date: '2099-07-10', participants: 2, name: 'Иван', phone: '+7 900 123-45-67', consent: true };
const text = async (r: Response) => {
  const j = await r.json();
  return { isError: Boolean(j.result?.isError), text: String(j.result?.content?.[0]?.text ?? j.error?.message ?? '') };
};

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  for (const m of [createLeadMock, createSeatMock, keepsScheduleMock, slotsMock]) m.mockReset();
  createLeadMock.mockResolvedValue('lead-1');
  slotsMock.mockResolvedValue([]);
});

describe('тур без расписания', () => {
  it('вместо «нет мест» — запрос оператору и ссылка на статус; лид менеджеру не создаётся', async () => {
    keepsScheduleMock.mockResolvedValue(false);
    createSeatMock.mockResolvedValue({ ok: true, requestId: 'r1', statusToken: 'TOK', deadlineAt: new Date('2099-01-01T05:00:00Z'), operatorDelivery: 'max' });
    const r = await text(await POST(call({ ...args, comment: 'нужен трансфер' })));
    expect(r.isError).toBe(false);
    expect(createSeatMock).toHaveBeenCalledTimes(1);
    expect(createSeatMock.mock.calls[0]![0]).toMatchObject({
      tourId: 7, date: '2099-07-10', participants: 2, touristName: 'Иван', touristPhone: '+79001234567',
      replyChannel: 'phone', source: 'mcp',
      pdConsent: { source: 'mcp' },
    });
    expect(createLeadMock).not.toHaveBeenCalled();
    // Агенту сказано: не бронь, ссылка человеку, «не ответил» не значит «мест нет».
    expect(r.text).toContain('https://vedarai.ru/seat-request#TOK');
    expect(r.text).toMatch(/НЕ бронь/);
    expect(r.text).toMatch(/не значит, что мест нет/);
    expect(r.text).not.toMatch(/нет свободных мест/);
    // Комментарий оператору не уходит — и агенту об этом сказано прямо.
    expect(r.text).toMatch(/Комментарий оператору не передан/);
  });

  it('отказ сервиса (дубль, некому писать, потолок) — понятный текст и путь через create_lead, а не тишина', async () => {
    keepsScheduleMock.mockResolvedValue(false);
    for (const reason of ['duplicate', 'operator_unreachable', 'too_many', 'delivery_failed']) {
      createSeatMock.mockResolvedValueOnce({ ok: false, reason });
      const r = await text(await POST(call(args)));
      expect(r.isError, reason).toBe(false);
      expect(r.text, reason).toMatch(/не отправлен/);
      expect(r.text, reason).toMatch(/create_lead/);
    }
  });

  // Проверка MCP 29.09: «у вас уже есть подтверждённая бронь» говорил
  // анониму, знающему номер, где его владелец будет в этот день.
  it('«уже есть бронь» звучит так же, как «запрос уже отправлен»', async () => {
    keepsScheduleMock.mockResolvedValue(false);
    createSeatMock.mockResolvedValueOnce({ ok: false, reason: 'duplicate' });
    const dup = await text(await POST(call(args)));
    createSeatMock.mockResolvedValueOnce({ ok: false, reason: 'already_confirmed' });
    const confirmed = await text(await POST(call(args)));
    expect(confirmed.text).toBe(dup.text);
    expect(confirmed.text).not.toMatch(/подтверждённая бронь/);
  });

  it('без согласия на ПД запрос не отправляется', async () => {
    keepsScheduleMock.mockResolvedValue(false);
    const r = await text(await POST(call({ ...args, consent: false })));
    expect(r.isError).toBe(true);
    expect(createSeatMock).not.toHaveBeenCalled();
  });
});

describe('расписание есть или не проверено', () => {
  it('расписание есть, мест на дату нет — прежний честный отказ; оператору не пишем', async () => {
    keepsScheduleMock.mockResolvedValue(true);
    const r = await text(await POST(call(args)));
    expect(r.text).toMatch(/нет свободных мест/);
    expect(r.text).toMatch(/заявка не создана/);
    expect(createSeatMock).not.toHaveBeenCalled();
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('расписание не удалось проверить — ошибка «не смог», а не «нет мест» и не запрос', async () => {
    keepsScheduleMock.mockResolvedValue(null);
    const r = await text(await POST(call(args)));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Не удалось проверить расписание/);
    expect(createSeatMock).not.toHaveBeenCalled();
  });

  it('места есть — обычная заявка менеджеру, расписание не спрашивается', async () => {
    slotsMock.mockResolvedValue([{ date: '2099-07-10', remaining: 5 }]);
    const r = await text(await POST(call(args)));
    expect(r.text).toMatch(/Заявка на бронь принята/);
    expect(keepsScheduleMock).not.toHaveBeenCalled();
    expect(createSeatMock).not.toHaveBeenCalled();
    expect(createLeadMock).toHaveBeenCalledTimes(1);
  });
});

describe('границы MCP не сдвинуты', () => {
  it('роут по-прежнему не заводит брони и не трогает платежи', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');
    expect(route).not.toMatch(/INSERT INTO operator_bookings/i);
    expect(route).not.toMatch(/reserveBooking|confirmBooking/);
    expect(route).not.toMatch(/from '@\/lib\/payments/);
  });
});
