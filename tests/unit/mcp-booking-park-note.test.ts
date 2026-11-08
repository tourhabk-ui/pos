/**
 * create_booking_request говорит о закрытом парке тура на дату заявки
 * (разбор 08.11, внешний агент Qwen).
 *
 * Сводка «Вулканы Камчатки» закрыла маршруты природных парков на межсезонье;
 * план поездки об этом говорил (lib/planner/park-status), а заявка на тур в
 * Налычево на ноябрьскую дату принималась молча. Сторож исполняет роут MCP
 * целиком: тревога парка на дату — строка в ответе обоих путей (заявка
 * оператору и запрос мест), тревог нет — строки нет, чтение упало — так и
 * сказано, и заявка всё равно создаётся (её подтверждает оператор). Строка —
 * факт и где его проверить, без обещаний за оператора.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createLeadMock = vi.hoisted(() => vi.fn(async () => 'lead-1'));
const createSeatMock = vi.hoisted(() => vi.fn());
const keepsScheduleMock = vi.hoisted(() => vi.fn());
const slotsMock = vi.hoisted(() => vi.fn());
const parkAlertsMock = vi.hoisted(() => vi.fn());
const TOUR = { id: '7', title: 'Тур в Налычево (тест)' };

vi.mock('@/lib/leads/create', () => ({
  createLead: (...a: unknown[]) => createLeadMock(...(a as [])),
  createLeadDetailed: async (...a: unknown[]) => { const id = await createLeadMock(...(a as [])); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/tool-schemas', () => ({
  TOOL_REGISTRY: {},
  validateToolArgs: () => ({ ok: true, args: {} }),
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/kuzmich/tour-availability-tool', () => ({
  resolveTourChoice: async () => ({ kind: 'one', tour: TOUR }),
  candidateLines: () => [],
  choiceListLines: () => [],
  choiceListReason: () => '',
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
// Правило дня — настоящее (parkNoteForDay); подменено только чтение тревог.
vi.mock('@/lib/planner/park-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner/park-status')>()),
  loadPlanParkAlerts: (...a: unknown[]) => parkAlertsMock(...a),
}));
vi.mock('@/lib/db-pool', () => {
  const q = async (sql: string) =>
    /COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] };
  return { pool: { query: q, connect: async () => ({ query: q, release: () => {} }) } };
});

import { POST } from '@/app/api/mcp/route';

/** Дата через n дней по Камчатке (UTC+12). */
const dayIso = (n: number) => new Date(Date.now() + 12 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
const DATE = dayIso(5);
const CLOSURE = {
  ref_kind: 'tour', ref_id: '7', alert_id: 'a1', alert_type: 'park_closure',
  title: 'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья',
  description: null,
  published_iso: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  expires_iso: new Date(Date.now() + 19 * 86_400_000).toISOString(),
};

function call(args: Record<string, unknown>) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.1.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_booking_request', arguments: args } }),
  }) as unknown as Parameters<typeof POST>[0];
}
const args = { tour: 'Тур в Налычево', date: DATE, participants: 2, name: 'Тест', phone: '+70000000000', consent: true };
const text = async (r: Response) => {
  const j = await r.json();
  return { isError: Boolean(j.result?.isError), text: String(j.result?.content?.[0]?.text ?? j.error?.message ?? '') };
};

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  for (const m of [createLeadMock, createSeatMock, keepsScheduleMock, slotsMock, parkAlertsMock]) m.mockReset();
  createLeadMock.mockResolvedValue('lead-1');
  parkAlertsMock.mockResolvedValue([]);
});

describe('create_booking_request: закрытие парка тура на дату заявки', () => {
  it('тур с местами: заявка принята, и закрытие парка названо со сводкой и датой', async () => {
    slotsMock.mockResolvedValue([{ date: DATE, remaining: 5 }]);
    parkAlertsMock.mockResolvedValue([CLOSURE]);
    const r = await text(await POST(call(args)));
    expect(r.isError).toBe(false);
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(r.text).toContain('Заявка оператору принята');
    expect(r.text).toMatch(new RegExp(`По парку этого тура на ${DATE}: закрытие парка по сводке от \\d{2}\\.\\d{2}: «Закрытие маршрутов`));
    expect(r.text).toContain('Перед выходом уточните у дирекции парка.');
    // Тревоги спрошены по этому туру, не по месту и не по телефону.
    expect(parkAlertsMock.mock.calls[0]![1]).toEqual({ routeIds: [], tourIds: ['7'] });
    // Обещаний за оператора нет: это никто не проверяет.
    expect(r.text).not.toMatch(/оператор (предупредит|сообщит о закрытии)/);
  });

  it('тур без расписания: запрос мест ушёл, закрытие парка в ответе до ссылки', async () => {
    slotsMock.mockResolvedValue([]);
    keepsScheduleMock.mockResolvedValue(false);
    createSeatMock.mockResolvedValue({ ok: true, requestId: 'r1', statusToken: 'TOK', deadlineAt: new Date(Date.now() + 7_200_000), operatorDelivery: 'max' });
    parkAlertsMock.mockResolvedValue([CLOSURE]);
    const r = await text(await POST(call(args)));
    expect(createSeatMock).toHaveBeenCalledTimes(1);
    expect(r.text).toContain(`По парку этого тура на ${DATE}: закрытие парка по сводке`);
    expect(r.text.indexOf('По парку этого тура')).toBeGreaterThan(r.text.indexOf('не значит, что мест нет'));
  });

  it('тревог по парку тура нет — строки о парке нет', async () => {
    slotsMock.mockResolvedValue([{ date: DATE, remaining: 5 }]);
    const r = await text(await POST(call(args)));
    expect(r.text).toContain('Заявка оператору принята');
    expect(r.text).not.toContain('По парку этого тура');
    expect(r.text).not.toContain('закрытия парка');
  });

  it('закрытие кончилось до даты заявки, а закрыто без даты открытия — «статус не известен», не «закрыт»', async () => {
    slotsMock.mockResolvedValue([{ date: dayIso(10), remaining: 5 }]);
    parkAlertsMock.mockResolvedValue([{ ...CLOSURE, expires_iso: new Date(Date.now() + 3 * 86_400_000).toISOString() }]);
    const r = await text(await POST(call({ ...args, date: dayIso(10) })));
    expect(r.text).toContain(`По парку этого тура на ${dayIso(10)}: статус парка на этот день не известен`);
    expect(r.text).not.toContain('закрытие парка по сводке');
  });

  it('чтение тревог упало — так и сказано, заявка всё равно создана', async () => {
    slotsMock.mockResolvedValue([{ date: DATE, remaining: 5 }]);
    parkAlertsMock.mockRejectedValue(Object.assign(new Error('сбой базы'), { code: '57014' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await text(await POST(call(args)));
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(r.text).toContain('Проверить, нет ли на эту дату закрытия парка по маршруту тура, не удалось');
    expect(err.mock.calls.some((c) => String(c[0]).includes('закрытие парка для заявки на тур не проверено'))).toBe(true);
    err.mockRestore();
  });
});
