/**
 * Предохранители анонимного чата Кузьмича (21.11, проверка по посту Reddit
 * «I checked my own vibe coded app»): длина сообщения, фото, история,
 * бесплатный лимит гостя по IP и жёсткий суточный стоп по тратам LLM.
 * Всё — до вызова модели. Сторож — вызовом POST /api/ai/chat; модели и база
 * подменены, судится ответ человеку и то, звалась ли модель.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
vi.mock('@/lib/database', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
let clientIp = '10.0.0.1';
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => clientIp,
}));
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn().mockResolvedValue('LEGACY_ANSWER'), callVision: vi.fn() }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: vi.fn().mockResolvedValue(null) }));
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
  detectTourIntent: () => ({ detected: false, activityType: null, rawWords: [] }),
  findRelevantTours: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue(''), buildGeoContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/agents/sdk/sdk-runner', () => ({ runSDKAgent: vi.fn().mockResolvedValue({ response: 'SDK_ANSWER' }) }));
vi.mock('@/lib/agents/sdk/tourist-tools', () => ({ getTouristTools: vi.fn(() => []) }));
vi.mock('@/lib/agents/sdk/operator-tools', () => ({ getOperatorTools: vi.fn() }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/kuzmich/core', async () => ({
  // Сборка данных хода — заглушкой: настоящую держит kuzmich-same-facts-all-surfaces.
  ...(await import('../helpers/kuzmich-turn-stub')).kuzmichTurnStub('KUZMICH_PERSONA'),
  aiChatAgentLoop: vi.fn().mockResolvedValue('MODEL_ANSWER: оставить заявку?'),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
  isAIErrorResponse: () => false,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/kuzmich/answer-timing', () => ({ recordKuzmichAnswer: vi.fn() }));
vi.mock('@/lib/kuzmich/chat-session-save', () => ({ saveChatSession: vi.fn().mockResolvedValue(undefined) }));

const TOUR = { id: 36, slug: 'mutnovsky', title: 'Мутновский вулкан', base_price: 9000 };
const pickMock = vi.fn();
vi.mock('@/lib/ai/chat-booking-tour', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-booking-tour')>()),
  pickChatBookingTour: (...a: unknown[]) => pickMock(...a),
}));
const runPublicToolMock = vi.fn();
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool: (...a: unknown[]) => runPublicToolMock(...a) }));


import { POST } from '@/app/api/ai/chat/route';
import { aiChatAgentLoop } from '@/lib/kuzmich/core';
import { callAIWithModelDirect } from '@/lib/ai/providers';
import {
  anonChatGuard, createAnonGuard, trimHistory, dailyBudgetUsd, anonDailyMax,
  MAX_MESSAGE_CHARS, MAX_IMAGE_BASE64_CHARS, MAX_HISTORY_ITEMS_USED, MAX_HISTORY_ITEM_CHARS, MAX_HISTORY_TOTAL_CHARS,
  ANON_PER_IP_DAILY, ANON_DAILY_STOP_TEXT, ANON_IP_LIMIT_TEXT, DEFAULT_DAILY_BUDGET_USD,
} from '@/lib/ai/anon-chat-guard';

let seq = 0;
function req(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: `guard-${++seq}`, ...body }),
  }) as unknown as NextRequest;
}
const modelCalls = () => vi.mocked(aiChatAgentLoop).mock.calls.length + vi.mocked(callAIWithModelDirect).mock.calls.length;

beforeEach(() => {
  anonChatGuard.reset();
  clientIp = '10.0.0.1';
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [{ spent: '0' }] });
  vi.mocked(aiChatAgentLoop).mockClear();
  vi.mocked(callAIWithModelDirect).mockClear();
  pickMock.mockReset();
  pickMock.mockResolvedValue({ tour: null, candidates: [] });
  vi.stubEnv('AI_DAILY_BUDGET_USD', '');
  vi.stubEnv('AI_ANON_DAILY_MAX', '');
});

describe('размеры входа — до модели', () => {
  it(`сообщение длиннее ${MAX_MESSAGE_CHARS} знаков — 400 со словами, модель не зовётся`, async () => {
    const res = await POST(req({ message: 'а'.repeat(MAX_MESSAGE_CHARS + 1) }));
    expect(res.status).toBe(400);
    const json = await res.json() as { error?: string };
    expect(json.error).toContain(String(MAX_MESSAGE_CHARS));
    expect(modelCalls()).toBe(0);
  });

  it('сообщение ровно на потолке — принимается', async () => {
    const res = await POST(req({ message: 'а'.repeat(MAX_MESSAGE_CHARS) }));
    expect(res.status).toBe(200);
  });

  it('фото больше ≈3 МБ (base64) — 400, модель не зовётся', async () => {
    const res = await POST(req({ message: 'что это?', imageBase64: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1), imageMimeType: 'image/jpeg' }));
    expect(res.status).toBe(400);
    expect(modelCalls()).toBe(0);
  });

  it('история-мусор (строка вчетверо длиннее потолка) — 400', async () => {
    const res = await POST(req({ message: 'привет', history: [{ role: 'user', content: 'б'.repeat(MAX_HISTORY_ITEM_CHARS * 4 + 1) }] }));
    expect(res.status).toBe(400);
  });

  it('sessionId длиннее 200 — 400', async () => {
    const res = await POST(req({ message: 'привет', sessionId: 'x'.repeat(201) }));
    expect(res.status).toBe(400);
  });
});

describe('trimHistory: в модель идёт короткий хвост истории', () => {
  it(`не больше ${MAX_HISTORY_ITEMS_USED} строк, каждая не длиннее ${MAX_HISTORY_ITEM_CHARS}, всего не больше ${MAX_HISTORY_TOTAL_CHARS}`, () => {
    const h = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `${i}:` + 'в'.repeat(5000) }));
    const t = trimHistory(h);
    expect(t.length).toBeLessThanOrEqual(MAX_HISTORY_ITEMS_USED);
    expect(t.every((m) => m.content.length <= MAX_HISTORY_ITEM_CHARS)).toBe(true);
    expect(t.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_TOTAL_CHARS);
    // хвост, а не голова
    expect(t[t.length - 1].content.startsWith('19:')).toBe(true);
  });

  it('пустая и короткая история — без изменений', () => {
    expect(trimHistory(undefined)).toEqual([]);
    const short = [{ role: 'user' as const, content: 'привет' }];
    expect(trimHistory(short)).toEqual(short);
  });
});

describe('бесплатный лимит гостя — ещё и по IP, не только по sessionId', () => {
  it(`после ${ANON_PER_IP_DAILY} сообщений с одного IP новые sessionId не помогают; другой IP — отвечает`, async () => {
    for (let i = 0; i < ANON_PER_IP_DAILY; i++) {
      const res = await POST(req({ message: 'какая погода на Авачинском?' }));
      const json = await res.json() as { data?: { limitReached?: boolean } };
      expect(json.data?.limitReached).not.toBe(true);
    }
    const before = modelCalls();
    const res = await POST(req({ message: 'ещё вопрос' }));
    const json = await res.json() as { data?: { limitReached?: boolean; message?: string; answer?: string } };
    expect(json.data?.limitReached).toBe(true);
    expect(json.data?.message).toBe(ANON_IP_LIMIT_TEXT);
    expect(json.data?.answer).toBe(ANON_IP_LIMIT_TEXT);
    expect(modelCalls()).toBe(before);

    clientIp = '10.0.0.2';
    const other = await POST(req({ message: 'а с другого адреса?' }));
    const oj = await other.json() as { data?: { limitReached?: boolean } };
    expect(oj.data?.limitReached).not.toBe(true);
  });
});

describe('жёсткий суточный стоп гостевых вызовов LLM', () => {
  it(`траты дня ≥ бюджета (по умолчанию $${DEFAULT_DAILY_BUDGET_USD}) — честный ответ без вызова модели`, async () => {
    poolQuery.mockResolvedValue({ rows: [{ spent: '5.01' }] });
    const res = await POST(req({ message: 'расскажи про Долину гейзеров' }));
    expect(res.status).toBe(200);
    const json = await res.json() as { data?: { answer?: string; dailyStop?: boolean } };
    expect(json.data?.dailyStop).toBe(true);
    expect(json.data?.answer).toBe(ANON_DAILY_STOP_TEXT);
    expect(modelCalls()).toBe(0);
  });

  it('текст стопа честный: про лимит расходов, без «база недоступна», и с 112', () => {
    expect(ANON_DAILY_STOP_TEXT).toMatch(/лимит расходов/);
    expect(ANON_DAILY_STOP_TEXT).toMatch(/112/);
    expect(ANON_DAILY_STOP_TEXT).not.toMatch(/недоступн|сбой|ошибк|технич/i);
  });

  it('бюджет берётся из AI_DAILY_BUDGET_USD', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '10');
    poolQuery.mockResolvedValue({ rows: [{ spent: '6' }] });
    const res = await POST(req({ message: 'привет' }));
    const json = await res.json() as { data?: { dailyStop?: boolean } };
    expect(json.data?.dailyStop).not.toBe(true);
  });

  it('вошедший пользователь стопом не останавливается', async () => {
    const { getUserFromRequest } = await import('@/lib/auth/jwt');
    vi.mocked(getUserFromRequest).mockResolvedValueOnce({ userId: 'u-1', role: 'tourist' } as never);
    poolQuery.mockResolvedValue({ rows: [{ spent: '99' }] });
    const res = await POST(req({ message: 'привет' }));
    const json = await res.json() as { data?: { dailyStop?: boolean } };
    expect(json.data?.dailyStop).not.toBe(true);
  });
});

describe('createAnonGuard — логика без роута', () => {
  it('стоп по тратам, кэш на минуту, новые сутки сбрасывают всё', async () => {
    let t = Date.UTC(2026, 10, 21, 10, 0);
    let spent = 4;
    const read = vi.fn(async () => spent);
    const g = createAnonGuard({ readSpendToday: read, now: () => t, budgetUsd: () => 5, dailyMax: () => 1000 });
    expect(await g.dailyStopped()).toBe(false);
    spent = 6;
    expect(await g.dailyStopped()).toBe(false); // кэш 60 с
    t += 61_000;
    expect(await g.dailyStopped()).toBe(true);
    t = Date.UTC(2026, 10, 22, 0, 1);
    spent = 0;
    expect(await g.dailyStopped()).toBe(false);
  });

  it('вторая линия: счётчик гостевых вызовов за сутки работает и без книги трат', async () => {
    const g = createAnonGuard({ readSpendToday: async () => { throw new Error('db down'); }, budgetUsd: () => 5, dailyMax: () => 3 });
    expect(await g.dailyStopped()).toBe(false);
    g.countAnonCall(); g.countAnonCall(); g.countAnonCall();
    expect(await g.dailyStopped()).toBe(true);
  });

  it('лимит IP — на сутки', () => {
    let t = Date.UTC(2026, 10, 21, 10, 0);
    const g = createAnonGuard({ readSpendToday: async () => 0, now: () => t, perIpDaily: 2 });
    expect(g.takeIpSlot('1.2.3.4')).toBe(true);
    expect(g.takeIpSlot('1.2.3.4')).toBe(true);
    expect(g.takeIpSlot('1.2.3.4')).toBe(false);
    expect(g.takeIpSlot('5.6.7.8')).toBe(true);
    t = Date.UTC(2026, 10, 22, 0, 1);
    expect(g.takeIpSlot('1.2.3.4')).toBe(true);
  });

  it('значения по умолчанию: бюджет $5, неверные env не ломают', () => {
    expect(dailyBudgetUsd(undefined)).toBe(5);
    expect(dailyBudgetUsd('abc')).toBe(5);
    expect(dailyBudgetUsd('7,5')).toBe(7.5);
    expect(anonDailyMax('0')).toBeGreaterThan(0);
  });
});
