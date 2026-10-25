/**
 * Заявка, начатая у Кузьмича туриста в привязанном чате или чате
 * администратора, доводится им же (проверка качества 24.10, #2756).
 *
 * До правки «хочу забронировать тур» уходило Кузьмичу туриста, он спрашивал
 * «Как вас зовут?», а ответ «Иван Петров» классификатор относил к кабинету:
 * администратор получал «Не понял команду», оператор — ответ помощника CRM, и
 * черновик полчаса висел, съедая следующее сообщение туриста. Здесь черновик
 * лежит в tg_booking_flow (как после перезапуска), и следующее сообщение
 * судится по тому, кто ответил: шаг заявки, консоль, помощник или поток дат.
 *
 * Отдельно — вопрос прокатчика о своих машинах («какой джип свободен
 * 30 октября») остаётся кабинету, а кнопка «Оформить заявку» не встаёт под
 * ответом с блоком 112.
 *
 * Вызов настоящих роутов с настоящими классификатором, детектором беды,
 * кабинетами и мозгом Кузьмича; подменены база, модели и транспорт.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { clearBoundChatEmergencies } from '@/lib/kuzmich/bound-chat-route';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  orNull: vi.fn(),
  fallback: vi.fn(),
  direct: vi.fn(),
  tgSend: vi.fn(),
  maxSend: vi.fn(),
  findMaxAdmin: vi.fn(),
  findTelegramAdmin: vi.fn(),
  fetch: vi.fn(),
  /** Строки tg_booking_flow: ключ «чат:режим». */
  flows: new Map<string, unknown>(),
  /** Строки tg_conversations — по возрастанию времени. */
  history: [] as Array<{ chat: unknown; mode: unknown; role: string; content: string }>,
  /** Строка partners привязанного чата; null — чат не привязан. */
  partner: null as null | Record<string, unknown>,
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
  callAIWaterfallOrNull: (...a: unknown[]) => m.orNull(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => m.fallback(...a),
  callAIWithModelDirect: (...a: unknown[]) => m.direct(...a),
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

// ── Транспорт и соседи роутов ──────────────────────────────────────────────
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn() },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'kuzmichai_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn().mockResolvedValue({ delivered: true }) }));
vi.mock('@/lib/leads/create', () => ({ createLead: vi.fn().mockResolvedValue('lead-1') }));
vi.mock('@/lib/support/ticket.service', () => ({
  createTicket: vi.fn().mockResolvedValue({ id: 'ticket-0001-abcd', category: 'other' }),
  getUserOpenTickets: vi.fn().mockResolvedValue([]),
  addTicketMessage: vi.fn(),
}));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/agents', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/agents/intent-classifier', () => ({ classifyIntentByKeywords: () => 'unknown' }));
vi.mock('@/lib/platform-settings', () => ({ getSetting: vi.fn(async () => null) }));
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
  findMaxAdmin: (...a: unknown[]) => m.findMaxAdmin(...a),
}));
vi.mock('@/lib/telegram/admin-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telegram/admin-link')>()),
  findTelegramAdmin: (...a: unknown[]) => m.findTelegramAdmin(...a),
}));

const telegram = await import('@/app/api/telegram/webhook/route');
const kuzmichTg = await import('@/app/api/telegram/kuzmich/route');
const max = await import('@/app/api/max/kuzmich/route');

const CABINET_ANSWER = 'ОТВЕТ ПОМОЩНИКА КАБИНЕТА';
const TOURIST_ANSWER = 'ОТВЕТ МОЗГА КУЗЬМИЧА';
/** Шаг «имя» принят — бот спрашивает дату (lib/kuzmich/core, шаг name). */
const NAME_TAKEN = 'Отлично, Иван Петров! На какую дату оставляем заявку?';
const NOT_UNDERSTOOD = 'Не понял команду';
/** callback_data кнопки «Хочу оставить заявку» (sendBookingInlineButton). */
const BOOKING_BUTTON = 'book_now';

