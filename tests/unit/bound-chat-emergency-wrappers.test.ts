/**
 * Блок 112 на ответе кабинета привязанного чата (проверка качества 24.10).
 *
 * Классификатор (lib/kuzmich/bound-chat-route) отдаёт беду Кузьмичу туриста,
 * но команда кабинета своей формой («календарь Jimny …», «покажи брони …») и
 * дело CRM («запиши: …») остаются кабинету. Тогда 112 ставит отправитель
 * ответа кабинета: в Telegram — кабинет проката (cabinet-telegram) и меню роли
 * (role-telegram), на втором входе /api/telegram/kuzmich — его `say`, в MAX —
 * обёртка ветки партнёра в роуте. Здесь судятся именно те ответы, которые
 * идут мимо помощника CRM (календарь, «даты — в MAX», поток дат): у помощника
 * своя обёртка (operator-chat), и она прятала бы пропажу внешней.
 *
 * Отдельно — подпись фото в Telegram: «Помогите, мы заблудились» под снимком
 * раньше оставалась без ответа, схема апдейта подписи не знала.
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
  fetch: vi.fn(),
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

const telegram = await import('@/app/api/telegram/webhook/route');
const kuzmichTg = await import('@/app/api/telegram/kuzmich/route');
const max = await import('@/app/api/max/kuzmich/route');

/** Строка блока 112 (lib/safety/sos-detector, SOS_HEAD.ru). */
const CALL_112 = 'Звоните 112';
/** Ответ «даты — в MAX» (lib/operators/chat-dates/texts, telegramDatesText). */
const DATES_IN_MAX = 'Открыть даты словами можно в MAX';
const CABINET_ANSWER = 'ОТВЕТ ПОМОЩНИКА КАБИНЕТА';
// Без «тур» и «маршрут»: иначе MAX добавит вторым сообщением «Хотите
// оформить заявку?», и считать пришлось бы его.
const TOURIST_ANSWER = 'ОТВЕТ МОЗГА КУЗЬМИЧА';

const TG_PARTNER_CHAT = 5151;
const TG_TOURIST_CHAT = 4242;
const MAX_CHAT = 8_824;
const MAX_KEY = 'test-webhook-key-25-10-wrappers';

/** Команда календаря с бедой, которую видит детектор («упал с обрыва» — injury). */
const CALENDAR_SOS = 'календарь Jimny турист упал с обрыва';
/** Беда со словом CRM и фразой про даты: классификатор оставляет её кабинету. */
const CRM_DATES_SOS = 'запиши: турист сломал ногу, закрой субботу';

const OPERATOR = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'vulkan-tur', name: 'Вулкан-Тур',
  category: 'operator', user_id: 'u-operator', profile_status: 'approved',
};
const GUIDE = {
  id: '33333333-3333-4333-8333-333333333333', slug: null, name: 'Гид Анна',
  category: 'guide', user_id: 'u-guide', profile_status: 'approved',
};
const LAGUNA = {
  id: '22222222-2222-4222-8222-222222222222', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  category: 'transfer', user_id: null, profile_status: null,
};
/** Прайс «Лагуны» в тесте: название машины ищется подстрокой, как ILIKE. */
const LAGUNA_CARS = [{ id: '44444444-4444-4444-8444-444444444444', title: 'Suzuki Jimny', is_active: true }];
/** Машина для правки описания: код правки ищет её точным названием. */
const HILUX = {
  id: '55555555-5555-4555-8555-555555555555', title: 'Toyota Hilux',
  price_rub_per_day: 12000, price_is_from: false, conditions: null,
};

let nextUpdateId = 25_100;

function tgPost(text: string, chat: number): Promise<Response> {
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: { message_id: 1, from: { id: chat, first_name: 'Анна' }, chat: { id: chat, type: 'private' }, text },
    }),
  }));
}

/** Фото в личке: подпись — по желанию, текста нет. */
function tgPhoto(caption: string | undefined, chat: number): Promise<Response> {
  const message: Record<string, unknown> = {
    message_id: 2,
    from: { id: chat, first_name: 'Анна' },
    chat: { id: chat, type: 'private' },
    photo: [{ file_id: 'photo-file-1', file_unique_id: 'u-1', width: 90, height: 90 }],
  };
  if (caption !== undefined) message.caption = caption;
  return telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({ update_id: nextUpdateId++, message }),
  }));
}

