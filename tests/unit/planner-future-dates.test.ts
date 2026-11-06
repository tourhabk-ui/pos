// @vitest-environment node
/**
 * Даты без года — ближайшие будущие (независимая проверка аудита
 * планировщика 07.11, Б3). Подсказка модели на /planner требовала «Если год не
 * указан, используй 2026», запасной разбор брал текущий год: в ноябре 2026
 * «с 10 по 14 июля» становилось прошедшими датами. Проверка — вызовом правила,
 * маршрута с подменённой моделью и запасного разбора на «сегодня» 06.11.2026.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const prompts: string[] = [];
let modelReply = '';
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(async (messages: Array<{ content: string }>) => {
    prompts.push(messages.map((m) => m.content).join('\n'));
    return modelReply;
  }),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { futureTripDates } from '@/lib/planner/future-trip-dates';
import { parseInterestsFromText } from '@/lib/planner/interests';
import { POST } from '@/app/api/planner/chat/route';

const TODAY = '2026-11-06';

describe('правило: прошедшая дата без года — ближайшая будущая', () => {
  it('июль в ноябре — июль следующего года, отъезд вместе с прилётом', () => {
    expect(futureTripDates('2026-07-10', '2026-07-14', TODAY)).toEqual({ arrival: '2027-07-10', departure: '2027-07-14' });
  });
  it('даты впереди и сегодня — не трогаются', () => {
    expect(futureTripDates('2026-12-01', '2026-12-05', TODAY)).toEqual({ arrival: '2026-12-01', departure: '2026-12-05' });
    expect(futureTripDates(TODAY, '2026-11-10', TODAY)).toEqual({ arrival: TODAY, departure: '2026-11-10' });
  });
  it('отъезд раньше прилёта — в следующий год; 29 февраля в невисокосный — 28-е', () => {
    expect(futureTripDates('2026-12-25', '2026-01-05', TODAY)).toEqual({ arrival: '2026-12-25', departure: '2027-01-05' });
    expect(futureTripDates('2024-02-29', '2024-03-03', TODAY)).toEqual({ arrival: '2027-02-28', departure: '2027-03-03' });
  });
  it('нет даты или не дата — как есть', () => {
    expect(futureTripDates(null, null, TODAY)).toEqual({ arrival: null, departure: null });
    expect(futureTripDates('июль', null, TODAY)).toEqual({ arrival: 'июль', departure: null });
  });
});

describe('путь «опиши поездку» на /planner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T03:00:00Z'));
    prompts.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  const ask = (message: string, ip: string) => POST(new NextRequest('http://localhost/api/planner/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ message }),
  }));

  it('модель поставила текущий год прошедшим датам — план получает следующий; в подсказке сегодняшний день, а не «2026»', async () => {
    modelReply = '{"places":["volcano"],"activities":["fishing"],"arrival":"2026-07-10","departure":"2026-07-14","duration_days":null}';
    const res = await ask('вулканы и рыбалка с 10 по 14 июля', '10.0.0.1');
    const body = await res.json() as { arrival: string; departure: string };
    expect([body.arrival, body.departure]).toEqual(['2027-07-10', '2027-07-14']);
    expect(prompts[0]).toContain(`Сегодня ${TODAY}`);
    expect(prompts[0]).not.toMatch(/используй 2026/);
  });

  it('запасной разбор (модель молчит) — тоже ближайшие будущие даты', async () => {
    modelReply = '';
    const res = await ask('рыбалка с 10 по 14 июля', '10.0.0.2');
    const body = await res.json() as { arrival: string; departure: string };
    expect([body.arrival, body.departure]).toEqual(['2027-07-10', '2027-07-14']);
    expect(parseInterestsFromText('рыбалка с 10 по 14 июля').dateFrom).toBe('2027-07-10');
  });
});
