// @vitest-environment node
/**
 * «Посмотреть вулканы» — не треккинг (#3199, Б23).
 *
 * Словарь подбора маршрутов (`parseInterestsFromText`) читает «вулкан»,
 * «гора», «маршрут» как треккинг. Кузьмич это обошёл 08.11 (второму словарю
 * отдаётся только непонятое первым), а запасной разбор веб-чата планера —
 * нет: «хочу посмотреть вулканы» давало ещё и треккинг. Теперь оба пути
 * идут через одну функцию `withoutInterestWords`. Судится вызовом: чистая
 * функция, разбор Кузьмича и роут с моделью, не давшей ответа.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => '') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { POST } from '@/app/api/planner/chat/route';
import { withoutInterestWords } from '@/lib/planner/interest-words';
import { parseChatInterests } from '@/lib/kuzmich/trip-plan-tool';

let ipSeq = 0;
const ask = (message: string) => POST(new NextRequest('http://localhost/api/planner/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.0.${++ipSeq}` },
  body: JSON.stringify({ message }),
}));

describe('слова, понятые словарём планера, второму словарю не достаются', () => {
  it('withoutInterestWords вырезает «вулканы», остальное оставляет', () => {
    const rest = withoutInterestWords('Хочу посмотреть вулканы и сходить в поход по маршруту');
    expect(rest).not.toContain('вулкан');
    expect(rest).not.toContain('поход');
    expect(rest).toContain('маршрут');
  });

  it('Кузьмич: «вулканы, 6 дней» — вулканы без треккинга', () => {
    expect(parseChatInterests('вулканы, 6 дней')).toEqual(['volcano']);
  });
});

describe('веб-чат планера: запасной разбор без модели', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T03:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('«хочу посмотреть вулканы» — место «вулкан», треккинга нет', async () => {
    const body = await (await ask('хочу посмотреть вулканы')).json() as { places: string[]; activities: string[] };
    expect(body.places).toEqual(['volcano']);
    expect(body.activities).not.toContain('trekking');
  });

  it('о чём словарь планера не знает, второй словарь по-прежнему ловит', async () => {
    const body = await (await ask('рыбалка на чавычу')).json() as { places: string[]; activities: string[] };
    expect(body.activities).toEqual(['fishing']);
  });

  it('треккинг, названный прямо, остаётся', async () => {
    const body = await (await ask('вулканы и треккинг')).json() as { places: string[]; activities: string[] };
    expect(body.places).toEqual(['volcano']);
    expect(body.activities).toEqual(['trekking']);
  });
});
