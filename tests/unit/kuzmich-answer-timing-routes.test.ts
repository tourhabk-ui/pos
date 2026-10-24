/**
 * Замер ответа Кузьмича на сайте и в виджете партнёра (аудит 15.10, A19).
 *
 * Время ответа не записывалось нигде, и худший случай был оценкой. Сторож —
 * вызовом роутов с подменами: на каждом ответе в ai_actions_log
 * (kuzmich_answer) ложатся elapsed_ms и turns, путь и поверхность; ни текста,
 * ни ключа сессии (pd-guard). Часы подменены — elapsed_ms сверяется точно.
 *
 * Telegram и MAX — kuzmich-answer-timing-bots, цикл и потолок —
 * kuzmich-answer-ceiling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  poolQuery: vi.fn(),
  loop: vi.fn(),
  direct: vi.fn(),
  widgetModel: vi.fn(),
  sdk: vi.fn(),
  user: vi.fn(),
  intent: vi.fn(),
  clock: { now: 1_800_000_000_000 },
}));

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.poolQuery(...a) } }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
}));
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: (...a: unknown[]) => m.direct(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => m.widgetModel(...a),
  callVision: vi.fn(),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: (...a: unknown[]) => m.user(...a) }));
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
  detectTourIntent: () => m.intent(),
  findRelevantTours: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: vi.fn().mockResolvedValue(''),
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/agents/sdk/sdk-runner', () => ({ runSDKAgent: (...a: unknown[]) => m.sdk(...a) }));
vi.mock('@/lib/agents/sdk/tourist-tools', () => ({ getTouristTools: vi.fn(() => []) }));
vi.mock('@/lib/agents/sdk/operator-tools', () => ({ getOperatorTools: vi.fn() }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/kuzmich/core', () => ({
  aiChatAgentLoop: (...a: unknown[]) => m.loop(...a),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
  isAIErrorResponse: () => false,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>();
  return { ...orig, gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/safety/current-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/current-status')>()),
  getCurrentSafetyStatus: vi.fn().mockResolvedValue(null),
}));

import { POST as webPOST } from '@/app/api/ai/chat/route';
import { POST as widgetPOST } from '@/app/api/widget/chat/route';
import { KUZMICH_ANSWER_ACTION, CEILING_NOTHING_LINE, type AgentLoopTiming } from '@/lib/kuzmich/answer-ceiling';
import { RECORD_KUZMICH_ANSWER_SQL } from '@/lib/kuzmich/answer-timing';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';

function web(body: unknown) {
  return webPOST(new Request('http://localhost/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest);
}
function widget(body: unknown) {
  return widgetPOST(new NextRequest('http://localhost/api/widget/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

/** Все строки замера за вызов. */
function records(): Array<{ provider: unknown; meta: Record<string, unknown> }> {
  return m.poolQuery.mock.calls
    .filter((c) => c[0] === RECORD_KUZMICH_ANSWER_SQL)
    .map((c) => {
      const p = c[1] as unknown[];
      expect(p[0]).toBe(KUZMICH_ANSWER_ACTION);
      return { provider: p[1], meta: JSON.parse(String(p[2])) as Record<string, unknown> };
    });
}

