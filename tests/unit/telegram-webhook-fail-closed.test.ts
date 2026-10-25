/**
 * Telegram-вебхук без секрета — отказ, а не работа «без проверки» (аудит 15.10, P3-03).
 *
 * Адрес `/api/telegram/*` публичен на Edge намеренно: Telegram стучится без JWT.
 * Единственное, что в таком запросе нельзя подделать, — заголовок
 * X-Telegram-Bot-Api-Secret-Token; `from.id` и `chat.id` пишет тот, кто стучится.
 * До 15.10 все три обработчика при незаданном секрете писали строку в лог и
 * ПРОДОЛЖАЛИ работу. В главном вебхуке ниже стоит админ-ветка, которая верит
 * `from.id` из тела и отвечает в `chat.id` из тела: подделанный апдейт с id
 * владельца получал /diag (начала ключей бота и моделей) себе в чат. Защита
 * исчезала ровно тогда, когда её забыли настроить, — форма, которую
 * tests/unit/webhook-secrets.test.ts уже запрещает у reposter.
 *
 * Прежнее решение «работаем без секрета, иначе бот замолчит» (#1168) снято
 * замером с прода 15.10: POST без заголовка на /api/telegram/webhook — 403
 * (секрет задан), /api/telegram/kuzmich — 200, но этот роут вебхуком не
 * зарегистрирован. Отказ не глушит живого бота.
 *
 * Сторож — вызов обработчиков: без секрета в окружении — 503 и обработка не
 * начинается (тело не читается, ответ никуда не уходит); с секретом и без
 * заголовка — отказ; с верным заголовком — работа идёт. Плюс сторож вебхука:
 * без секрета он не говорит «ok» за молчащего бота.
 *
 * Мутация (проверено руками): вернуть в любом из трёх роутов прежнее
 * `console.error(...)` без return при not_configured — краснеет «без секрета»
 * этого роута; убрать проверку секрета в checkAndRestoreWebhook — краснеет
 * последний блок.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  dbQuery: vi.fn(),
  tgSend: vi.fn(),
  memberStart: vi.fn(),
  partnerStart: vi.fn(),
  processMessage: vi.fn(),
  fetch: vi.fn(),
}));

// База, транспорт Telegram и тяжёлые соседи подменены: предмет теста — дверь
// обработчика, а не Кузьмич, лиды и поддержка, которые живут в тех же файлах.
// Сверка секрета (lib/telegram/webhook-secret) — настоящая.
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/database', () => ({ query: m.dbQuery }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: m.tgSend } }));
vi.mock('@/lib/notifications/telegram-html', () => ({ repairTelegramHtml: (s: string) => s, TELEGRAM_CAPTION_LIMIT: 1024 }));
vi.mock('@/lib/operators/member-channel', () => ({ handleMemberStart: m.memberStart }));
vi.mock('@/lib/partners/bind-channel', () => ({
  handlePartnerStart: m.partnerStart, bindPartnerChannel: vi.fn(), bindReplyText: vi.fn(() => ''), badLinkReplyText: vi.fn(() => ''),
}));
vi.mock('@/lib/partners/channel-link', () => ({ partnerTokenFromStart: () => null, verifyPartnerLinkToken: vi.fn() }));
vi.mock('@/lib/seat-requests/core', () => ({
  statusTokenFromStart: () => null, touristBindReplyText: () => '', parseAnswerPayload: () => null, operatorReplyText: () => '',
}));
vi.mock('@/lib/seat-requests/service', () => ({
  bindTouristChat: vi.fn(), answerSeatRequest: vi.fn(), requestBelongsToMaxChat: vi.fn(),
}));
vi.mock('@/lib/kuzmich/core', () => ({
  // Живого черновика заявки нет: развилка чата судится без него.
  hasLiveBookingFlow: vi.fn(async () => false),
  KUZMICH_SYSTEM: '', buildTourContext: vi.fn(), searchPlaceKnowledge: vi.fn(),
  processMessage: m.processMessage, cleanupPending: vi.fn(), isBookingTrigger: () => false,
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: vi.fn(async () => ({ outcome: 'not_found' })), partnerGreeting: () => '',
  processPartnerMessage: vi.fn(), PARTNER_EMAIL_BIND_CLOSED: '',
}));
vi.mock('@/lib/kuzmich/watch-flow', () => ({ telegramWatchRedirect: () => null }));
vi.mock('@/lib/agents', () => ({ PlatformAgent: class {} }));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: class {} }));
vi.mock('@/lib/agents/intent-classifier', () => ({ classifyIntentByKeywords: vi.fn() }));
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(), callAIWaterfall: vi.fn(), callOpenrouter: vi.fn(),
  callDeepSeek: vi.fn(), callQwen: vi.fn(), callXai: vi.fn(),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: vi.fn() }));
vi.mock('@/lib/ai/prompts', () => ({}));
vi.mock('@/lib/notifications/telegram-channel', () => ({
  postRouteToChannel: vi.fn(), postOperatorToChannel: vi.fn(), postSezonToChannel: vi.fn(),
  postFriendToChannel: vi.fn(), postKuzmichRoute: vi.fn(), postKuzmichTip: vi.fn(),
}));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn() }));
vi.mock('@/lib/planner/interests', () => ({ parseInterestsFromText: vi.fn(), findRoutesByInterests: vi.fn(), formatRoutesForTelegram: vi.fn() }));
vi.mock('@/lib/telegram/connect-token', () => ({ verifyConnectToken: vi.fn() }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/telegram/welcome', () => ({ sendWelcomeMessage: vi.fn() }));
vi.mock('@/lib/auth/role-routes', () => ({ PARTNER_ROLES: [] }));
vi.mock('@/lib/support/ticket.service', () => ({ createTicket: vi.fn(), getUserOpenTickets: vi.fn(), addTicketMessage: vi.fn() }));
vi.mock('@/lib/support/categorize', () => ({ categorizeSupport: vi.fn(), CATEGORY_LABELS: {}, RESIDENT_INTRO: '' }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: {} }));
vi.mock('@/lib/leads/create', () => ({ createLead: vi.fn() }));
vi.mock('@/lib/leads/status-action', () => ({ applyLeadStatus: vi.fn(), parseLeadStatusPayload: () => null, LEAD_STATUS_ACTIONS: [] }));
vi.mock('@/lib/platform-settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('@/lib/html/text', () => ({ stripTags: (s: string) => s }));
vi.mock('@/lib/config', () => ({ isTechnicalHost: () => false }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn() }));

const webhook = await import('@/app/api/telegram/webhook/route');
const kuzmich = await import('@/app/api/telegram/kuzmich/route');
const admin = await import('@/app/api/telegram/admin/route');
const { checkAndRestoreWebhook } = await import('@/lib/telegram/operator-availability');

/** id владельца — тот, что подделывают в теле, чтобы попасть в админ-ветку. */
const OWNER = 171286547;
const SECRET = 'webhook-secret-for-tests';

