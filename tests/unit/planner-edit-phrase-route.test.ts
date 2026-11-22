/**
 * POST /api/planner/edit-phrase (фича 5): правка идёт через applyPlanEdit
 * (путь MCP edit_trip_plan), всё или ничего, неразобранная фраза план не трогает.
 * applyPlanEdit подменён: здесь проверяется маршрут, не движок правки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { apply, query } = vi.hoisted(() => ({ apply: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('@/lib/planner/plan-edit', () => ({
  applyPlanEdit: apply,
  planEstimate: (p: { days: unknown[] }) => ({ total: [p.days.length * 1000, p.days.length * 1000] }),
}));

const { POST } = await import('@/app/api/planner/edit-phrase/route');

const params = { interests: ['fishing'], arrivalDate: '2027-07-01', departureDate: '2027-07-04', adults: 2, children: [], budgetTier: 'comfort' };
const days = [
  { day: 1, type: 'arrival', title: 'Прилёт' },
  { day: 2, type: 'activity', activityType: 'fishing', title: 'Рыбалка', realTour: { tourId: 't1' } },
  { day: 3, type: 'rest', title: 'Свободный день' },
  { day: 4, type: 'departure', title: 'Отъезд' },
];
const call = (phrase: string) => POST(new NextRequest('http://x/api/planner/edit-phrase', {
  method: 'POST', body: JSON.stringify({ phrase, params, days }), headers: { 'content-type': 'application/json' },
}));

beforeEach(() => {
  apply.mockReset();
  query.mockReset();
  // по умолчанию все туры плана — на витрине
  query.mockImplementation(async (_sql: string, [ids]: [string[]]) => ({ rows: ids.map((id) => ({ id })) }));
});

describe('edit-phrase', () => {
  it('«без рыбалки» → remove_day дня 2 через applyPlanEdit, смета до/после', async () => {
    apply.mockImplementation(async (plan: { params: unknown; days: { day: number }[] }, edit: { kind: string; day: number }) => {
      return { ok: true, plan: { ...plan, days: plan.days.filter((d) => d.day !== edit.day) }, note: `убран день ${edit.day}`, warnings: [] };
    });
    const body = await (await call('без рыбалки')).json();
    expect(body.success).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toMatchObject({ kind: 'remove_day', day: 2 });
    expect(body.total).toEqual({ before: [4000, 4000], after: [3000, 3000] });
  });

  it('неразобранная фраза — отказ с примерами, applyPlanEdit не зовётся', async () => {
    const body = await (await call('сделай красиво')).json();
    expect(body.success).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('отказ движка на второй правке — весь ответ отказ, плана нет', async () => {
    apply.mockResolvedValueOnce({ ok: true, plan: { params, days: days.slice(0, 3) }, note: 'ok', warnings: [] })
      .mockResolvedValueOnce({ ok: false, reason: 'нельзя.' });
    const body = await (await call('без рыбалки, замени день 3')).json();
    expect(body.success).toBe(false);
    expect(body.plan).toBeUndefined();
  });

  it('тур не с витрины (черновик, снят, удалён) — отказ 400, applyPlanEdit не зовётся', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await call('нас трое');
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(query.mock.calls[0][0]).toContain('is_published = true');
    expect(apply).not.toHaveBeenCalled();
  });

  it('витрина не проверилась — 503, план не трогается', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const res = await call('без рыбалки');
    expect(res.status).toBe(503);
    expect(apply).not.toHaveBeenCalled();
  });
});
