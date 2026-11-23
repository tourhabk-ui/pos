/**
 * POST /api/planner/itinerary (фича 7): «Подробная программа» по кнопке —
 * один вызов модели на нажатие, вход обязателен. Свободного текста от
 * браузера в промпте нет (ревью безопасности #3743): названия туров и
 * операторов — из БД (витрина), остальное — фразы из закрытых списков.
 * Модель и БД подменены: платных вызовов в тестах нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { ai, query } = vi.hoisted(() => ({ ai: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('@/lib/planner/engine', () => ({ aiItineraryText: ai }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

const { POST } = await import('@/app/api/planner/itinerary/route');

const TOUR = '11111111-2222-3333-4444-555555555555';
const body = {
  profile: { adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', arrivalDate: '2027-07-01', departureDate: '2027-07-04' },
  zones: [{ zone: 'avachinsky', score: 80 }],
  days: [
    { day: 1, type: 'arrival', zone: 'avachinsky' },
    { day: 2, type: 'activity', zone: 'avachinsky', activityType: 'volcano', tourId: TOUR, realPrice: 20000, temp: { min: 3, max: 9 } },
    { day: 3, type: 'activity', zone: 'avachinsky', activityType: 'hot_spring' },
  ],
  warnings: [{ type: 'mchs', severity: 'important' }],
};
let ip = 0;
const call = (b: unknown) => POST(new NextRequest('http://x/api/planner/itinerary', {
  method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', 'x-real-ip': `10.1.0.${++ip}` },
}));

beforeEach(() => {
  ai.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: TOUR, title: 'Восхождение на Авачинский', operator_name: 'Камчатка Тур', price_unit: 'person' }] });
});

describe('itinerary', () => {
  it('текст модели — одним вызовом, со временем в Server-Timing', async () => {
    ai.mockResolvedValueOnce('Программа поездки.');
    const res = await call(body);
    expect(await res.json()).toEqual({ success: true, text: 'Программа поездки.' });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(res.headers.get('Server-Timing')).toMatch(/^ai_itinerary;dur=\d+$/);
  });
  it('название тура и оператор — из БД, только витрина; дни без тура — фразы из списка', async () => {
    ai.mockResolvedValueOnce('ok');
    await call(body);
    expect(String(query.mock.calls[0][0])).toMatch(/operator_tours[\s\S]*AND /);
    expect(query.mock.calls[0][1]).toEqual([[TOUR]]);
    const days = ai.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(days[0].title).toBe('Прилёт и размещение');
    expect(days[1]).toMatchObject({ title: 'Восхождение на Авачинский', realTour: { operatorName: 'Камчатка Тур', priceUnit: 'person' }, realPrice: 20000,
      weatherForecast: { tempMin: 3, tempMax: 9 } });
    expect(days[2].title).toBe('Самостоятельный день: термальные');
    expect(ai.mock.calls[0][3]).toEqual([{ type: 'mchs', severity: 'important', message: 'по маршруту есть сводки МЧС' }]);
  });
  it('тура нет на витрине — день без тура и без цены', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    ai.mockResolvedValueOnce('ok');
    await call(body);
    const days = ai.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(days[1].title).toBe('Самостоятельный день: вулкан');
    expect(days[1]).not.toHaveProperty('realTour');
    expect(days[1]).not.toHaveProperty('realPrice');
  });
  it('свободный текст не принимается: заголовок, оператор, сообщение — 400 или игнор', async () => {
    const r1 = await call({ ...body, days: [{ ...body.days[0], title: 'у меня астма, +7 914 123-45-67' }] });
    expect(r1.status).toBe(400);
    const r2 = await call({ ...body, days: [{ ...body.days[0], type: 'астма' }] });
    expect(r2.status).toBe(400);
    const r3 = await call({ ...body, days: [{ ...body.days[1], activityType: 'ВИЧ' }] });
    expect(r3.status).toBe(400);
    expect(ai).not.toHaveBeenCalled();
    ai.mockResolvedValueOnce('ok');
    await call({ ...body, warnings: [
      { type: 'season', severity: 'important', message: 'У ребёнка аутизм, самочувствие плохое' },
      { type: 'fitness', severity: 'important', message: 'Ограниченная подвижность' },
      { type: 'safety', severity: 'critical', message: 'безбарьерная' },
    ] });
    const all = JSON.stringify(ai.mock.calls[0].slice(2));
    expect(all).not.toMatch(/аутизм|самочувств|подвижн|безбарьер|астм|914/i);
    // Предупреждение о безопасности (закрытый парк, тревога) до модели доходит —
    // общей фразой по типу, без текста из браузера (23.11). Раньше оно
    // отбрасывалось, и модель писала программу дня, не зная о закрытии.
    expect(ai.mock.calls[0][3]).toEqual([
      { type: 'season', severity: 'important', message: 'часть активностей зависит от сезона' },
      { type: 'safety', severity: 'critical', message: 'в плане есть предупреждения о безопасности — они показаны туристу отдельно' },
    ]);
  });
  it('ключ из прототипа («constructor») — не подпись и не предупреждение, 500 нет', async () => {
    ai.mockResolvedValueOnce('ok');
    const res = await call({
      ...body,
      days: [{ ...body.days[1], activityType: 'constructor' }],
      warnings: [{ type: 'constructor', severity: 'critical', message: 'x' }, { type: 'toString', severity: 'info', message: 'x' }],
    });
    expect(res.status).toBeLessThan(500);
    if (ai.mock.calls.length > 0) {
      expect(ai.mock.calls[0][3]).toEqual([]);
      expect(JSON.stringify(ai.mock.calls[0].slice(2))).not.toContain('native code');
    }
  });
  it('БД не ответила — 503, модель не зовётся', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const res = await call(body);
    expect(res.status).toBe(503);
    expect(ai).not.toHaveBeenCalled();
  });
  it('модель не ответила — честный отказ, план не трогается', async () => {
    ai.mockResolvedValueOnce(null);
    const data = await (await call(body)).json();
    expect(data.success).toBe(false);
    expect(data.error).toContain('план от этого не меняется');
  });
});
