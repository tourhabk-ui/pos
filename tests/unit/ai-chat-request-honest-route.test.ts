/**
 * Веб-чат Кузьмича: «Заявка создана» — только когда она создана (#2967).
 *
 * До 03.11 роут не был покрыт вовсе: оба пути заявки (быстрый — без модели,
 * и второй — после ответа модели) писали человеку «Заявка создана» на любой
 * `kind: 'ok'`, хотя исполнитель отвечает отказ текстом. А отказ быстрого
 * пути превращался во вторую заявку менеджеру по слову «соглас».
 *
 * Сторож — вызовом POST /api/ai/chat; подменены исполнитель MCP, выбор тура и
 * всё, что ходит в базу и модели. Судится то, что видит человек, и сколько
 * раз роут звал запись.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
vi.mock('@/lib/database', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
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

function postReq(message: string): NextRequest {
  return new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: 'honest-1' }),
  }) as unknown as NextRequest;
}
async function answerOf(message: string): Promise<string> {
  const res = await POST(postReq(message));
  const json = await res.json() as { data?: { answer?: string } };
  return json.data?.answer ?? '';
}
/**
 * Заявка с 15.11 уходит в два хода (#3399, п. 4): реплика с данными — сводка
 * без записи, «да» на неё — запись. Здесь судится исход записи после «да».
 */
async function confirmed(message: string): Promise<string> {
  const summary = await answerOf(message);
  expect(summary).toMatch(/^Проверьте заявку — она ещё не отправлена/);
  expect(runPublicToolMock).not.toHaveBeenCalled();
  return answerOf('да');
}

const NO_SEATS = 'На 2099-11-09 у тура "Мутновский вулкан" нет свободных мест — заявка не создана. Ближайшие даты с местами: 2099-11-12 (4 мест).';
const BOOKED = 'Заявка оператору принята: "Мутновский вулкан", 2099-11-09. Это заявка, не оплата. Ключ статуса заявки: k1 — по нему get_request_status покажет. Человеку дайте ссылку https://vedarai.ru/request-status#k1. Ключ и ссылку не публикуйте.';
const FULL = 'Хочу на Мутновский 09.11.2099, нас 2 человека, меня зовут Иван, +79991234567, согласен';

beforeEach(() => {
  pickMock.mockReset();
  pickMock.mockResolvedValue({ tour: TOUR, candidates: [TOUR] });
  runPublicToolMock.mockReset();
});

describe('POST /api/ai/chat — исход заявки человеку', () => {
  it('быстрый путь: отказ текстом — «Заявка не создана: …», второй заявки нет', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: NO_SEATS, handoffUrl: null });
    const a = await confirmed(FULL);
    expect(a).toMatch(/^Заявка не создана: На 2099-11-09 у тура "Мутновский вулкан" нет свободных мест/);
    expect(a).not.toMatch(/Заявка создана|Оператор свяжется/);
    expect(runPublicToolMock).toHaveBeenCalledTimes(1);
  });

  it('быстрый путь: успех — «Заявка создана» и тур назван', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    const a = await confirmed(FULL);
    expect(a).toMatch(/^Заявка создана\./);
    expect(a).toContain('Тур в заявке: «Мутновский вулкан»');
    expect(runPublicToolMock).toHaveBeenCalledTimes(1);
    expect(runPublicToolMock.mock.calls[0]![0]).toMatchObject({ toolName: 'create_booking_request', rawArguments: { participants: 2, date: '2099-11-09' } });
    // Согласие дал человек в нашем веб-чате, а не агент (06.11): канал чата.
    expect(runPublicToolMock.mock.calls[0]![0]).toMatchObject({ consentFrom: { source: 'kuzmich-web' } });
  });

  it('быстрый путь: исполнитель упал после начала записи — «не могу подтвердить», без повтора', async () => {
    runPublicToolMock.mockImplementation(async () => { throw new Error('pool'); });
    const a = await confirmed(FULL);
    expect(a).toMatch(/^Не могу подтвердить, что заявка записалась/);
    expect(runPublicToolMock).toHaveBeenCalledTimes(1);
  });

  it('второй путь (выбор тура в быстром упал до записи): отказ — «не создана»', async () => {
    pickMock.mockRejectedValueOnce(new Error('tours down'));
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: NO_SEATS, handoffUrl: null });
    const a = await confirmed(`Оформи: ${FULL}`);
    expect(a).toMatch(/^Заявка не создана: На 2099-11-09/);
    expect(a).not.toMatch(/Заявка создана/);
    expect(runPublicToolMock).toHaveBeenCalledTimes(1);
  });

  it('второй путь: refused — «не создана» с причиной', async () => {
    pickMock.mockRejectedValueOnce(new Error('tours down'));
    runPublicToolMock.mockResolvedValue({ kind: 'refused', text: 'Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.' });
    const a = await confirmed(`Оформи: ${FULL}`);
    expect(a).toMatch(/^Заявка не создана: Телефон не похож на номер/);
  });

  it('сводка до отправки: тур, цена из базы и какие данные уйдут оператору', async () => {
    const summary = await answerOf(FULL);
    expect(summary).toContain('Тур: «Мутновский вулкан»');
    expect(summary).toContain('цена в каталоге 9');
    expect(summary).toContain('Дата: 2099-11-09. Человек: 2.');
    expect(summary).toContain('Оператору тура уйдут имя и телефон из вашего сообщения.');
    // Самих ПД в сводке нет: она ложится в историю репликой ассистента и
    // уходит в модель следующим ходом (ревью безопасности #3407).
    expect(summary).not.toContain('Иван');
    expect(summary).not.toContain('1234567');
    expect(runPublicToolMock).not.toHaveBeenCalled();
  });

  it('«нет» на сводку — заявка не уходит, и следующее «да» её не воскрешает', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    await answerOf(FULL);
    expect(await answerOf('нет')).toMatch(/^Не отправил/);
    await answerOf('да');
    expect(runPublicToolMock).not.toHaveBeenCalled();
  });

  it('одно «да» — одна отправка', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    await confirmed(FULL);
    await answerOf('да');
    expect(runPublicToolMock).toHaveBeenCalledTimes(1);
  });

  it('вопрос вместо ответа снимает сводку: «да» после него не отправляет', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    await answerOf(FULL);
    await answerOf('да, а сколько стоит?');
    await answerOf('да');
    expect(runPublicToolMock).not.toHaveBeenCalled();
  });

  it('«не согласен» — записи нет ни одним путём', async () => {
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    const a = await answerOf('Оформи Мутновский 09.11.2099, нас 2 человека, меня зовут Иван, +79991234567, не согласен');
    expect(runPublicToolMock).not.toHaveBeenCalled();
    expect(a).not.toMatch(/Заявка создана/);
  });

  it('прошедшая дата — переспрос, записи нет', async () => {
    const a = await answerOf('Мутновский 15.11.2024, нас 2 человека, меня зовут Иван, +79991234567, согласен');
    expect(runPublicToolMock).not.toHaveBeenCalled();
    expect(a).toMatch(/^Дата 15\.11\.2024 уже прошла/);
  });
});