/** Что обработчик сделал «дальше» — по каждому роуту своё. */
const sentToTelegram = () =>
  m.tgSend.mock.calls.length > 0 ||
  m.fetch.mock.calls.some(([url]) => String(url).includes('/sendMessage'));

interface RouteCase {
  name: string;
  env: string;
  post: (req: NextRequest) => Promise<Response>;
  /** Код отказа при заданном секрете и чужом заголовке — у роутов он исторически разный. */
  forbidden: number;
  /** Апдейт, который роут обработал бы, пройди он дверь. */
  text: string;
  /** Признак того, что обработка началась. */
  processed: () => boolean;
  /** Отправитель в теле; по умолчанию — подделанный id владельца. */
  from?: number;
}

const ROUTES: RouteCase[] = [
  {
    // Главный: админ-ветка верит from.id из тела, /diag отдаёт начала ключей.
    name: 'telegram/webhook', env: 'TELEGRAM_WEBHOOK_SECRET', post: (r) => webhook.POST(r),
    forbidden: 403, text: '/diag', processed: sentToTelegram,
  },
  {
    // Публичный бот: ссылка менеджера от обычного человека в личке.
    name: 'telegram/kuzmich', env: 'TELEGRAM_KUZMICH_WEBHOOK_SECRET', post: (r) => kuzmich.POST(r),
    forbidden: 401, text: '/start om_tok', processed: () => m.memberStart.mock.calls.length > 0, from: 4242,
  },
  {
    name: 'telegram/admin', env: 'TELEGRAM_ADMIN_WEBHOOK_SECRET', post: (r) => admin.POST(r),
    forbidden: 401, text: '/help', processed: sentToTelegram,
  },
];

