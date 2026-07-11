/**
 * tests/unit/ai-chat-kuzmich-brain.test.ts
 *
 * POST /api/ai/chat — подключение веб-чата к мозгу Кузьмича (core.ts).
 * Контракт: турист (включая анонима) → aiChatAgentLoop с KUZMICH_SYSTEM
 * (тот же agent loop c get_guardian_context, что у Telegram/MAX);
 * loop вернул null → фолбэк на legacy one-shot; не-tourist роль →
 * loop не вызывается (у них свои промпты/SDK-ветки).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
vi.mock('@/lib/ai/prompts', () => ({
  getSystemPrompt: vi.fn(() => 'LEGACY_PROMPT'),
  buildMessageHistory: vi.fn((sys: string, hist: unknown[]) => [{ role: 'system', content: sys }, ...hist]),
}));
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
  callGeminiVision: vi.fn(),
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
vi.mock('@/lib/ai/booking-intent', () => ({
  detectTourIntent: () => ({ detected: false, activityType: null, rawWords: [] }),
  findRelevantTours: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: vi.fn().mockResolvedValue('\nRAG_CTX'),
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/agents/sdk/sdk-runner', () => ({ runSDKAgent: vi.fn() }));
vi.mock('@/lib/agents/sdk/tourist-tools', () => ({ getTouristTools: vi.fn() }));
vi.mock('@/lib/agents/sdk/operator-tools', () => ({ getOperatorTools: vi.fn() }));

const aiChatAgentLoopMock = vi.fn();
vi.mock('@/lib/kuzmich/core', () => ({
  aiChatAgentLoop: (...a: unknown[]) => aiChatAgentLoopMock(...a),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
  isAIErrorResponse: (text: string) => text.startsWith('Извините, сервис временно недоступен'),
}));

import { POST } from '@/app/api/ai/chat/route';

function postReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
  getUserFromRequestMock.mockResolvedValue(null);
  callAIWithModelDirectMock.mockResolvedValue('LEGACY_ANSWER');
});

describe('POST /api/ai/chat — мозг Кузьмича для туристов', () => {
  it('аноним-турист → aiChatAgentLoop с KUZMICH_SYSTEM, legacy one-shot не вызывается', async () => {
    aiChatAgentLoopMock.mockResolvedValue('ОТВЕТ_КУЗЬМИЧА');

    const res = await POST(postReq({ message: 'Расскажи про Мутновский' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.answer).toBe('ОТВЕТ_КУЗЬМИЧА');
    expect(aiChatAgentLoopMock).toHaveBeenCalledTimes(1);
    const [userText, systemContent, history] = aiChatAgentLoopMock.mock.calls[0] as [string, string, Array<{ role: string; content: string }>];
    expect(userText).toBe('Расскажи про Мутновский');
    expect(systemContent.startsWith('KUZMICH_PERSONA')).toBe(true);
    expect(systemContent).toContain('RAG_CTX');
    // Юзер-сообщение уже в истории — loop строит [system, ...history]
    expect(history[history.length - 1]).toMatchObject({ role: 'user', content: 'Расскажи про Мутновский' });
    expect(callAIWithModelDirectMock).not.toHaveBeenCalled();
  });

  it('loop вернул null (4 хода исчерпаны) → фолбэк на legacy one-shot', async () => {
    aiChatAgentLoopMock.mockResolvedValue(null);

    const res = await POST(postReq({ message: 'Привет' }));
    const json = await res.json();

    expect(json.data.answer).toBe('LEGACY_ANSWER');
    expect(callAIWithModelDirectMock).toHaveBeenCalledTimes(1);
  });

  it('loop бросил исключение → фолбэк на legacy one-shot, не 500', async () => {
    aiChatAgentLoopMock.mockRejectedValue(new Error('openrouter down'));

    const res = await POST(postReq({ message: 'Привет' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.answer).toBe('LEGACY_ANSWER');
  });

  it('не-tourist роль (guide) → loop не вызывается, legacy как раньше', async () => {
    const res = await POST(postReq({ message: 'Привет', role: 'guide' }));
    const json = await res.json();

    expect(json.data.answer).toBe('LEGACY_ANSWER');
    expect(aiChatAgentLoopMock).not.toHaveBeenCalled();
    expect(callAIWithModelDirectMock).toHaveBeenCalledTimes(1);
  });

  it('фолбэк-ошибка конвейера → не пишется в историю сессии и не списывает бесплатное сообщение', async () => {
    aiChatAgentLoopMock.mockResolvedValue(null);
    callAIWithModelDirectMock.mockResolvedValue('Извините, сервис временно недоступен. Попробуйте позже.');

    const res = await POST(postReq({ message: 'Привет', sessionId: 's-err-1' }));
    const json = await res.json();

    // Ответ пользователю уходит как есть (клиент показывает ссылку в каталог)
    expect(json.data.answer).toContain('временно недоступен');
    // Аноним не платит бесплатным сообщением за ошибку сервиса
    expect(json.data.remainingFree).toBe(10);

    // saveSession: в messages нет assistant-ошибки, счётчик не инкрементирован
    const saveCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO chat_sessions'),
    );
    expect(saveCall).toBeDefined();
    const [, params] = saveCall as [string, unknown[]];
    const savedMessages = JSON.parse(params[3] as string) as Array<{ role: string; content: string }>;
    expect(savedMessages.some((m) => m.role === 'assistant' && m.content.includes('временно недоступен'))).toBe(false);
    expect(savedMessages[savedMessages.length - 1]).toMatchObject({ role: 'user', content: 'Привет' });
    expect(params[4]).toBe(0); // user_message_count не вырос
  });
});