/** Цикл Кузьмича «идёт» ms по подменённым часам и отмечает ходы. */
function loopTakes(ms: number, answer: string | null, t: Partial<AgentLoopTiming>) {
  m.loop.mockImplementation(async (
    _q: string, _s: string, _h: unknown[], _e: unknown[], _runs: unknown[],
    prov: { provider?: string } | undefined, timing: AgentLoopTiming | undefined,
  ) => {
    m.clock.now += ms;
    if (prov) prov.provider = 'deepseek';
    if (timing) Object.assign(timing, { elapsedMs: ms, ...t });
    return answer;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => m.clock.now);
  m.poolQuery.mockResolvedValue({ rows: [] });
  m.dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM partners/.test(sql)) {
      return params[0] === 'mestechko'
        ? { rows: [{ id: PARTNER_ID, name: 'Местечко Камчатка', category: 'operator', description: null, widget_domains: ['mestechkokam.ru'] }] }
        : { rows: [] };
    }
    return { rows: [] };
  });
  m.user.mockResolvedValue(null);
  m.intent.mockReturnValue({ detected: false, activityType: null, rawWords: [] });
  m.direct.mockResolvedValue('ЗАПАСНОЙ ОТВЕТ');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('веб-чат /api/ai/chat', () => {
  it('ответ цикла: elapsed_ms от начала ответа, turns и раунды из цикла, путь и провайдер', async () => {
    loopTakes(12_000, 'Авачинский спокоен.', { turns: 2, toolRounds: 1, ceilingHit: false });
    const res = await web({ message: 'Когда идти на Авачинский?', sessionId: 'web-s-1' });
    expect(res.status).toBe(200);

    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('deepseek');
    expect(rows[0]!.meta).toMatchObject({
      surface: 'web', elapsed_ms: 12_000, turns: 2, tool_rounds: 1, path: 'tools', ceiling_hit: false,
    });
    // Ни текста вопроса, ни ключа сессии в замере нет.
    const raw = JSON.stringify(m.poolQuery.mock.calls.filter((c) => c[0] === RECORD_KUZMICH_ANSWER_SQL));
    expect(raw).not.toContain('Авачинский');
    expect(raw).not.toContain('web-s-1');
  });

  it('цикл упёрся в потолок — отметка потолка записана, запасной одиночный вызов не делается', async () => {
    loopTakes(61_000, CEILING_NOTHING_LINE, { turns: 1, toolRounds: 0, ceilingHit: true });
    const res = await web({ message: 'Что с Авачинским?' });
    const body = await res.json() as { data: { answer: string } };
    expect(body.data.answer).toContain(CEILING_NOTHING_LINE);
    expect(m.direct).not.toHaveBeenCalled();
    expect(records()[0]!.meta).toMatchObject({ surface: 'web', path: 'tools', ceiling_hit: true, turns: 1 });
  });

  it('цикл не ответил — запасной одиночный вызов: путь single, ходы цикла записаны', async () => {
    m.loop.mockImplementation(async (...a: unknown[]) => {
      m.clock.now += 3_000;
      const timing = a[6] as AgentLoopTiming;
      Object.assign(timing, { turns: 1, toolRounds: 0, elapsedMs: 3_000 });
      return null;
    });
    m.direct.mockImplementation(async () => { m.clock.now += 2_000; return 'ЗАПАСНОЙ ОТВЕТ'; });
    await web({ message: 'Что взять в поход на вулкан?' });
    expect(records()[0]!.meta).toMatchObject({ surface: 'web', path: 'single', elapsed_ms: 5_000, turns: 1 });
    expect(records()[0]!.provider).toBeNull();
  });

  it('агент брони ходов не считает — turns null («не записано»), а не ноль', async () => {
    m.user.mockResolvedValue({ userId: 'u-1', role: 'tourist' });
    m.intent.mockReturnValue({ detected: true, activityType: 'volcano', rawWords: ['тур'] });
    m.sdk.mockImplementation(async () => { m.clock.now += 8_000; return { response: 'Нашёл тур.' }; });
    await web({ message: 'Хочу тур на вулкан 15 июля' });
    expect(m.loop).not.toHaveBeenCalled();
    expect(records()[0]!.meta).toMatchObject({ surface: 'web', path: 'sdk', elapsed_ms: 8_000, turns: null, tool_rounds: null });
  });

  it('не турист (гид) — это не ответ Кузьмича туристу, замер не пишется', async () => {
    await web({ message: 'Где маршрут на вулкан?', role: 'guide' });
    expect(records()).toHaveLength(0);
  });
});

describe('виджет партнёра /api/widget/chat', () => {
  it('один вызов модели: turns 1, путь single, elapsed_ms от вызова до готового ответа', async () => {
    m.widgetModel.mockImplementation(async () => { m.clock.now += 6_500; return 'Есть вертолётная экскурсия.'; });
    const res = await widget({ partnerId: 'mestechko', sessionId: 's1', message: 'Что есть на выходные?' });
    expect(res.status).toBe(200);
    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({
      surface: 'widget', elapsed_ms: 6_500, turns: 1, tool_rounds: 0, path: 'single', ceiling_hit: false,
    });
  });

  it('модель не ответила — замер всё равно пишется: ожидание было', async () => {
    m.widgetModel.mockImplementation(async () => { m.clock.now += 30_000; return null; });
    await widget({ partnerId: 'mestechko', sessionId: 's1', message: 'Есть туры?', lang: 'en' });
    expect(records()[0]!.meta).toMatchObject({ surface: 'widget', elapsed_ms: 30_000 });
  });
});
