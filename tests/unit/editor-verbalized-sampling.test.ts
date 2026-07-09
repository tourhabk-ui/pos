/**
 * tests/unit/editor-verbalized-sampling.test.ts
 *
 * Editor использует Verbalized Sampling: из распределения вариантов берёт
 * наименее шаблонный качественный, а при не-JSON ответе — сырой текст (fallback,
 * поведение не хуже прежнего).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callAIFastMock } = vi.hoisted(() => ({ callAIFastMock: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => callAIFastMock(...a) }));

import { generateRouteDescription, type RouteRow } from '@/lib/agents/editor';

const ROUTE: RouteRow = { id: 'r1', title: 'Вулкан Тестовый', description: null, category: 'vulkani' };
// Без пробелов по краям повторяемого токена — parseVerbalizedSamples тримит text.
const long = (c: string) => c.repeat(200);

beforeEach(() => callAIFastMock.mockReset());

describe('generateRouteDescription + Verbalized Sampling', () => {
  it('берёт наименее вероятный вариант из VS-распределения', async () => {
    callAIFastMock.mockResolvedValue(JSON.stringify([
      { probability: 0.8, text: long('типичный-') },
      { probability: 0.15, text: long('свежий-') },
    ]));
    const out = await generateRouteDescription(ROUTE);
    expect(out.text).toBe(long('свежий-'));
  });

  it('не-JSON ответ → fallback на сырой текст (не хуже прежнего)', async () => {
    const plain = long('обычное-описание-');
    callAIFastMock.mockResolvedValue(plain);
    const out = await generateRouteDescription(ROUTE);
    expect(out.text).toBe(plain);
  });

  it('промпт запрашивает распределение (VS-инструкция в user-сообщении)', async () => {
    callAIFastMock.mockResolvedValue(long('x-'));
    await generateRouteDescription(ROUTE);
    const messages = callAIFastMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const user = messages.find(m => m.role === 'user')!;
    expect(user.content).toMatch(/JSON-массив/);
    expect(user.content).toMatch(/вероятност/i);
  });

  it('пустой ответ → провал генерации', async () => {
    callAIFastMock.mockResolvedValue(null);
    const out = await generateRouteDescription(ROUTE);
    expect(out.text).toBeNull();
    expect(out.failReason).toBeTruthy();
  });
});