let updateId = 1;
function update(r: RouteCase, header?: string): { req: NextRequest; json: ReturnType<typeof vi.spyOn> } {
  const from = r.from ?? OWNER;
  const req = new NextRequest(`http://localhost/api/${r.name}`, {
    method: 'POST',
    headers: header === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': header },
    body: JSON.stringify({
      update_id: updateId++,
      message: { message_id: 1, from: { id: from, first_name: 'Чужой' }, chat: { id: from, type: 'private' }, text: r.text },
    }),
  });
  const json = vi.spyOn(req, 'json');
  return { req, json };
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.query.mockResolvedValue({ rows: [] });
  m.dbQuery.mockResolvedValue({ rows: [] });
  m.tgSend.mockResolvedValue({ success: true });
  m.memberStart.mockResolvedValue(true);
  m.partnerStart.mockResolvedValue(false);
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
  vi.stubGlobal('fetch', m.fetch);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_CHAT_ID', String(OWNER));
  vi.stubEnv('TELEGRAM_OWNER_ID', String(OWNER));
  vi.stubEnv('TELEGRAM_WEBHOOK_URL', 'https://vedarai.ru');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-leak');
  for (const r of ROUTES) vi.stubEnv(r.env, '');
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  errors.mockRestore();
});

describe.each(ROUTES)('$name: дверь вебхука', (r) => {
  it('секрет не задан — 503, тело не читается, ответ никуда не уходит', async () => {
    const { req, json } = update(r);
    const res = await r.post(req);

    expect(res.status, 'без секрета подлинность не проверить — отказ, а не работа').toBe(503);
    expect(json, 'обработка не должна начинаться').not.toHaveBeenCalled();
    expect(r.processed(), 'подделанный апдейт дошёл до обработки').toBe(false);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.tgSend).not.toHaveBeenCalled();

    // Отказ не глушится (§4.0): в логе — имя роута и имя переменной.
    const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain(`[${r.name}]`);
    expect(logged).toContain(r.env);
  });

  it('секрет задан, заголовка нет — отказ, обработка не начинается', async () => {
    vi.stubEnv(r.env, SECRET);
    const { req, json } = update(r);
    const res = await r.post(req);

    expect(res.status).toBe(r.forbidden);
    expect(json).not.toHaveBeenCalled();
    expect(r.processed()).toBe(false);
  });

  it('секрет задан, заголовок чужой — отказ', async () => {
    vi.stubEnv(r.env, SECRET);
    const { req, json } = update(r, 'not-the-secret');
    const res = await r.post(req);

    expect(res.status).toBe(r.forbidden);
    expect(json).not.toHaveBeenCalled();
    expect(r.processed()).toBe(false);
  });

  it('верный заголовок — дверь пройдена, обработка идёт', async () => {
    vi.stubEnv(r.env, SECRET);
    const { req, json } = update(r, SECRET);
    const res = await r.post(req);

    expect(res.status).toBe(200);
    expect(json).toHaveBeenCalled();
    expect(r.processed(), 'настоящий апдейт Telegram обязан обрабатываться').toBe(true);
  });
});

describe('сторож вебхука не выдаёт молчащего бота за живого', () => {
  it('секрет не задан — failed, вебхук без secret_token не ставится, владельцу сказано', async () => {
    const res = await checkAndRestoreWebhook();

    expect(res.status).toBe('failed');
    expect(res.error).toContain('TELEGRAM_WEBHOOK_SECRET');
    const urls = m.fetch.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/setWebhook')), 'адрес, который ответит 503 на всё, ставить незачем').toBe(false);
    expect(urls.some((u) => u.includes('/getWebhookInfo')), 'по одному адресу «ok» не выносится').toBe(false);
    const toOwner = m.fetch.mock.calls.find(([u]) => String(u).includes('/sendMessage'));
    expect(toOwner, 'отказ обязан дойти до человека').toBeTruthy();
    expect(String((toOwner![1] as RequestInit).body)).toContain('TELEGRAM_WEBHOOK_SECRET');
  });

  it('секрет задан и адрес верный — ok', async () => {
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET);
    m.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { url: 'https://vedarai.ru/api/telegram/webhook', pending_update_count: 0 } }),
    });
    const res = await checkAndRestoreWebhook();
    expect(res.status).toBe('ok');
  });

  it('секрет задан, адрес уехал — вебхук ставится с этим секретом', async () => {
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET);
    m.fetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/getWebhookInfo')
        ? { ok: true, result: { url: 'https://vedarai.ru/api/telegram/kuzmich', pending_update_count: 0 } }
        : { ok: true }),
    }));
    const res = await checkAndRestoreWebhook();
    expect(res.status).toBe('restored');
    const set = m.fetch.mock.calls.find(([u]) => String(u).includes('/setWebhook'));
    expect(JSON.parse(String((set![1] as RequestInit).body)).secret_token).toBe(SECRET);
  });
});