// Черновик живёт и в памяти роута (pending): у каждого теста свой чат, иначе
// шаг, сдвинутый одним тестом, отвечал бы в следующем.
let TG_CHAT = 0;
let MAX_CHAT = 0;
let nextChat = 51_000;
const MAX_KEY = 'test-webhook-key-25-10-live-booking';

const OPERATOR = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'vulkan-tur', name: 'Вулкан-Тур',
  category: 'operator', user_id: 'u-operator', profile_status: 'approved',
};
const LAGUNA = {
  id: '22222222-2222-4222-8222-222222222222', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  category: 'transfer', user_id: null, profile_status: null,
};
const TOUR = { id: 5, title: 'Рыбалка на Быстрой', base_price: 15000, operator_id: 'op-1' };

let nextUpdateId = 26_100;

function kuzmichPost(text: string, chat: number = TG_CHAT): Promise<Response> {
  return kuzmichTg.POST(new NextRequest('http://localhost/api/telegram/kuzmich', {
    method: 'POST',
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: { message_id: 1, from: { id: chat, first_name: 'Иван' }, chat: { id: chat, type: 'private' }, text },
    }),
  }));
}

/** Живой вход Telegram (/api/telegram/webhook). */
function tgPost(text: string): Promise<Response> {
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: { message_id: 1, from: { id: TG_CHAT, first_name: 'Иван' }, chat: { id: TG_CHAT, type: 'private' }, text },
    }),
  }));
}

function tgSent(): string[] {
  return m.tgSend.mock.calls.map((c) => String((c[0] as { text?: string }).text ?? ''));
}

function maxPost(text: string): Promise<Response> {
  return max.POST(new NextRequest(`http://localhost/api/max/kuzmich?s=${MAX_KEY}`, {
    method: 'POST',
    body: JSON.stringify({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: MAX_CHAT, name: 'Иван' },
        recipient: { chat_id: MAX_CHAT, chat_type: 'dialog' },
        body: { mid: `mid-${nextUpdateId++}`, seq: 1, text },
      },
    }),
  }));
}

/** Тела sendMessage к Bot API со второго входа Telegram. */
function kuzmichSent(): Array<{ text: string; markup: string }> {
  return m.fetch.mock.calls
    .filter(([url]) => String(url).includes('/sendMessage'))
    .map(([, init]) => {
      const b = JSON.parse(String((init as RequestInit).body)) as { text?: string; reply_markup?: unknown };
      return { text: String(b.text ?? ''), markup: JSON.stringify(b.reply_markup ?? null) };
    });
}

function maxSent(): string[] {
  return m.maxSend.mock.calls.filter((c) => c[0] === MAX_CHAT).map((c) => String(c[1]));
}

function toolNames(): string[] {
  return m.tools.mock.calls
    .flatMap((c) => (c[1] ?? []) as Array<{ function?: { name?: string } }>)
    .map((t) => String(t.function?.name));
}

function sqlTouched(fragment: string): boolean {
  return m.pool.mock.calls.some((c) => String(c[0]).includes(fragment));
}

/** Черновик на шаге «имя», как его пишет saveBookingFlow. */
function seedNameStep(chat: number, mode: string): void {
  m.flows.set(`${chat}:${mode}`, { step: 'name', started_at: Date.now() - 60_000, tour: TOUR });
}

function flowStep(chat: number, mode: string): string | null {
  const f = m.flows.get(`${chat}:${mode}`) as { step?: string } | undefined;
  return f?.step ?? null;
}

