// @vitest-environment node
/**
 * Сторож: сведения о здоровье из анкеты планировщика остаются у нас.
 *
 * Решение владельца 26.09: «Ограничения по здоровью» и «Подвижность» идут
 * ТОЛЬКО в /api/planner/recommend — в наш движок. Здоровье — особая
 * категория ПД (152-ФЗ), а модели у нас зарубежные (CLAUDE.md §8), поэтому:
 *   — роут принимает поля с проверкой длины и значений (Zod);
 *   — в память предпочтений (agentMemory) они не пишутся;
 *   — в лог при отказе не попадают;
 *   — в промпт модели не уходят (это держит planner-travel-style на движке);
 *   — в разбор фразы (/api/planner/chat, там модель) не принимаются
 *     (planner-steps).
 * Здесь же — разбор стиля и дней отдыха из слов (без модели).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const recommendTrip = vi.fn();
vi.mock('@/lib/planner/engine', () => ({ recommendTrip: (...a: unknown[]) => recommendTrip(...a) }));
vi.mock('@/lib/auth', () => ({ verifyAuth: vi.fn(async () => ({ userId: 'u-1' })) }));
const remember = vi.fn(async () => undefined);
vi.mock('@/lib/agents/memory/agent-memory', () => ({
  agentMemory: { get: vi.fn(async () => null), remember: (...a: unknown[]) => remember(...(a as [])) },
}));

import { POST } from '@/app/api/planner/recommend/route';
import { parseTravelPreferences } from '@/lib/planner/travel-style-words';

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/planner/recommend', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}));

const VALID = {
  interests: ['volcano'], arrivalDate: '2030-08-03', departureDate: '2030-08-12',
  adults: 2, children: [], healthNotes: 'астма, колено', mobilityLevel: 'limited',
  travelStyle: 'self', restDays: 2,
};

beforeEach(() => {
  recommendTrip.mockReset();
  recommendTrip.mockResolvedValue({ zones: [], days: [], warnings: [], itinerary: '' });
  remember.mockClear();
});

describe('/api/planner/recommend принимает новые поля', () => {
  it('здоровье, подвижность, стиль и отдых доходят до движка', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(200);
    const profile = recommendTrip.mock.calls[0][0] as Record<string, unknown>;
    expect(profile.healthNotes).toBe('астма, колено');
    expect(profile.mobilityLevel).toBe('limited');
    expect(profile.travelStyle).toBe('self');
    expect(profile.restDays).toBe(2);
  });

  it('проверка длины и значений', async () => {
    for (const bad of [
      { healthNotes: 'а'.repeat(301) },
      { mobilityLevel: 'crawling' },
      { travelStyle: 'solo' },
      { restDays: 15 },
      { restDays: -1 },
      { restDays: 1.5 },
    ]) {
      recommendTrip.mockClear();
      const res = await post({ ...VALID, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(recommendTrip).not.toHaveBeenCalled();
    }
  });

  it('в память предпочтений здоровье не пишется', async () => {
    await post(VALID);
    await new Promise((r) => setTimeout(r, 0));
    expect(remember).toHaveBeenCalled();
    const saved = JSON.stringify(remember.mock.calls);
    expect(saved).not.toContain('астма');
    expect(saved).not.toMatch(/healthNotes|mobilityLevel/);
  });

  it('при отказе движка здоровье не попадает в лог', async () => {
    recommendTrip.mockRejectedValueOnce(new Error('boom'));
    const spies = (['error', 'warn', 'log', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const res = await post(VALID);
    expect(res.status).toBe(500);
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain('астма');
      s.mockRestore();
    }
  });
});

describe('стиль и отдых из слов — без модели', () => {
  it('стиль', () => {
    expect(parseTravelPreferences('вулканы, сами, 7 дней').travelStyle).toBe('self');
    expect(parseTravelPreferences('хотим самостоятельно').travelStyle).toBe('self');
    expect(parseTravelPreferences('без гида по треккингу').travelStyle).toBe('self');
    expect(parseTravelPreferences('медведи с гидом').travelStyle).toBe('operator');
    expect(parseTravelPreferences('рыбалка с оператором').travelStyle).toBe('operator');
    expect(parseTravelPreferences('сам по городу, на вулкан с гидом').travelStyle).toBe('mixed');
    expect(parseTravelPreferences('вперемешку').travelStyle).toBe('mixed');
    // Не сказано — не угадываем: «самолёт» не «сам».
    expect(parseTravelPreferences('прилетаю самолётом 3 июля').travelStyle).toBeNull();
    expect(parseTravelPreferences('вулканы и рыбалка').travelStyle).toBeNull();
  });

  it('дни отдыха', () => {
    expect(parseTravelPreferences('10 дней, 2 дня отдыха').restDays).toBe(2);
    expect(parseTravelPreferences('два дня на отдых').restDays).toBe(2);
    expect(parseTravelPreferences('день отдыха в середине').restDays).toBe(1);
    expect(parseTravelPreferences('отдых 3 дня').restDays).toBe(3);
    expect(parseTravelPreferences('без отдыха').restDays).toBe(0);
    expect(parseTravelPreferences('7 дней в июне').restDays).toBeNull();
  });
});
