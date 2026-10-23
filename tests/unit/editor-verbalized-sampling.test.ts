/**
 * tests/unit/editor-verbalized-sampling.test.ts
 *
 * Editor больше НЕ берёт наименее типичный вариант (23.10, владелец: «Editor
 * много выдумал его ужесточить промтном»). Прежний промпт просил три варианта
 * и сохранял наименее вероятный — для справочного текста это самый сочинённый.
 * Теперь: один ответ при низкой температуре; если модель всё же прислала
 * массив вариантов, берётся САМЫЙ вероятный; «НЕТ» — исход «фактов мало», а
 * не провал генерации. Судится вызовом `generateRouteDescription`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callAIFastMock } = vi.hoisted(() => ({ callAIFastMock: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  // Реестр заглушек берётся НАСТОЯЩИЙ: Editor обязан сверяться с ним,
  // а не с длиной (находка аудита 08.09).
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callAIQuality: (...a: unknown[]) => callAIFastMock(...a),
  callAIQualityOrNull: async (...a: unknown[]) => {
    const text = await callAIFastMock(...a);
    return text === 'Сервис временно недоступен.' ? null : text;
  },
}));

import { generateRouteDescription, EDITOR_TEMPERATURE, type RouteRow } from '@/lib/agents/editor';

const ROUTE: RouteRow = {
  id: 'r1', title: 'Вулкан Тестовый', description: null, category: 'vulkani',
  kind: 'route', lat: null, lng: null, location_type: 'volcano', activity_type: null, zone: null,
  source_name: null, altitude_m: 2741, terrain_type: null, hazard_types: null, difficulty_level: null,
  nearest_medical_km: null, distance_km: 12, elevation_gain_m: null, duration_hours: null, season: 'summer',
  route_type: 'radial', hazards: null, equipment: null, park_name: null,
};
const long = (c: string) => c.repeat(20);

beforeEach(() => callAIFastMock.mockReset());

describe('generateRouteDescription: один строгий ответ', () => {
  it('промпт не просит распределения вариантов, а температура низкая', async () => {
    callAIFastMock.mockResolvedValue(long('Вулкан Тестовый, радиальный маршрут. '));
    await generateRouteDescription(ROUTE);
    const [messages, opts] = callAIFastMock.mock.calls[0] as [Array<{ role: string; content: string }>, { temperature?: number }];
    const user = messages.find((m) => m.role === 'user')!;
    expect(user.content).not.toMatch(/JSON-массив|вероятност/i);
    expect(opts.temperature).toBe(EDITOR_TEMPERATURE);
    expect(EDITOR_TEMPERATURE).toBeLessThanOrEqual(0.3);
  });

  it('прислан массив вариантов — берётся самый вероятный, а не наименее типичный', async () => {
    callAIFastMock.mockResolvedValue(JSON.stringify([
      { probability: 0.8, text: long('типичный-') },
      { probability: 0.15, text: long('свежий-') },
    ]));
    const out = await generateRouteDescription(ROUTE);
    expect(out.text).toBe(long('типичный-'));
  });

  it('обычный текст — как есть', async () => {
    const plain = long('Вулкан Тестовый, сезон — лето. ');
    callAIFastMock.mockResolvedValue(plain);
    expect((await generateRouteDescription(ROUTE)).text).toBe(plain.trim());
  });

  it('«НЕТ» — исход «фактов мало», а не провал генерации', async () => {
    for (const answer of ['НЕТ', 'Нет.', ' «НЕТ» ']) {
      callAIFastMock.mockResolvedValueOnce(answer);
      const out = await generateRouteDescription(ROUTE);
      expect(out.text).toBeNull();
      expect(out.noSource).toBe(true);
    }
  });

  it('пустой ответ → провал генерации', async () => {
    callAIFastMock.mockResolvedValue(null);
    const out = await generateRouteDescription(ROUTE);
    expect(out.text).toBeNull();
    expect(out.noSource).toBeUndefined();
    expect(out.failReason).toBeTruthy();
  });
});
