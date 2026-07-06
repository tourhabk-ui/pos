/**
 * tests/unit/ai-chat-stream-kuzmich-brain.test.ts
 *
 * POST /api/ai/chat-stream — подключение SSE-чата к мозгу Кузьмича (core.ts).
 * Контракт: турист → aiChatAgentLoop с KUZMICH_SYSTEM, ответ уходит в SSE
 * по словам (token-события), OpenRouter-стрим НЕ открывается (нет двойной
 * генерации); loop вернул null → фолбэк на legacy one-shot с прежним
 * псевдостримом; не-tourist роль → loop не вызывается. SSE-контракт
 * (start/token/end + finalResponse) сохранён — его читает useAIStream.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
const queryMock = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/ai/prompts', () => ({
  getSystemPrompt: vi.fn(() => 'LEGACY_PROMPT'),
  buildMessageHistory: vi.fn((sys: string, hist: unknown[]) => [{ role: 'system', content: sys }, ...hist]),
}));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: vi.fn().mockResolvedValue('\nRAG_CTX'),
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
const getOpenRouterKeyMock = vi.fn(() => null); // ленивый OR-стрим: без ключа → null
vi.mock('@/lib/ai/provider-config', () => ({ getOpenRouterKey: () => getOpenRouterKeyMock() }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
}));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
const callAIWithModelDirectMock = vi.fn().mockResolvedValue('LEGACY_ANSWER');
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: (...a: unknown[]) => callAIWithModelDirectMock(...a),
}));
vi.mock('@/lib/ai/interest-extractor', () => ({ extractAndEncryptInterests: () => null }));
vi.mock('@/lib/ai/user-memory', () => ({
  loadUserMemory: vi.fn().mockResolvedValue(null),
  loadTripHistory: vi.fn().mockResolvedValue([]),
  extractMemoryFromMessage: () => ({}),
  buildMemoryContext: () => '',
  buildAgentInsightsForTourist: vi.fn().mockResolvedValue(''),
  upsertUserMemory: vi.fn(),
  synthesizeUserNotes: vi.fn(),
}));

const aiChatAgentLoopMock = vi.fn();
vi.mock('@/lib/kuzmich/core', () => ({
  aiChatAgentLoop: (...a: unknown[]) => aiChatAgentLoopMock(...a),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
}));

import { POST } from '@/app/api/ai/chat-stream/route';

function postReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/ai/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Прочитать весь SSE-стрим и распарсить события */
async function readSSE(res: Response): Promise<Array<{ type: string; content?: string; finalResponse?: string }>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(evt => evt.replace(/^data: /, ''))
    .filter(Boolean)
    .map(payload => JSON.parse(payload));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
  callAIWithModelDirectMock.mockResolvedValue('LEGACY_ANSWER');
});

describe('POST /api/ai/chat-stream — мозг Кузьмича', () => {
  it('турист → loop с KUZMICH_SYSTEM, ответ по словам, финал в end-событии', async () => {
    aiChatAgentLoopMock.mockResolvedValue('Мутновский сейчас в жёлтом статусе');

    const res = await POST(postReq({ message: 'Расскажи про Мутновский' }));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSSE(res);
    expect(events[0]).toMatchObject({ type: 'start' });
    const tokens = events.filter(e => e.type === 'token').map(e => e.content).join('');
    expect(tokens).toBe('Мутновский сейчас в жёлтом статусе');
    const end = events.find(e => e.type === 'end');
    expect(end?.finalResponse).toBe('Мутновский сейчас в жёлтом статусе');

    const [, systemContent, history] = aiChatAgentLoopMock.mock.calls[0] as [string, string, Array<{ role: string; content: string }>];
    expect(systemContent.startsWith('KUZMICH_PERSONA')).toBe(true);
    expect(history[history.length - 1]).toMatchObject({ role: 'user', content: 'Расскажи про Мутновский' });
    // Мозг ответил — OpenRouter-стрим и legacy one-shot не трогались
    expect(getOpenRouterKeyMock).not.toHaveBeenCalled();
    expect(callAIWithModelDirectMock).not.toHaveBeenCalled();
  });

  it('loop вернул null → фолбэк на legacy one-shot, SSE-контракт сохранён', async () => {
    aiChatAgentLoopMock.mockResolvedValue(null);

    const res = await POST(postReq({ message: 'Привет' }));
    const events = await readSSE(res);

    const end = events.find(e => e.type === 'end');
    expect(end?.finalResponse).toBe('LEGACY_ANSWER');
    expect(callAIWithModelDirectMock).toHaveBeenCalledTimes(1);
  });

  it('не-tourist роль (operator) → loop не вызывается, legacy как раньше', async () => {
    const res = await POST(postReq({ message: 'Привет', role: 'operator' }));
    const events = await readSSE(res);

    expect(aiChatAgentLoopMock).not.toHaveBeenCalled();
    const end = events.find(e => e.type === 'end');
    expect(end?.finalResponse).toBe('LEGACY_ANSWER');
  });
});
