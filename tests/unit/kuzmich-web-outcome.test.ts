/**
 * Исход ответа Кузьмича на сайте пишется (аудит 15.10, P4-06, A20 (б)).
 *
 * Грейдер звался только из aiChat (Telegram, MAX): веб-чат — основной трафик —
 * не оценивался вовсе, и перепись видела пять веб-исходов за 60 суток. Теперь
 * POST /api/ai/chat отдаёт грейдеру каждый ответ туристу; содержательный ли
 * вопрос, потолок в сутки, чистка ПД и хэш сессии — внутри грейдера (его
 * сторож — kuzmich-grader-cap.test.ts).
 *
 * Сторож — вызовом роута; подменены мозг Кузьмича и грейдер. Судится, ЧТО
 * роут передал грейдеру: вопрос, ответ МОДЕЛИ (без SOS-блока и поправок
 * сторожей), ключ сессии и происхождение ответа. Заодно — граница ПД у агента
 * брони: в модель уходит вопрос без телефона.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
const queryMock = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
}));
const callAIWithModelDirectMock = vi.fn().mockResolvedValue('LEGACY_ANSWER');
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: (...a: unknown[]) => callAIWithModelDirectMock(...a),
  callVision: vi.fn(),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
const getUserFromRequestMock = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: (...a: unknown[]) => getUserFromRequestMock(...a) }));
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
const detectTourIntentMock = vi.fn(() => ({ detected: false, activityType: null as string | null, rawWords: [] as string[] }));
vi.mock('@/lib/ai/booking-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/booking-intent')>()),
  detectTourIntent: () => detectTourIntentMock(),
  findRelevantTours: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: vi.fn().mockResolvedValue(''),
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
const runSDKAgentMock = vi.fn();
vi.mock('@/lib/agents/sdk/sdk-runner', () => ({ runSDKAgent: (...a: unknown[]) => runSDKAgentMock(...a) }));
vi.mock('@/lib/agents/sdk/tourist-tools', () => ({ getTouristTools: vi.fn(() => []) }));
vi.mock('@/lib/agents/sdk/operator-tools', () => ({ getOperatorTools: vi.fn() }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

const aiChatAgentLoopMock = vi.fn();
vi.mock('@/lib/kuzmich/core', () => ({
  aiChatAgentLoop: (...a: unknown[]) => aiChatAgentLoopMock(...a),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
  isAIErrorResponse: (text: string) => text.startsWith('Извините, сервис временно недоступен'),
}));
const gradeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>();
  return { ...orig, gradeKuzmichResponse: (...a: unknown[]) => gradeMock(...a) };
});

import { POST } from '@/app/api/ai/chat/route';
import { fingerprintPrompt } from '@/lib/agents/managed/kuzmich-outcomes';

function postReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const LOOP_ANSWER = 'Авачинский сейчас спокоен: зелёный код. Подъём от базы около 6 часов, регистрация в МЧС обязательна.';

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
  getUserFromRequestMock.mockResolvedValue(null);
  callAIWithModelDirectMock.mockResolvedValue('LEGACY_ANSWER');
  detectTourIntentMock.mockReturnValue({ detected: false, activityType: null, rawWords: [] });
  aiChatAgentLoopMock.mockImplementation(async (
    _text: string, _sys: string, _hist: unknown[], _extra: unknown[],
    runs: Array<{ name: string; producedData: boolean }>, prov?: { provider?: string },
  ) => {
    runs.push({ name: 'get_guardian_context', producedData: true });
    if (prov) prov.provider = 'deepseek';
    return LOOP_ANSWER;
  });
});

describe('веб-чат отдаёт исход ответа грейдеру', () => {
  it('ответ цикла Кузьмича: вопрос, ответ модели, ключ сессии и происхождение', async () => {
    const res = await POST(postReq({ message: 'Когда лучше идти на Авачинский вулкан?', sessionId: 'web-s-1' }));
    expect(res.status).toBe(200);

    expect(gradeMock).toHaveBeenCalledTimes(1);
    const [question, answer, key, opts] = gradeMock.mock.calls[0] as [string, string, string, Record<string, unknown>];
    expect(question).toBe('Когда лучше идти на Авачинский вулкан?');
    expect(answer).toBe(LOOP_ANSWER);
    // Сырой ключ уходит в грейдер, а тот пишет только его хэш (kuzmich-grader-cap).
    expect(key).toBe('web-s-1');
    expect(opts).toMatchObject({
      surface: 'web',
      answerPath: 'tools',
      provider: 'deepseek',
      promptFingerprint: fingerprintPrompt('KUZMICH_PERSONA'),
    });
    expect((opts.toolRuns as Array<{ name: string }>).map((r) => r.name)).toEqual(['get_guardian_context']);
    expect(opts.toolsOffered).toContain('get_guardian_context');
  });

  it('грейдер получает ответ модели без SOS-блока, турист — с ним', async () => {
    const res = await POST(postReq({ message: 'Заблудился на вулкане, где я, помогите' }));
    const json = await res.json();
    expect(json.data.answer).toContain('112');
    expect(gradeMock).toHaveBeenCalledTimes(1);
    expect(gradeMock.mock.calls[0]![1]).toBe(LOOP_ANSWER);
  });

  it('запасной одиночный вызов: инструментов не было — журнал пуст, путь не записан', async () => {
    aiChatAgentLoopMock.mockResolvedValue(null);
    await POST(postReq({ message: 'Что взять в поход на вулкан?' }));
    expect(gradeMock).toHaveBeenCalledTimes(1);
    const [, answer, key, opts] = gradeMock.mock.calls[0] as [string, string, unknown, Record<string, unknown>];
    expect(answer).toBe('LEGACY_ANSWER');
    expect(key).toBeNull();
    expect(opts).toMatchObject({ surface: 'web', answerPath: null, provider: null, toolRuns: [] });
  });

  it('не турист (гид) — грейдер не зовётся: рубрика про ответы туристу', async () => {
    await POST(postReq({ message: 'Где маршрут на вулкан?', role: 'guide' }));
    expect(gradeMock).not.toHaveBeenCalled();
  });
});

describe('агент брони на сайте — та же граница ПД', () => {
  it('в модель уходит вопрос без телефона; журнала у агента нет — заземление «не проверено»', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 'u-1', role: 'tourist' });
    detectTourIntentMock.mockReturnValue({ detected: true, activityType: 'volcano', rawWords: ['тур'] });
    runSDKAgentMock.mockResolvedValue({ response: 'Нашёл тур на Авачинский: 9000 ₽, 15 июля.' });

    await POST(postReq({ message: 'Хочу тур на вулкан 15 июля, мой телефон +7 914 123-45-67' }));

    expect(runSDKAgentMock).toHaveBeenCalledTimes(1);
    const { userMessage } = runSDKAgentMock.mock.calls[0]![0] as { userMessage: string };
    expect(userMessage).toContain('[телефон]');
    expect(userMessage.replace(/\D/g, '')).not.toContain('9141234567');

    const opts = gradeMock.mock.calls[0]![3] as Record<string, unknown>;
    expect(opts.toolRuns).toBeUndefined();
  });
});