beforeEach(() => {
  TG_CHAT = nextChat++;
  MAX_CHAT = nextChat++;
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  m.history = [];
  m.partner = null;
  m.flows.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '777');
  vi.stubEnv('TELEGRAM_OWNER_ID', '1');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', MAX_KEY);
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  m.fetch.mockImplementation(async (url: unknown) => {
    if (String(url).includes('/sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
    throw new Error('сеть в тестах закрыта');
  });
  vi.stubGlobal('fetch', m.fetch);
  m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('FROM tg_booking_flow') && q.includes('SELECT state')) {
      const f = m.flows.get(`${String(params?.[0])}:${String(params?.[1])}`);
      return { rows: f ? [{ state: JSON.parse(JSON.stringify(f)) }] : [] };
    }
    if (q.includes('INSERT INTO tg_booking_flow')) {
      m.flows.set(`${String(params?.[0])}:${String(params?.[1])}`, JSON.parse(String(params?.[2])));
      return { rows: [] };
    }
    if (q.includes('DELETE FROM tg_booking_flow')) {
      m.flows.delete(`${String(params?.[0])}:${String(params?.[1])}`);
      return { rows: [] };
    }
    if (q.includes('INSERT INTO tg_conversations')) {
      m.history.push({ chat: params?.[0], mode: params?.[1], role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
      return { rows: [] };
    }
    if (q.includes('FROM partners') && q.includes('telegram_chat_id = $1')) {
      return { rows: m.partner && params?.[0] === TG_CHAT ? [m.partner] : [] };
    }
    if (q.includes('FROM partners') && q.includes('max_chat_id')) {
      return { rows: m.partner && Number(params?.[0]) === MAX_CHAT ? [m.partner] : [] };
    }
    return { rows: [] };
  });
  m.db.mockResolvedValue({ rows: [] });
  m.tgSend.mockResolvedValue({ success: true });
  m.maxSend.mockResolvedValue({});
  m.findMaxAdmin.mockResolvedValue({ outcome: 'none' });
  m.findTelegramAdmin.mockResolvedValue({ outcome: 'none' });
  m.tools.mockImplementation(async (_msgs: unknown, tools?: Array<{ function?: { name?: string } }>) => {
    const crm = (tools ?? []).some((t) => String(t.function?.name).startsWith('crm_'));
    return { content: crm ? CABINET_ANSWER : TOURIST_ANSWER, tool_calls: null, provider: 'test' };
  });
  m.orNull.mockResolvedValue(null);
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Telegram /api/telegram/kuzmich: живая заявка доводится Кузьмичом туриста', () => {
  it('привязанный оператор: «Иван Петров» на шаге «имя» — бот спрашивает дату, помощник CRM не зовётся', async () => {
    m.partner = OPERATOR;
    seedNameStep(TG_CHAT, 'tourist');
    await kuzmichPost('Иван Петров');

    const out = kuzmichSent().map((s) => s.text);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(NAME_TAKEN);
    expect(toolNames().some((n) => n.startsWith('crm_'))).toBe(false);
    expect(flowStep(TG_CHAT, 'tourist')).toBe('date');
  });

  it('без черновика «Иван Петров» у оператора — по-прежнему кабинет', async () => {
    m.partner = OPERATOR;
    await kuzmichPost('Иван Петров');

    const out = kuzmichSent().map((s) => s.text);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CABINET_ANSWER);
  });

  it('привязанный администратор: «Иван Петров» на шаге «имя» — шаг заявки, а не «Не понял команду»', async () => {
    m.findTelegramAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Админ' });
    seedNameStep(TG_CHAT, 'tourist');
    await kuzmichPost('Иван Петров');

    const out = kuzmichSent().map((s) => s.text);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(NAME_TAKEN);
    expect(out[0]).not.toContain(NOT_UNDERSTOOD);
  });

  it('администратор без черновика — консоль, как раньше', async () => {
    m.findTelegramAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Админ' });
    await kuzmichPost('Иван Петров');

    const out = kuzmichSent().map((s) => s.text);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(NOT_UNDERSTOOD);
  });

  it('туристу без привязки черновик не спрашивается дважды до мозга: консоль администратора базу брони не трогает', async () => {
    await kuzmichPost('Какая погода на Авачинском?');
    // Черновик читает только processMessage — один раз; консоль его не спрашивает.
    const reads = m.pool.mock.calls.filter((c) => String(c[0]).includes('FROM tg_booking_flow')).length;
    expect(reads).toBe(1);
  });
});

