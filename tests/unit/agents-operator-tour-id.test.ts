/**
 * Экран AI-помощника (/hub/operator/ai-assist) шлёт номер тура полем
 * «Tour ID», а роут POST /api/agents/operator дописывает его в конец текста:
 * `${message} тур ${tourId}`. Команда «открой даты» искала номер только как
 * «туру 42», «тур 42» не видела — и на «открой даты 2027-07-05, 8 мест» с
 * заполненным полем отвечала «Укажи ID тура», хотя оператор его указал.
 *
 * Судится вызовом роута целиком: классификатор, диспетчер, агентство. Ядро и
 * запись — подставные; что запись делает на настоящей базе —
 * tests/integration/tour-dates-open.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const openTourDates = vi.fn();
vi.mock('@/lib/tours/availability-open', async (orig) => ({
  ...(await orig<typeof import('@/lib/tours/availability-open')>()),
  openTourDates: (...a: unknown[]) => openTourDates(...a),
}));
vi.mock('@/lib/agents/kernel', () => ({
  executeGovernedAction: async (input: { execute: () => Promise<unknown> }) =>
    ({ ok: true, taskId: 't', traceId: 'tr', result: await input.execute() }),
  hashInput: () => 'hash',
}));
vi.mock('@/lib/operators/team-access', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/team-access')>()),
  operatorAccess: vi.fn(async () => ({ kind: 'owner', partnerId: 'p-1' })),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn(async () => ({ userId: '5f3c1a2b-0000-4000-8000-000000000000', role: 'operator' })),
}));
// Контекст, память и журнал диспетчера ходят в базу — здесь она пустая.
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
// Модель классификатора не нужна: команда распознаётся по ключу.
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => null) }));

const { POST } = await import('@/app/api/agents/operator/route');

const call = (body: unknown) => POST(new NextRequest('http://localhost/api/agents/operator', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}));

beforeEach(() => {
  openTourDates.mockReset();
  openTourDates.mockResolvedValue({
    ok: true, tour: { title: 'Горелый', maxParticipants: 10, isPublished: true, isActive: true }, written: 1,
    perDate: [{ date: '2027-07-05', result: 'opened' }],
  });
});

describe('POST /api/agents/operator: номер тура из поля Tour ID', () => {
  it('«открой даты 2027-07-05, 8 мест» и tourId 42 — запись на тур 42', async () => {
    const res = await call({ message: 'открой даты 2027-07-05, 8 мест', tourId: 42 });
    const body = await res.json();
    expect(body.intent).toBe('op_add_slots');
    expect(openTourDates).toHaveBeenCalledTimes(1);
    expect(openTourDates.mock.calls[0]![0]).toMatchObject({ tourId: '42', rows: [{ date: '2027-07-05', slots: 8 }] });
    expect(body.response).toMatch(/Открыто \(1\): 5 июля 2027/);
  });

  it('в тексте другой тур, чем в поле, — вопрос, а не запись на первый попавшийся', async () => {
    const res = await call({ message: 'открой даты туру 43 2027-07-05, 8 мест', tourId: 42 });
    expect((await res.json()).response).toMatch(/несколько туров \(43, 42\)/);
    expect(openTourDates).not.toHaveBeenCalled();
  });
});