function kuzmichPost(text: string, chat: number): Promise<Response> {
  return kuzmichTg.POST(new NextRequest('http://localhost/api/telegram/kuzmich', {
    method: 'POST',
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: { message_id: 1, from: { id: chat, first_name: 'Анна' }, chat: { id: chat, type: 'private' }, text },
    }),
  }));
}

function maxPost(text: string): Promise<Response> {
  return max.POST(new NextRequest(`http://localhost/api/max/kuzmich?s=${MAX_KEY}`, {
    method: 'POST',
    body: JSON.stringify({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: MAX_CHAT, name: 'Анна' },
        recipient: { chat_id: MAX_CHAT, chat_type: 'dialog' },
        body: { mid: `mid-${nextUpdateId++}`, seq: 1, text },
      },
    }),
  }));
}

/** Что получил человек в Telegram (живой вход). */
function tgSent(): string[] {
  return m.tgSend.mock.calls.map((c) => String((c[0] as { text?: string }).text ?? ''));
}

/** Что получил человек со второго входа: тела sendMessage к Bot API. */
function kuzmichSent(): string[] {
  return m.fetch.mock.calls
    .filter(([url]) => String(url).includes('/sendMessage'))
    .map(([, init]) => String((JSON.parse(String((init as RequestInit).body)) as { text?: string }).text ?? ''));
}

/** Что получил человек в MAX. */
function maxSent(): string[] {
  return m.maxSend.mock.calls.filter((c) => c[0] === MAX_CHAT).map((c) => String(c[1]));
}

/** Имена инструментов, которые получила модель: по ним видно, чей это ответ. */
function toolNames(): string[] {
  return m.tools.mock.calls
    .flatMap((c) => (c[1] ?? []) as Array<{ function?: { name?: string } }>)
    .map((t) => String(t.function?.name));
}

/** Всё, что ушло в модели пользовательскими репликами. */
function modelUserTexts(): string[] {
  const lists = [
    ...m.tools.mock.calls.map((c) => c[0]),
    ...m.orNull.mock.calls.map((c) => c[0]),
    ...m.fallback.mock.calls.map((c) => c[0]),
    ...m.direct.mock.calls.map((c) => c[0]),
  ] as Array<Array<{ role?: string; content?: string | null }>>;
  return lists.flat().filter((x) => x.role === 'user').map((x) => String(x.content ?? ''));
}

function sqlTouched(fragment: string): boolean {
  return m.pool.mock.calls.some((c) => String(c[0]).includes(fragment));
}

/** Шаблон ILIKE '%…%' без экранирования — для подстрочного поиска машины в тесте. */
function likeBody(pattern: unknown): string {
  return String(pattern ?? '').replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
}

