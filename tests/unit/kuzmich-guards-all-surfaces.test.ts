/**
 * Один выход ответа Кузьмича на всех поверхностях (аудит 15.10, пункт 1.14).
 *
 * До 1.14 сторож выдуманного километража (#1883) стоял только в мессенджерах:
 * сайт, стрим, виджет и A2A отдавали «от Петропавловска около 400 км» без
 * единого числа в данных. Сторожа собирались каждой поверхностью сами, и
 * набор разошёлся. Теперь порядок задан один раз (lib/kuzmich/answer-guards):
 * расстояния → безопасность → доставка → блок 112.
 *
 * Сторож — вызовом каждой поверхности с одним и тем же ответом модели: что
 * получит человек (или агент). Модель подменена на уровне провайдера, цикл
 * инструментов и сторожа — настоящие. Реестр SURFACES обязан покрывать
 * каждое значение GuardSurface: новая поверхность без строки здесь — красная.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  dbQuery, toolsWaterfall, textWaterfall, directCall, grade, recordAnswer, recordReview, getUser,
} = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  toolsWaterfall: vi.fn(),
  textWaterfall: vi.fn(),
  directCall: vi.fn(),
  grade: vi.fn(),
  recordAnswer: vi.fn(),
  recordReview: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ query: dbQuery }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: dbQuery } }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: toolsWaterfall,
  callAIWaterfallOrNull: textWaterfall,
  callAIWithModelDirect: directCall,
}));
vi.mock('@/lib/ai/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider-config')>()),
  getOpenRouterKey: () => null,
}));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: vi.fn().mockResolvedValue(''),
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '203.0.113.7',
}));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: getUser }));
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
vi.mock('@/lib/ai/interest-extractor', () => ({ extractAndEncryptInterests: () => null }));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: recordReview }));
vi.mock('@/lib/kuzmich/answer-timing', () => ({ recordKuzmichAnswer: recordAnswer }));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: grade,
}));
vi.mock('@/lib/safety/current-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/current-status')>()),
  getCurrentSafetyStatus: vi.fn().mockResolvedValue({
    hasAlert: false, maxSeverity: 0, activeCount: 0, topTitle: null, topType: null,
    dataUpdatedAt: null, source: 'ленты МЧС', feedCount: 0, feedTitles: [], feedBasis: [], feedWhen: [], outsideFeed: null,
  }),
}));

import { POST as webChat } from '@/app/api/ai/chat/route';
import { POST as streamChat } from '@/app/api/ai/chat-stream/route';
import { POST as widgetChat } from '@/app/api/widget/chat/route';
import { answerAgentMessage } from '@/lib/a2a/chat';
import { aiChat } from '@/lib/kuzmich/core';
import { DISTANCE_HONEST_LINE } from '@/lib/kuzmich/distance-guard';
import { DELIVERY_HONEST_LINE } from '@/lib/kuzmich/delivery-claim-guard';
import { BANNED_ADVICE_NOTE } from '@/lib/kuzmich/banned-advice';
import type { GuardSurface } from '@/lib/kuzmich/answer-guards';

/** Ответ модели с тремя дефектами сразу: километраж без данных, «передал», опасный совет. */
const MODEL_ANSWER = [
  'Держитесь вместе и не спускайтесь в темноте.',
  'От Петропавловска до вулкана около 400 км по грунтовке.',
  'Если выйдет медведь — притворись мёртвым.',
  'Заявка передана оператору, он перезвонит.',
].join(' ');
/** Вопрос с признаком ЧП («заблудились») — сервер обязан поставить 112. */
const QUESTION = 'Мы заблудились у вулкана, далеко ли до Петропавловска?';
const SOS_HEAD = 'ЕСЛИ ЭТО ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ:';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';

function routeDb() {
  dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM partners/.test(sql) && params[0] === 'mestechko') {
      return { rows: [{ id: PARTNER_ID, name: 'Местечко Камчатка', category: 'operator', description: null, widget_domains: ['mestechkokam.ru'] }] };
    }
    return { rows: [] };
  });
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Склеенные токены SSE-стрима и финал из end-события. */
async function readStream(res: Response): Promise<{ tokens: string; final: string }> {
  const events = (await res.text())
    .split('\n\n')
    .map((e) => e.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((p) => JSON.parse(p) as { type: string; content?: string; finalResponse?: string });
  return {
    tokens: events.filter((e) => e.type === 'token').map((e) => e.content ?? '').join(''),
    final: events.find((e) => e.type === 'end')?.finalResponse ?? '',
  };
}

/** Поле ответа обязано быть: иначе проверка судила бы текст ошибки. */
function field(v: string | undefined, surface: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`${surface}: в ответе нет текста для человека`);
  return v;
}

