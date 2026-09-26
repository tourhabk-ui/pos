/**
 * План поездки через Кузьмича и MCP знает «как ехать» и «дни отдыха»
 * (решение владельца 26.09: «в mcp это попадает?» — «согласен»).
 *
 * До этого `make_trip_plan` принимал только дни, интересы и дату, и любой
 * внешний ассистент получал план «вперемешку» без выбора. Поля свободные:
 * модель передаёт слово туриста, инструмент разбирает; не понял — поля нет,
 * то есть «вперемешку», как раньше. Выдумать выбор за туриста нельзя.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { recommendMock } = vi.hoisted(() => ({ recommendMock: vi.fn() }));

vi.mock('@/lib/planner', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, recommendTrip: (...a: unknown[]) => recommendMock(...a) };
});

import { makeTripPlanForKuzmich, readTravelStyle, readRestDays } from '@/lib/kuzmich/trip-plan-tool';
import { KUZMICH_TOOLS, validateToolArgs } from '@/lib/kuzmich/tool-schemas';

beforeEach(() => {
  recommendMock.mockReset();
  recommendMock.mockResolvedValue({
    days: [{
      day: 2, type: 'activity', activityMode: 'self', title: 'Тропа к Сухой речке', description: '',
      zone: 'avachinsky', activityType: 'trekking', priceFrom: 0, priceTo: 0,
      coords: [53.2, 158.6], defaultTransport: 'walking', allowedTransports: ['walking'],
      difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
    }],
    warnings: [], priceBreakdown: {}, itinerary: '', catalogueOpen: null,
    preferences: {
      travelStyle: 'self', restDaysRequested: 1, restDaysPlanned: 1,
      notes: [{ topic: 'travel_style', status: 'partial', message: 'Не ставим без гида: Перевал — МЧС.' }],
    },
  });
});

describe('разбор слова модели', () => {
  it('коды и русские слова', () => {
    expect(readTravelStyle('self')).toBe('self');
    expect(readTravelStyle('сам')).toBe('self');
    expect(readTravelStyle('с гидом')).toBe('operator');
    expect(readTravelStyle('вперемешку')).toBe('mixed');
  });

  it('непонятое и пустое — поля нет, а не выдуманный выбор', () => {
    expect(readTravelStyle('как получится')).toBeUndefined();
    expect(readTravelStyle(undefined)).toBeUndefined();
    expect(readRestDays('2')).toBe(2);
    expect(readRestDays('15')).toBeUndefined();
    expect(readRestDays('два')).toBeUndefined();
    expect(readRestDays(undefined)).toBeUndefined();
  });
});

describe('инструмент передаёт выбор в движок и говорит, что вышло', () => {
  it('travel_style и rest_days доходят до recommendTrip', async () => {
    await makeTripPlanForKuzmich({ days: '7', interests: 'треккинг', when: '2027-07-10', travel_style: 'сам', rest_days: '1' });
    expect(recommendMock).toHaveBeenCalledWith(expect.objectContaining({ travelStyle: 'self', restDays: 1 }));
  });

  it('без полей — как прежде: стиль не задан', async () => {
    await makeTripPlanForKuzmich({ days: '7', interests: 'треккинг', when: '2027-07-10' });
    const profile = recommendMock.mock.calls[0][0] as Record<string, unknown>;
    expect(profile.travelStyle).toBeUndefined();
    expect(profile.restDays).toBeUndefined();
  });

  it('частично исполненная просьба попадает в ответ', async () => {
    const text = await makeTripPlanForKuzmich({ days: '7', interests: 'треккинг', when: '2027-07-10', travel_style: 'self' });
    expect(text).toContain('Не ставим без гида: Перевал — МЧС.');
  });
});

describe('поля объявлены везде, где их читают', () => {
  it('схема и описание для модели', () => {
    const def = KUZMICH_TOOLS.find((t) => t.function.name === 'make_trip_plan');
    const props = def?.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('travel_style');
    expect(props).toHaveProperty('rest_days');
    expect(validateToolArgs('make_trip_plan', { travel_style: 'сам', rest_days: '1' }).ok).toBe(true);
  });

  it('MCP: английское описание; Кузьмич: аргументы проброшены', () => {
    const mcp = readFileSync('lib/mcp/public-tools.ts', 'utf-8');
    expect(mcp).toMatch(/travel_style: \{ lead: 'How the traveller wants to go/);
    expect(mcp).toMatch(/rest_days: \{ lead: 'Rest days to add/);
    const core = readFileSync('lib/kuzmich/core.ts', 'utf-8');
    expect(core).toMatch(/travel_style: args\.travel_style, rest_days: args\.rest_days/);
  });
});
