/**
 * tests/unit/places-enricher-vs.test.ts
 *
 * places-enricher.rewriteDescription использует Verbalized Sampling: из
 * распределения вариантов берёт наименее шаблонный, при не-JSON — сырой текст.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callAIFastMock } = vi.hoisted(() => ({ callAIFastMock: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => callAIFastMock(...a) }));

import { rewriteDescription } from '@/lib/agents/places-enricher';

const RAW = 'Исходное описание природного объекта Камчатки длиной более ста символов, чтобы пройти минимальный порог рерайта.';
const long = (c: string) => c.repeat(200);

beforeEach(() => callAIFastMock.mockReset());

describe('rewriteDescription + Verbalized Sampling', () => {
  it('берёт наименее вероятный вариант из VS-распределения', async () => {
    callAIFastMock.mockResolvedValue(JSON.stringify([
      { probability: 0.9, text: long('шаблон-') },
      { probability: 0.2, text: long('свежий-') },
    ]));
    expect(await rewriteDescription('Вулкан', RAW)).toBe(long('свежий-'));
  });

  it('не-JSON → fallback на сырой текст', async () => {
    const plain = long('обычный-рерайт-');
    callAIFastMock.mockResolvedValue(plain);
    expect(await rewriteDescription('Вулкан', RAW)).toBe(plain);
  });

  it('слишком короткий исходник → null без вызова AI', async () => {
    expect(await rewriteDescription('Вулкан', 'коротко')).toBeNull();
    expect(callAIFastMock).not.toHaveBeenCalled();
  });

  it('промпт запрашивает распределение (VS-инструкция)', async () => {
    callAIFastMock.mockResolvedValue(long('x-'));
    await rewriteDescription('Вулкан', RAW);
    const messages = callAIFastMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const user = messages.find(m => m.role === 'user')!;
    expect(user.content).toMatch(/JSON-массив/);
  });
});
