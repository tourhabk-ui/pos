/**
 * Вошедший турист в веб-чате идёт тем же путём, что аноним и
 * /api/ai/chat-stream (аудит планировщика 07.11, K5).
 *
 * До этого «хочу тур …» у вошедшего уходил мимо витрины агенту брони с
 * инструментами. Агент ходил прямо в OpenRouter, а с прода это гео-блок:
 * турист секунды ждал отказа, и отвечал всё равно цикл Кузьмича. Ответь
 * агент — это был бы план без занятости и дат и без сверки цен, а в
 * chat-stream такой ветки не было вовсе: два входа вели себя по-разному.
 *
 * Проверяется вызовом POST роута: витрина спрашивается одинаково, агента
 * брони нет, сверка цен действует и для вошедшего. Зашитого id модели в
 * роуте и в раннере нет — это запрет, его держит регулярка по исходнику.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
vi.mock('@/lib/database', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
}));
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn().mockResolvedValue('ОДИНОЧНЫЙ ОТВЕТ'), callVision: vi.fn() }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
const user = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: (...a: unknown[]) => user(...a) }));
vi.mock('@/lib/ai/interest-extractor', () => ({ extractAndEncryptInterests: () => null }));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/ai/user-memory', () => ({
  loadUserMemory: vi.fn().mockResolvedValue(null),
  upsertUserMemory: vi.fn(),
  extractMemoryFromMessage: () => ({}),
  buildMemoryContext: () => '',
  buildAgentInsightsForTourist: vi.fn().mockResolvedValue(''),
  loadTripHistory: vi.fn().mockResolvedValue([]),
  synthesizeUserNotes: vi.fn(),
  addViewedTour: vi.fn(),
}));
vi.mock('@/lib/ai/booking-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/booking-intent')>()),
  detectTourIntent: () => ({ detected: true, activityType: 'volcano', rawWords: ['тур'] }),
  findRelevantTours: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: vi.fn().mockResolvedValue(''),
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
const sdk = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agents/sdk/sdk-runner', () => ({ runSDKAgent: (...a: unknown[]) => sdk(...a) }));
vi.mock('@/lib/agents/sdk/operator-tools', () => ({ getOperatorTools: vi.fn() }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
const loop = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kuzmich/core', () => ({
  aiChatAgentLoop: (...a: unknown[]) => loop(...a),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
  isAIErrorResponse: () => false,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
const commercial = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kuzmich/commercial-turn', () => ({
  resolveCommercialTurn: (...a: unknown[]) => commercial(...a),
}));

import { POST } from '@/app/api/ai/chat/route';

const ASK = 'Хочу тур на вулкан 15 июля';

async function ask(message: string): Promise<string> {
  const res = await POST(new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }) as unknown as NextRequest);
  expect(res.status).toBe(200);
  const json = await res.json() as { data: { answer: string } };
  return json.data.answer;
}

beforeEach(() => {
  vi.clearAllMocks();
  user.mockResolvedValue(null);
  commercial.mockResolvedValue(null);
  loop.mockImplementation(async (
    _text: string, _sys: string, _hist: unknown[], _extra: unknown[],
    runs: Array<{ name: string; producedData: boolean; output?: string }>,
  ) => {
    runs.push({ name: 'get_tours', producedData: true, output: 'Вулкан Горелый — 12 000 ₽ за человека' });
    return 'Есть «Вулкан Горелый» — 12 000 ₽ за человека.';
  });
});

describe('витрина — одна для анонима и вошедшего', () => {
  it('«хочу тур …» у вошедшего спрашивает витрину так же, как у анонима, и её ответ уходит человеку', async () => {
    commercial.mockResolvedValue({ visible: 'ВИТРИНА: туры на вулкан', tours: [] });

    expect(await ask(ASK)).toContain('ВИТРИНА: туры на вулкан');
    user.mockResolvedValue({ userId: 'u-1', role: 'tourist' });
    expect(await ask(ASK)).toContain('ВИТРИНА: туры на вулкан');

    expect(commercial).toHaveBeenCalledTimes(2);
    expect(commercial.mock.calls[0]![0]).toBe(ASK);
    expect(commercial.mock.calls[1]![0]).toBe(ASK);
    expect(commercial.mock.calls[1]![1]).toMatchObject({ surface: 'web' });
    expect(sdk).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
  });
});

describe('вошедший турист — цикл Кузьмича и сверка цен', () => {
  beforeEach(() => { user.mockResolvedValue({ userId: 'u-1', role: 'tourist' }); });

  it('витрина молчит — отвечает цикл, агента брони нет', async () => {
    const answer = await ask(ASK);
    expect(sdk).not.toHaveBeenCalled();
    expect(loop).toHaveBeenCalledTimes(1);
    expect(answer).toContain('12 000 ₽');
  });

  it('цена, которой нет в данных хода, вырезается и у вошедшего', async () => {
    loop.mockImplementation(async (
      _text: string, _sys: string, _hist: unknown[], _extra: unknown[],
      runs: Array<{ name: string; producedData: boolean; output?: string }>,
    ) => {
      runs.push({ name: 'get_tours', producedData: true, output: 'Вулкан Горелый — 12 000 ₽ за человека' });
      return 'Есть «Вулкан Горелый» — 12 000 ₽ за человека.\nА «Мутновский» — 9 500 ₽.';
    });
    const answer = await ask(ASK);
    expect(answer).toContain('12 000 ₽');
    expect(answer).not.toContain('9 500');
  });
});

describe('запрет: зашитого id модели нет', () => {
  it('ни в роуте веб-чата, ни в раннере агента; инструменты туриста роут не подключает', () => {
    const route = readFileSync('app/api/ai/chat/route.ts', 'utf8');
    const runner = readFileSync('lib/agents/sdk/sdk-runner.ts', 'utf8');
    const MODEL_ID = /['"`](openai|anthropic|google|deepseek|meta-llama|mistralai|qwen|x-ai)\/[\w.-]+['"`]/;
    expect(route).not.toMatch(MODEL_ID);
    expect(runner).not.toMatch(MODEL_ID);
    expect(route).not.toMatch(/agents\/sdk\/tourist-tools/);
  });
});