beforeEach(() => {
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  m.history = [];
  m.partner = null;
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
  // Наружу ходит только второй вход Telegram, и только к Bot API.
  m.fetch.mockImplementation(async (url: unknown) => {
    if (String(url).includes('/sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
    throw new Error('сеть в тестах закрыта');
  });
  vi.stubGlobal('fetch', m.fetch);
  m.pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('INSERT INTO tg_conversations')) {
      m.history.push({ chat: params?.[0], mode: params?.[1], role: String(params?.[2] ?? ''), content: String(params?.[3] ?? '') });
      return { rows: [] };
    }
    if (q.includes('FROM tg_conversations') && q.includes('SELECT role, content')) {
      const own = m.history.filter((h) => Number(h.chat) === Number(params?.[0]) && h.mode === params?.[1]);
      return { rows: own.map(({ role, content }) => ({ role, content })).reverse() };
    }
    if (q.includes('FROM partners') && q.includes('telegram_chat_id = $1')) {
      return { rows: m.partner && params?.[0] === TG_PARTNER_CHAT ? [m.partner] : [] };
    }
    if (q.includes('FROM partners') && q.includes('max_chat_id')) {
      return { rows: m.partner && Number(params?.[0]) === MAX_CHAT ? [m.partner] : [] };
    }
    if (q.includes('FROM car_rental_offers') && q.includes('ILIKE')) {
      const body = likeBody(params?.[2]);
      return { rows: LAGUNA_CARS.filter((c) => params?.[1] === '' || c.title.toLowerCase().includes(body)) };
    }
    if (q.includes('FROM car_rental_offers') && q.includes('lower(btrim(title))')) {
      const asked = String(params?.[1] ?? '').trim().toLowerCase();
      return { rows: asked === HILUX.title.toLowerCase() ? [HILUX] : [] };
    }
    if (q.includes('INSERT INTO rental_offer_edits')) {
      return { rows: [{ price_rub_per_day: params?.[2] ?? null, conditions: params?.[3] ?? null }] };
    }
    return { rows: [] };
  });
  m.db.mockResolvedValue({ rows: [] });
  m.tgSend.mockResolvedValue({ success: true });
  m.maxSend.mockResolvedValue({});
  m.findMaxAdmin.mockResolvedValue({ outcome: 'none' });
  m.tools.mockImplementation(async (_msgs: unknown, tools?: Array<{ function?: { name?: string } }>) => {
    const crm = (tools ?? []).some((t) => String(t.function?.name).startsWith('crm_'));
    return { content: crm ? CABINET_ANSWER : TOURIST_ANSWER, tool_calls: null, provider: 'test' };
  });
  m.orNull.mockResolvedValue(null);
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Telegram, живой вход: команда кабинета с бедой — ответ кабинета с 112', () => {
  it(`прокат «Лагуна»: «${CALENDAR_SOS}» — ответ календаря, над ним «${CALL_112}», модели нет`, async () => {
    m.partner = LAGUNA;
    const res = await tgPost(CALENDAR_SOS, TG_PARTNER_CHAT);
    expect(await res.json()).toEqual({ ok: true });

    const out = tgSent();
    expect(out).toHaveLength(1);
    // Ответил календарь проката: он прочитал прайс и назвал то, что искал.
    expect(sqlTouched('FROM car_rental_offers')).toBe(true);
    expect(out[0]).toContain('В прайсе нет машины, в названии которой есть «jimny турист упал с обрыва»');
    expect(out[0]).toContain(CALL_112);
    expect(out[0].indexOf(CALL_112)).toBeLessThan(out[0].indexOf('В прайсе нет машины'));
    expect(m.tools).not.toHaveBeenCalled();
  });

  it(`туроператор: «${CRM_DATES_SOS}» — ответ «даты — в MAX» с «${CALL_112}», помощник и Кузьмич не зовутся`, async () => {
    m.partner = OPERATOR;
    await tgPost(CRM_DATES_SOS, TG_PARTNER_CHAT);

    const out = tgSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(DATES_IN_MAX);
    expect(out[0]).toContain(CALL_112);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('без беды команда календаря отвечает без 112', async () => {
    m.partner = LAGUNA;
    await tgPost('календарь Jimny', TG_PARTNER_CHAT);

    const out = tgSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Suzuki Jimny');
    expect(out[0]).not.toContain('112');
  });

  it('прокат «Лагуна»: «описание Toyota Hilux: дизель зимой не замерзает» — черновик правки без 112: это описание машины, не беда', async () => {
    m.partner = LAGUNA;
    await tgPost('описание Toyota Hilux: дизель зимой не замерзает', TG_PARTNER_CHAT);

    const out = tgSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Черновик записан: «Toyota Hilux»');
    expect(out[0]).not.toContain('112');
    expect(m.tools).not.toHaveBeenCalled();
  });
});

describe('Telegram, второй вход /api/telegram/kuzmich: беда со словом CRM — ответ кабинета с 112', () => {
  it(`туроператор: «${CRM_DATES_SOS}» — «даты — в MAX» с «${CALL_112}»`, async () => {
    m.partner = OPERATOR;
    const res = await kuzmichPost(CRM_DATES_SOS, TG_PARTNER_CHAT);
    expect(await res.json()).toEqual({ ok: true });

    const out = kuzmichSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(DATES_IN_MAX);
    expect(out[0]).toContain(CALL_112);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('гид: «Запиши: турист сломал ногу на Горелом» — ответ помощника кабинета с 112', async () => {
    m.partner = GUIDE;
    await kuzmichPost('Запиши: турист сломал ногу на Горелом', TG_PARTNER_CHAT);

    expect(toolNames().some((n) => n.startsWith('crm_'))).toBe(true);
    const out = kuzmichSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CABINET_ANSWER);
    expect(out[0]).toContain(CALL_112);
  });

  it(`прокат «Лагуна»: «${CALENDAR_SOS}» — ответ календаря с «${CALL_112}»`, async () => {
    m.partner = LAGUNA;
    await kuzmichPost(CALENDAR_SOS, TG_PARTNER_CHAT);

    const out = kuzmichSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('В прайсе нет машины');
    expect(out[0]).toContain(CALL_112);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('гид: дело CRM без беды — ответ помощника без 112', async () => {
    m.partner = GUIDE;
    await kuzmichPost('Запиши, что звонил', TG_PARTNER_CHAT);

    const out = kuzmichSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CABINET_ANSWER);
    expect(out[0]).not.toContain('112');
  });
});

describe('MAX: беда в чате туроператора', () => {
  it('«Турист сломал ногу, закрой субботу» (без слова CRM) — Кузьмич туриста с 112, поток дат не смотрит', async () => {
    m.partner = OPERATOR;
    await maxPost('Турист сломал ногу, закрой субботу');

    const out = maxSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CALL_112);
    expect(out[0]).toContain(TOURIST_ANSWER);
    // Поток дат фразу не смотрел: предложений дат он не снимал и не заводил.
    // (Туры читает и Кузьмич туриста — по ним поток дат не узнать.)
    expect(sqlTouched('operator_chat_date_proposals')).toBe(false);
    expect(toolNames().some((n) => n.startsWith('crm_'))).toBe(false);
  });

  it(`«${CRM_DATES_SOS}» — дело CRM остаётся кабинету: ответ потока дат несёт 112`, async () => {
    m.partner = OPERATOR;
    await maxPost(CRM_DATES_SOS);

    const out = maxSent();
    expect(out).toHaveLength(1);
    // Ответил поток дат (lib/operators/chat-dates, FLOW_TEXT.closeIntent).
    expect(out[0]).toContain('Закрыть даты из чата пока нельзя');
    expect(out[0]).toContain(CALL_112);
    expect(out[0]).not.toContain(TOURIST_ANSWER);
    expect(m.tools).not.toHaveBeenCalled();
  });

  it(`прокат «Лагуна»: «${CALENDAR_SOS}» — ответ календаря с 112`, async () => {
    m.partner = LAGUNA;
    await maxPost(CALENDAR_SOS);

    const out = maxSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('В прайсе нет машины');
    expect(out[0]).toContain(CALL_112);
    expect(m.tools).not.toHaveBeenCalled();
  });
});

describe('Telegram: подпись фото', () => {
  it('фото с подписью «Помогите, мы заблудились» без текста — ответ по подписи с 112', async () => {
    const res = await tgPhoto('Помогите, мы заблудились', TG_TOURIST_CHAT);
    expect(await res.json()).toEqual({ ok: true });

    const out = tgSent();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(CALL_112);
    expect(out[0]).toContain(TOURIST_ANSWER);
    expect(modelUserTexts().some((t) => t.includes('Помогите, мы заблудились'))).toBe(true);
  });

  it.each([
    ['без подписи', undefined],
    ['с подписью из пробелов', '   '],
  ])('фото %s в личке — одна строка «пишите текстом» с 112, модель не зовётся', async (_case, caption) => {
    const res = await tgPhoto(caption, TG_TOURIST_CHAT);
    expect(await res.json()).toEqual({ ok: true });

    expect(m.tgSend).toHaveBeenCalledTimes(1);
    const body = String((m.tgSend.mock.calls[0]?.[0] as { text?: string }).text ?? '');
    expect(body).toContain('только текст');
    expect(body).toContain('112');
    expect(m.tools).not.toHaveBeenCalled();
    expect(m.fallback).not.toHaveBeenCalled();
  });

  it('подпись-команда под фото командой не становится', async () => {
    await tgPhoto('/post sezon', TG_TOURIST_CHAT);
    expect(m.tgSend).toHaveBeenCalledTimes(1);
    expect(String((m.tgSend.mock.calls[0]?.[0] as { text?: string }).text ?? '')).toContain('только текст');
    expect(m.tools).not.toHaveBeenCalled();
  });
});
