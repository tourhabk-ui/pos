/**
 * После ответа на беду MAX не предлагает «Оформить заявку» (проверка
 * качества 24.10).
 *
 * Вебхук MAX вторым сообщением шлёт «Хотите оформить заявку?» с кнопками
 * брони, если в ответе Кузьмича есть «тур» или «маршрут»
 * (hasTourRecommendation). Ответ на беду называет маршрут почти всегда: совет
 * блока 112 при пропаже группы — «Сообщите МЧС маршрут, контрольное время…»,
 * а модель советует «вернитесь по маршруту». Кнопка брони вставала прямо под
 * тревогой.
 *
 * Сторож — вызов заверенного вебхука POST /api/max/kuzmich?s=<ключ> с
 * настоящим мозгом Кузьмича (lib/kuzmich/core) и настоящим детектором беды
 * (lib/safety/sos-detector). Подменены модель, база, транспорт MAX и проверка
 * «администратор ли это». Судится то, что ушло в чат.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { clearBoundChatEmergencies } from '@/lib/kuzmich/bound-chat-route';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  fallback: vi.fn(),
  orNull: vi.fn(),
  maxSend: vi.fn(),
  findAdmin: vi.fn(),
  /** Строка partners для привязанного чата; null — чат не привязан. */
  partnerRow: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => m.pool(...a),
    connect: async () => ({ query: (...a: unknown[]) => m.pool(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => m.fallback(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => m.orNull(...a),
  callAIFast: vi.fn().mockResolvedValue('нет'),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/route-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/route-knowledge')>()),
  searchRoutes: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telegram/operator-availability')>()),
  searchOperatorAvailability: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/planner/interests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner/interests')>()),
  findRoutesByInterests: vi.fn().mockResolvedValue([]),
}));
// Контроль выхода — не предмет этого сторожа.
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: vi.fn(async () => ({ success: true })) },
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn().mockResolvedValue({ delivered: true }) }));
vi.mock('@/lib/leads/create', () => ({ createLead: vi.fn().mockResolvedValue('lead-1') }));
vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: (...a: unknown[]) => m.maxSend(...a),
      sendMessageToUser: vi.fn().mockResolvedValue({}),
      answerOnCallback: vi.fn().mockResolvedValue({}),
      editMessage: vi.fn().mockResolvedValue({ success: true }),
    },
  }),
  maxFetch: vi.fn(),
}));
vi.mock('@/lib/max/admin-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: (...a: unknown[]) => m.findAdmin(...a),
}));

const max = await import('@/app/api/max/kuzmich/route');

const KEY = 'test-webhook-key-24-10-offer';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const CHAT = 9_124;
const SOS_LINE = 'Звоните 112';
const OFFER = 'Хотите оформить заявку?';
// Ответ модели называет маршрут — по нему вебхук предлагает бронь.
const ROUTE_ANSWER = 'Идите назад по маршруту к ручью и ждите там.';
// Ответ без «тур» и «маршрут»: «маршрут» приносит сам блок 112.
const PLAIN_ANSWER = 'ОТВЕТ МОЗГА КУЗЬМИЧА';

const GUIDE = {
  id: '33333333-3333-4333-8333-333333333333', slug: null, name: 'Вулкан-Тур',
  category: 'guide', user_id: 'u-guide', profile_status: 'approved',
};

const post = (body: unknown) => max.POST(new NextRequest(VERIFIED, { method: 'POST', body: JSON.stringify(body) }));

function message(text: string) {
  return {
    update_type: 'message_created',
    timestamp: Date.now(),
    message: {
      sender: { user_id: CHAT, name: 'Анна' },
      recipient: { chat_id: CHAT, chat_type: 'dialog' },
      body: { mid: 'mid-offer', seq: 1, text },
    },
  };
}

/** Тексты, ушедшие в чат, по порядку. */
function replies(): string[] {
  return m.maxSend.mock.calls.filter((c) => c[0] === CHAT).map((c) => String(c[1]));
}

/** Кнопки «Оформить заявку» в любом сообщении чата. */
function bookingButtons(): number {
  return m.maxSend.mock.calls
    .filter((c) => c[0] === CHAT)
    .filter((c) => JSON.stringify(c[2] ?? {}).includes('book_now'))
    .length;
}

beforeEach(() => {
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  m.partnerRow = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  // Наружу из теста ничего не ходит.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.maxSend.mockResolvedValue({});
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.db.mockResolvedValue({ rows: [] });
  m.pool.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('FROM partners') && q.includes('max_chat_id')) {
      return { rows: m.partnerRow ? [m.partnerRow] : [] };
    }
    return { rows: [] };
  });
  m.tools.mockResolvedValue({ content: ROUTE_ANSWER, tool_calls: null, provider: 'test' });
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
  m.orNull.mockResolvedValue('ОТВЕТ ПОМОЩНИКА БЕЗ ИНСТРУМЕНТОВ');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('беда в личном чате туриста (MAX, заверенный апдейт)', () => {
  it('ответ модели называет маршрут — одно сообщение с 112, заявку не предлагаем', async () => {
    await post(message('Помогите, мы заблудились'));

    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    expect(out[0]).toContain(ROUTE_ANSWER);
    expect(out).not.toContain(OFFER);
    expect(bookingButtons()).toBe(0);
  });

  it('«маршрут» приносит совет блока 112 при пропаже группы — заявку всё равно не предлагаем', async () => {
    m.tools.mockResolvedValue({ content: PLAIN_ANSWER, tool_calls: null, provider: 'test' });
    await post(message('Группа не вышла на связь к контрольному времени'));

    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    // Посылка сценария: слово, по которому вебхук предложил бы бронь, в ответе есть.
    expect(out[0]).toContain('маршрут');
    expect(out[0]).toContain(PLAIN_ANSWER);
    expect(out).not.toContain(OFFER);
    expect(bookingButtons()).toBe(0);
  });

  it('без беды ответ про маршрут — заявку предлагаем, как раньше', async () => {
    m.tools.mockResolvedValue({ content: 'Лучше всего в июле, маршрут от Авачинского перевала.', tool_calls: null, provider: 'test' });
    await post(message('Когда лучше идти на Авачинский вулкан?'));

    const out = replies();
    expect(out.join('\n')).not.toContain(SOS_LINE);
    expect(out).toContain(OFFER);
    expect(bookingButtons()).toBe(1);
  });
});

describe('беда из чата администратора и привязанного чата гида (MAX)', () => {
  it('администратор: «Помогите, мы заблудились» — 112 без «Хотите оформить заявку?»', async () => {
    m.findAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Анна' });
    await post(message('Помогите, мы заблудились'));

    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    expect(out).not.toContain(OFFER);
    expect(bookingButtons()).toBe(0);
  });

  it('гид в своём чате: «Помогите, мы заблудились» — 112 без «Хотите оформить заявку?»', async () => {
    m.partnerRow = GUIDE;
    await post(message('Помогите, мы заблудились'));

    const out = replies();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(SOS_LINE);
    expect(out[0]).toContain(ROUTE_ANSWER);
    expect(out).not.toContain(OFFER);
    expect(bookingButtons()).toBe(0);
  });
});
