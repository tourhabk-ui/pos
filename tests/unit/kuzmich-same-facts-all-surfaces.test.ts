/**
 * Одни данные хода у Кузьмича на всех поверхностях (слово владельца 15.11
 * «на сайте и в тг разные ответы»).
 *
 * На «сколько ехать до Паратунки и открыты ли там источники?» Telegram
 * ответил «60 км по автодороге» по справке с источником, сайт — «примерно в
 * 70 км» из своего поиска маршрутов и списком туров с ценами. Каждая
 * поверхность собирала данные хода сама: у сайта, стрима и A2A не было справок
 * дороги и сезонов, каталога, наличия, погоды зоны и законов, у сайта — ещё и
 * сводки МЧС в инструкции цикла. Пока «Паратунка 60 км» стояла прямо в
 * KUZMICH_SYSTEM, расхождение было не видно; #3393 убрал её оттуда.
 *
 * Сторож — вызовом каждой поверхности с одним вопросом (модель подменена на
 * уровне провайдера, сборка данных и сторожа ответа — настоящие):
 *  - модель получила те же данные хода, что дала бы kuzmichTurnFacts;
 *  - свой поиск маршрутов с турами (buildRAGContext) в инструкцию туриста не
 *    подмешан;
 *  - число из справки («60 км») доходит до человека, число по памяти
 *    («25–30 км») — нет, на каждой поверхности одинаково.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { dbQuery, toolsWaterfall, textWaterfall, directCall, getUser, ragContext } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  toolsWaterfall: vi.fn(),
  textWaterfall: vi.fn(),
  directCall: vi.fn(),
  getUser: vi.fn(),
  ragContext: vi.fn(),
}));

const RAG_PROBE = 'КОНТЕКСТ ПЛАТФОРМЫ — ПРОБА СВОЕГО ПОИСКА';
const MCHS_PROBE = 'СВОДКА МЧС — ПРОБА: штормовое предупреждение по югу края';

vi.mock('@/lib/database', () => ({ query: dbQuery }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: dbQuery } }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: toolsWaterfall,
  callAIWaterfallOrNull: textWaterfall,
  callAIWaterfallDetailed: vi.fn(async () => ({ text: '', provider: null })),
  callAIWithModelDirect: directCall,
}));
vi.mock('@/lib/ai/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider-config')>()),
  getOpenRouterKey: () => null,
}));
vi.mock('@/lib/ai/rag-context', () => ({
  buildRAGContext: ragContext,
  buildGeoContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/safety/active-warnings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/active-warnings')>()),
  mchsPromptBlock: vi.fn(async () => MCHS_PROBE),
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
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/kuzmich/answer-timing', () => ({ recordKuzmichAnswer: vi.fn() }));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn(),
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
import { answerAgentMessage } from '@/lib/a2a/chat';
import { aiChat, askKuzmichForEval, kuzmichTurnFacts } from '@/lib/kuzmich/core';
import { DISTANCE_HONEST_LINE, TRAVEL_TIME_HONEST_LINE } from '@/lib/kuzmich/distance-guard';

// «на 3 дня» — чтобы ход получил часть промпта по ситуации (#3399, п. 5) и
// сторож судил и её, а не только данные.
const QUESTION = 'Сколько ехать до Паратунки, мы на 3 дня, и открыты ли там источники?';
const ROAD_LINE = '- Паратунка: расстояние: 60 км по автодороге';

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function streamText(res: Response): Promise<string> {
  return (await res.text())
    .split('\n\n')
    .map((e) => e.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((p) => JSON.parse(p) as { type: string; content?: string })
    .filter((e) => e.type === 'token')
    .map((e) => e.content ?? '')
    .join('');
}

/** Поверхность туриста: что ушло человеку (или агенту). */
const SURFACES: Record<string, () => Promise<string>> = {
  telegram: async () => {
    const reply = vi.fn();
    await aiChat({ chatId: 201, text: QUESTION, mode: 'kuzmich', reply, platform: 'tg' });
    return String(reply.mock.calls.at(-1)?.[1] ?? '');
  },
  max: async () => {
    const reply = vi.fn();
    await aiChat({ chatId: 202, text: QUESTION, mode: 'kuzmich', reply, platform: 'max' });
    return String(reply.mock.calls.at(-1)?.[1] ?? '');
  },
  web: async () => {
    const json = await (await webChat(post('http://localhost/api/ai/chat', { message: QUESTION }))).json() as { data?: { answer?: string } };
    return json.data?.answer ?? '';
  },
  'web-stream': async () => streamText(await streamChat(post('http://localhost/api/ai/chat-stream', { message: QUESTION }))),
  a2a: async () => (await answerAgentMessage(QUESTION, [], { conversationKey: null, self: true })).text,
  eval: async () => (await askKuzmichForEval(QUESTION))?.answer ?? '',
};

