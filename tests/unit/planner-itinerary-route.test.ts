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
  it('здоровье в модель не идёт и подставленным текстом (ревью #3743)', async () => {
    ai.mockResolvedValueOnce('ok');
    await call({
      ...body,
      days: [{ ...body.days[0], title: 'Ограниченная подвижность: маршруты адаптированы!', priceMissing: 'у меня астма',
        realTour: { operatorName: 'коляска' }, weatherForecast: { description: 'больное колено', tempMin: 1, tempMax: 2 } }],
      warnings: [
        body.warnings[0],
        { type: 'fitness', severity: 'important', message: 'Ограниченная подвижность: маршруты адаптированы, исключены многочасовые переходы и крутые подъёмы.!' },
        { type: 'mchs', severity: 'critical', message: 'Камчатка имеет крайне ограниченную безбарьерную инфраструктуру' },
        { type: 'season', severity: 'important', message: 'беременность — без вертолёта' },
      ],
    });
    const [, , days, warnings] = ai.mock.calls[0];
    const all = JSON.stringify({ days, warnings });
    expect(all).not.toMatch(/подвижн|астм|коляск|колен|безбарьер|беремен/i);
    expect(warnings).toEqual([body.warnings[0]]);
    expect((days as Array<{ title: string }>)[0].title).toBe('День 1');
  });
  it('тип дня — только из списка движка; слова вроде «сердечно-сосудистые», «инсульт» ловятся (ревью #3743, заход 3)', async () => {
    const r = await call({ ...body, days: [{ ...body.days[0], type: 'астма' }] });
    expect(r.status).toBe(400);
    expect(ai).not.toHaveBeenCalled();
    ai.mockResolvedValueOnce('ok');
    await call({ ...body, days: [{ ...body.days[0], realTour: { operatorName: 'Оператор', priceUnit: 'после инсульта' } }],
      warnings: [{ type: 'season', severity: 'important', message: 'при сердечно-сосудистых заболеваниях' }] });
    const all = JSON.stringify(ai.mock.calls[0].slice(2));
    expect(all).not.toMatch(/инсульт|сердечн|заболев/i);
  });
  it('словарь здоровья видит кириллицу целиком: ВИЧ, СПИД, ДЦП, рак (ревью #3743, заход 4)', async () => {
    const { HEALTH_WORDS } = await vi.importActual<typeof import('@/lib/planner/itinerary-input')>('@/lib/planner/itinerary-input');
    for (const w of ['ВИЧ', 'СПИД', 'ДЦП', 'рак', 'у меня рак.', 'ограничения по здоровью', 'сердечно-сосудистые', 'инсульт']) {
      expect(HEALTH_WORDS.test(w), w).toBe(true);
    }
    for (const w of ['Ракетный городок', 'Авача', 'вичуга', 'спидометр']) expect(HEALTH_WORDS.test(w), w).toBe(false);
  });
  it('телефон и почта в свободном тексте до модели не доходят (ревью #3743, заход 5)', async () => {
    ai.mockResolvedValueOnce('ok');
    await call({ ...body, days: [{ ...body.days[0], title: 'звонить +7 914 123-45-67, почта ivan@example.com' }],
      warnings: [{ type: 'season', severity: 'important', message: 'пишите ivan@example.com' }] });
    const all = JSON.stringify(ai.mock.calls[0].slice(2));
    expect(all).not.toContain('ivan@example.com');
    expect(all).not.toMatch(/914[\s-]*123/);
  });
});