describe('MAX: живая заявка доводится Кузьмичом туриста', () => {
  it('администратор: «Иван Петров» на шаге «имя» — шаг заявки, а не «Не понял команду»', async () => {
    m.findMaxAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Админ' });
    seedNameStep(MAX_CHAT, 'max');
    await maxPost('Иван Петров');

    const out = maxSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(NAME_TAKEN);
    expect(out[0]).not.toContain(NOT_UNDERSTOOD);
    expect(flowStep(MAX_CHAT, 'max')).toBe('date');
  });

  it('администратор без черновика — консоль, как раньше', async () => {
    m.findMaxAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Админ' });
    await maxPost('Иван Петров');

    const out = maxSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(NOT_UNDERSTOOD);
  });

  it('привязанный оператор: «Иван Петров» на шаге «имя» — шаг заявки, помощник CRM не зовётся', async () => {
    m.partner = OPERATOR;
    seedNameStep(MAX_CHAT, 'max');
    await maxPost('Иван Петров');

    const out = maxSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(NAME_TAKEN);
    expect(toolNames().some((n) => n.startsWith('crm_'))).toBe(false);
  });

  it('привязанный оператор: дата заявки на шаге «дата» не уходит в поток открытия дат', async () => {
    m.partner = OPERATOR;
    m.flows.set(`${MAX_CHAT}:max`, { step: 'date', started_at: Date.now() - 60_000, tour: TOUR, name: 'Иван Петров' });
    await maxPost('открой 15 июля');

    expect(sqlTouched('operator_chat_date_proposals')).toBe(false);
    expect(maxSent().join('\n')).not.toContain('Открыть');
  });
});

describe('прокатчик о своих машинах — кабинет', () => {
  it('Telegram, живой вход, «Лагуна»: «какой джип свободен 30 октября» — кабинет проката, не Кузьмич туриста', async () => {
    m.partner = LAGUNA;
    await tgPost('какой джип свободен 30 октября');

    const out = tgSent().join('\n');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(TOURIST_ANSWER);
  });

  it('Telegram, «Лагуна»: «какой джип свободен 30 октября» — не Кузьмич туриста', async () => {
    m.partner = LAGUNA;
    await kuzmichPost('какой джип свободен 30 октября');

    const out = kuzmichSent().map((s) => s.text).join('\n');
    expect(out).not.toContain(TOURIST_ANSWER);
    expect(toolNames()).not.toContain('search_car_rental');
  });

  it('MAX, «Лагуна»: «какие машины свободны на выходные» — не Кузьмич туриста', async () => {
    m.partner = LAGUNA;
    await maxPost('какие машины свободны на выходные');

    expect(maxSent().join('\n')).not.toContain(TOURIST_ANSWER);
  });
});

describe('кнопка заявки под ответом с блоком 112', () => {
  // Цены нет: её снял бы страж цен без источника, и кнопку судить было бы не по чему.
  const TOUR_ANSWER = 'Маршрут к вулкану Горелый: подъём около 6 часов, 12 км в одну сторону. '
    + 'Восхождение несложное, но погода меняется быстро, берите тёплое и воду, выходите рано утром.';

  it('беда в вопросе — под ответом нет кнопки «Оформить заявку»', async () => {
    m.tools.mockResolvedValue({ content: TOUR_ANSWER, tool_calls: null, provider: 'test' });
    await kuzmichPost('Помогите, мы заблудились у Горелого');

    const sent = kuzmichSent();
    expect(sent.some((s) => s.text.includes('Маршрут к вулкану Горелый'))).toBe(true);
    expect(sent.some((s) => s.text.includes('112'))).toBe(true);
    expect(sent.some((s) => s.markup.includes(BOOKING_BUTTON))).toBe(false);
  });

  it('без беды тот же ответ получает кнопку, как раньше', async () => {
    m.tools.mockResolvedValue({ content: TOUR_ANSWER, tool_calls: null, provider: 'test' });
    await kuzmichPost('Что взять с собой на Горелый в октябре?');

    const sent = kuzmichSent();
    expect(sent.some((s) => s.text.includes('Маршрут к вулкану Горелый'))).toBe(true);
    expect(sent.some((s) => s.markup.includes(BOOKING_BUTTON))).toBe(true);
  });
});