/** Инструкция, с которой модель получила вопрос (первый ход цикла). */
function systemSeen(): string {
  const messages = toolsWaterfall.mock.calls[0]?.[0] as Array<{ role: string; content: string }> | undefined;
  if (!messages) throw new Error('цикл инструментов не вызывался');
  return messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbQuery.mockResolvedValue({ rows: [] });
  getUser.mockResolvedValue(null);
  ragContext.mockResolvedValue(RAG_PROBE);
  toolsWaterfall.mockResolvedValue({ content: 'До Паратунки 60 км по автодороге от Петропавловска-Камчатского.', provider: 'test' });
  textWaterfall.mockResolvedValue('До Паратунки 60 км по автодороге от Петропавловска-Камчатского.');
  directCall.mockResolvedValue('До Паратунки 60 км по автодороге от Петропавловска-Камчатского.');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тесте закрыта')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('данные хода: модель получает одно и то же на каждой поверхности', () => {
  it.each(Object.keys(SURFACES))('%s: справка дороги, сводка МЧС, каталог и данные по вопросу — те же, что у kuzmichTurnFacts', async (surface) => {
    await SURFACES[surface]!();
    const system = systemSeen();
    const turn = await kuzmichTurnFacts(QUESTION);
    expect(turn.facts).toContain(ROAD_LINE);
    expect(system).toContain(ROAD_LINE);
    expect(system).toContain(turn.facts);
    expect(system).toContain(MCHS_PROBE);
    expect(system).toContain(turn.tourContext);
    // Части промпта по ситуации — те же, что выбрал kuzmichTurnFacts (ревью #3416).
    expect(turn.modules).toBeTruthy();
    expect(system).toContain(turn.modules);
  });

  it.each(Object.keys(SURFACES))('%s: свой поиск маршрутов с турами в инструкцию туриста не подмешан', async (surface) => {
    await SURFACES[surface]!();
    expect(systemSeen()).not.toContain(RAG_PROBE);
  });
});

describe('ответ: число из справки доходит, число по памяти — нет, везде одинаково', () => {
  it.each(Object.keys(SURFACES))('%s: «60 км по автодороге» из справки остаётся в ответе', async (surface) => {
    // Сторож километров судит фразу с городом — так, как её пишет модель.
    const text = await SURFACES[surface]!();
    expect(text).toContain('60 км по автодороге');
    expect(text).not.toContain(DISTANCE_HONEST_LINE);
  });

  it.each(Object.keys(SURFACES))('%s: «25–30 км, 30–40 минут» по памяти вырезаны и названы', async (surface) => {
    // Ответ кабинета в MAX 15.11 слово в слово по числам.
    toolsWaterfall.mockResolvedValue({ content: 'До Паратунки примерно 25–30 км, в пути 30–40 минут.', provider: 'test' });
    const text = await SURFACES[surface]!();
    expect(text).not.toMatch(/25–30 км|30–40 минут/);
    expect(text).toContain(TRAVEL_TIME_HONEST_LINE);
  });

  it.each(Object.keys(SURFACES))('%s: «примерно в 70 км» без справки вырезан и назван', async (surface) => {
    // Ответ сайта 15.11: «примерно в 70 км от Петропавловска-Камчатского».
    toolsWaterfall.mockResolvedValue({ content: 'Паратунка примерно в 70 км от Петропавловска-Камчатского.', provider: 'test' });
    const text = await SURFACES[surface]!();
    expect(text).not.toMatch(/70 км/);
    expect(text).toContain(DISTANCE_HONEST_LINE);
  });
});
