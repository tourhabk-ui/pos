import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindRoutePreflightSafety = vi.fn();
vi.mock('@/lib/services/route-preflight-safety', () => ({
  findRoutePreflightSafety: (...args: unknown[]) => mockFindRoutePreflightSafety(...args),
}));

const mockPoolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

import { GuideAgency, extractRouteQueryFromMessage } from '@/lib/agents/agencies/guide-agency';
import type { AgentContext } from '@/lib/agents/context-hub';

const emptyContext = {} as AgentContext;

describe('extractRouteQueryFromMessage', () => {
  it('strips the trigger phrase and returns the route name', () => {
    expect(extractRouteQueryFromMessage('проверь маршрут Авачинский вулкан')).toBe('Авачинский вулкан');
  });

  it('strips a leading preposition left after the trigger', () => {
    expect(extractRouteQueryFromMessage('предполётная проверка на Мутновский')).toBe('Мутновский');
  });

  it('returns empty string when no route name follows the trigger', () => {
    expect(extractRouteQueryFromMessage('проверь маршрут')).toBe('');
  });

  it('is case-insensitive when matching the trigger', () => {
    expect(extractRouteQueryFromMessage('ПРОВЕРЬ МАРШРУТ Толбачик')).toBe('Толбачик');
  });
});

describe('GuideAgency.run — guide_route_preflight (issue #248)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for a route name when the message has none', async () => {
    const result = await new GuideAgency().run('guide_route_preflight', emptyContext, 'проверь маршрут');
    expect(result.response).toContain('Укажите название маршрута');
    expect(mockFindRoutePreflightSafety).not.toHaveBeenCalled();
  });

  it('reports "не найден" when no route matches', async () => {
    mockFindRoutePreflightSafety.mockResolvedValue(null);
    const result = await new GuideAgency().run('guide_route_preflight', emptyContext, 'проверь маршрут Незнамо-Где');
    expect(result.response).toContain('не найден');
  });

  it('lists missing safety fields explicitly as "нет данных", not silently', async () => {
    mockFindRoutePreflightSafety.mockResolvedValue({
      routeId: 'r1',
      title: 'Мутновский вулкан',
      hasGeometry: false,
      hasMchsContact: false,
      mchsRegistrationRequired: null,
      difficulty: null,
      hazards: [],
      equipment: [],
    });

    const result = await new GuideAgency().run('guide_route_preflight', emptyContext, 'проверь маршрут Мутновский');

    expect(result.response).toContain('Мутновский вулкан');
    expect((result.response.match(/нет данных/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('reports populated safety fields when available', async () => {
    mockFindRoutePreflightSafety.mockResolvedValue({
      routeId: 'r2',
      title: 'Авачинский вулкан',
      hasGeometry: true,
      hasMchsContact: true,
      mchsRegistrationRequired: true,
      difficulty: 'hard',
      hazards: ['камнепад'],
      equipment: ['ботинки'],
    });

    const result = await new GuideAgency().run('guide_route_preflight', emptyContext, 'проверь маршрут Авачинский');

    expect(result.response).toContain('камнепад');
    expect(result.response).toContain('ботинки');
    expect(result.response).toContain('hard');
    expect(result.data).toMatchObject({ routeId: 'r2', hasGeometry: true });
  });
});
