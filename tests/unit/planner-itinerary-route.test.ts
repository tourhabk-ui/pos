/**
 * POST /api/planner/itinerary (фича 7): «Подробная программа» по кнопке —
 * один вызов модели на нажатие, вход обязателен, лишнее на вход не берётся.
 * Модель подменена: платных вызовов в тестах нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { ai } = vi.hoisted(() => ({ ai: vi.fn() }));
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('@/lib/planner/engine', () => ({ aiItineraryText: ai }));

const { POST } = await import('@/app/api/planner/itinerary/route');

const body = {
  profile: { adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', arrivalDate: '2027-07-01', departureDate: '2027-07-04' },
  zones: [{ zone: 'avachinsky', score: 80 }],
  days: [{ day: 1, type: 'arrival', title: 'Прилёт', zone: 'avachinsky' }],
  warnings: [{ type: 'mchs', severity: 'important', message: 'Сводка МЧС' }],
};
let ip = 0;
const call = (b: unknown) => POST(new NextRequest('http://x/api/planner/itinerary', {
  method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', 'x-real-ip': `10.1.0.${++ip}` },
}));

beforeEach(() => { ai.mockReset(); });

describe('itinerary', () => {
  it('текст модели — одним вызовом, со временем в Server-Timing', async () => {
    ai.mockResolvedValueOnce('Программа поездки.');
    const res = await call(body);
    expect(await res.json()).toEqual({ success: true, text: 'Программа поездки.' });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(res.headers.get('Server-Timing')).toMatch(/^ai_itinerary;dur=\d+$/);
  });
  it('модель не ответила — честный отказ, план не трогается', async () => {
    ai.mockResolvedValueOnce(null);
    const data = await (await call(body)).json();
    expect(data.success).toBe(false);
    expect(data.error).toContain('план от этого не меняется');
  });
  it('неверный вход — 400, модель не зовётся', async () => {
    const res = await call({ ...body, days: [{ day: 1, type: 'arrival', title: 'x'.repeat(500), zone: 'avachinsky' }] });
    expect(res.status).toBe(400);
    expect(ai).not.toHaveBeenCalled();
  });
  it('лишние поля дня (tourId и др.) в модель не идут', async () => {
    ai.mockResolvedValueOnce('ok');
    await call({ ...body, days: [{ ...body.days[0], realTour: { operatorName: 'Оператор', tourId: '123' }, secret: 'x' }] });
    const days = ai.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(days[0]).not.toHaveProperty('secret');
    expect(days[0].realTour).toEqual({ operatorName: 'Оператор' });
  });
});