/** Что человек (или агент) получил с каждой поверхности. */
const SURFACES: Record<GuardSurface, () => Promise<string>> = {
  telegram: async () => {
    const reply = vi.fn();
    await aiChat({ chatId: 101, text: QUESTION, mode: 'kuzmich', reply, platform: 'tg' });
    return field(reply.mock.calls.at(-1)?.[1] as string | undefined, 'telegram');
  },
  max: async () => {
    const reply = vi.fn();
    await aiChat({ chatId: 102, text: QUESTION, mode: 'kuzmich', reply, platform: 'max' });
    return field(reply.mock.calls.at(-1)?.[1] as string | undefined, 'max');
  },
  web: async () => {
    const res = await webChat(post('http://localhost/api/ai/chat', { message: QUESTION }));
    const json = await res.json() as { data?: { answer?: string } };
    return field(json.data?.answer, 'web');
  },
  'web-stream': async () => {
    const { tokens } = await readStream(await streamChat(post('http://localhost/api/ai/chat-stream', { message: QUESTION })));
    return field(tokens, 'web-stream');
  },
  widget: async () => {
    const res = await widgetChat(post('http://localhost/api/widget/chat', { partnerId: 'mestechko', sessionId: 's1', message: QUESTION }));
    const json = await res.json() as { data?: { answer?: string } };
    return field(json.data?.answer, 'widget');
  },
  a2a: async () => {
    const out = await answerAgentMessage(QUESTION, [], { conversationKey: null, self: true });
    return field(out.text, 'a2a');
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  routeDb();
  getUser.mockResolvedValue(null);
  toolsWaterfall.mockResolvedValue({ content: MODEL_ANSWER, provider: 'test' });
  textWaterfall.mockResolvedValue(MODEL_ANSWER);
  directCall.mockResolvedValue(MODEL_ANSWER);
  // Погода и прочие внешние вызовы в этом стороже не нужны: сеть — отказ.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тесте закрыта')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('один выход ответа: каждая поверхность отдаёт ответ после тех же сторожей', () => {
  for (const [surface, ask] of Object.entries(SURFACES) as [GuardSurface, () => Promise<string>][]) {
    it(`${surface}: километраж без данных, «притворись мёртвым» и «передал» не уходят; 112 — уходит`, async () => {
      const text = await ask();
      expect(text).not.toMatch(/400 км/);
      expect(text).toContain(DISTANCE_HONEST_LINE);
      expect(text).not.toMatch(/притворись мёртвым/);
      expect(text).toContain(BANNED_ADVICE_NOTE);
      expect(text).not.toMatch(/Заявка передана оператору/);
      expect(text).toContain(DELIVERY_HONEST_LINE);
      expect(text).toContain('Держитесь вместе');
      // Блок 112 стоит ПЕРЕД ответом модели: в ЧП его читают первым.
      expect(text.indexOf(SOS_HEAD)).toBeGreaterThan(-1);
      expect(text.indexOf(SOS_HEAD)).toBeLessThan(text.indexOf('Держитесь вместе'));
    });
  }
});

describe('журнал проверок безопасности знает поверхность', () => {
  it('каждая поверхность пишет разбор своим именем, а не «other»', async () => {
    for (const [surface, ask] of Object.entries(SURFACES) as [GuardSurface, () => Promise<string>][]) {
      recordReview.mockClear();
      await ask();
      const surfaces = recordReview.mock.calls.map((c) => c[0]);
      expect(surfaces, surface).toContain(surface);
      expect(surfaces, surface).not.toContain('other');
    }
  });
});

describe('стрим: текст, уже ушедший по словам, поправляется хвостом', () => {
  it('цикл не ответил, запасной ответ ушёл как есть — поправки идут после него, 112 — первым', async () => {
    toolsWaterfall.mockResolvedValue(null);
    const { tokens, final } = await readStream(await streamChat(post('http://localhost/api/ai/chat-stream', { message: QUESTION })));
    expect(tokens.startsWith(SOS_HEAD)).toBe(true);
    // Сказанное не вырезать — но поправка обязана идти следом за ним.
    const said = tokens.indexOf('400 км');
    expect(said).toBeGreaterThan(-1);
    expect(tokens.indexOf(DISTANCE_HONEST_LINE)).toBeGreaterThan(said);
    expect(tokens.indexOf('Поправка к сказанному выше: притворяться мёртвым нельзя')).toBeGreaterThan(tokens.indexOf('притворись мёртвым'));
    expect(tokens).toContain(DELIVERY_HONEST_LINE);
    expect(final).toBe(tokens);
  });
});
