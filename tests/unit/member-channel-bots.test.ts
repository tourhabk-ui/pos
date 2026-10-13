/**
 * Ссылка менеджера `om_` в обоих ботах (CRM 2г-4) — вызовом обработчиков
 * вебхуков, а не поиском строки в файле (CLAUDE.md §4, решение 13.10).
 *
 * Что держит:
 *  - Telegram: `/start om_…` в личном чате уходит в привязку менеджера с ЭТИМ
 *    чатом, ответ — в этот же чат; ссылка кабинета `op_` в неё не попадает;
 *  - MAX: привязка — только из заверенного апдейта (verifiedOrigin — серверный
 *    флаг по секрету вебхука, не поле тела). Незаверенный `om_` — обычный
 *    /start, чат не назначается.
 *
 * Модули обоих роутов подменены целиком: проверяется маршрутизация /start, а
 * не Кузьмич, поддержка и лиды, которые живут в тех же файлах.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  memberStart: vi.fn(),
  partnerStart: vi.fn(),
  tgSend: vi.fn(),
  verifiedMax: vi.fn(),
  processMessage: vi.fn(),
  maxSend: vi.fn(),
}));

// ── Общие для обоих ботов ─────────────────────────────────────────────────
vi.mock('@/lib/operators/member-channel', () => ({ handleMemberStart: m.memberStart }));
vi.mock('@/lib/partners/bind-channel', () => ({
  handlePartnerStart: m.partnerStart, bindPartnerChannel: vi.fn(), bindReplyText: vi.fn(() => ''), badLinkReplyText: vi.fn(() => ''),
}));
vi.mock('@/lib/partners/channel-link', () => ({
  partnerTokenFromStart: (a: string) => (a.startsWith('op_') ? a.slice(3) : null),
  verifyPartnerLinkToken: vi.fn(() => ({ ok: false, reason: 'bad_signature' })),
}));
vi.mock('@/lib/seat-requests/core', () => ({
  statusTokenFromStart: () => null, parseAnswerPayload: () => null, operatorReplyText: () => '',
}));
vi.mock('@/lib/seat-requests/service', () => ({
  bindTouristChat: vi.fn(), answerSeatRequest: vi.fn(), requestBelongsToMaxChat: vi.fn(),
}));
vi.mock('@/lib/kuzmich/core', () => ({
  KUZMICH_SYSTEM: '', buildTourContext: vi.fn(), searchPlaceKnowledge: vi.fn(),
  processMessage: m.processMessage, cleanupPending: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/leads/create', () => ({ createLead: vi.fn() }));
vi.mock('@/lib/leads/status-action', () => ({ applyLeadStatus: vi.fn(), parseLeadStatusPayload: () => null, LEAD_STATUS_ACTIONS: [] }));

// ── Telegram ──────────────────────────────────────────────────────────────
vi.mock('@/lib/notifications/telegram-html', () => ({ repairTelegramHtml: (s: string) => s, TELEGRAM_CAPTION_LIMIT: 1024 }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: m.tgSend } }));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok' }));
vi.mock('@/lib/kuzmich/watch-flow', () => ({ telegramWatchRedirect: () => null }));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn() }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: vi.fn() }));
vi.mock('@/lib/ai/prompts', () => ({}));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn() }));
vi.mock('@/lib/planner/interests', () => ({ parseInterestsFromText: vi.fn(), findRoutesByInterests: vi.fn(), formatRoutesForTelegram: vi.fn() }));
vi.mock('@/lib/notifications/telegram-channel', () => ({
  postRouteToChannel: vi.fn(), postOperatorToChannel: vi.fn(), postSezonToChannel: vi.fn(), postFriendToChannel: vi.fn(),
}));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: class {} }));
vi.mock('@/lib/agents/intent-classifier', () => ({ classifyIntentByKeywords: vi.fn() }));
vi.mock('@/lib/telegram/connect-token', () => ({ verifyConnectToken: vi.fn() }));
vi.mock('@/lib/auth/role-routes', () => ({ PARTNER_ROLES: [] }));
vi.mock('@/lib/telegram/welcome', () => ({ sendWelcomeMessage: vi.fn() }));
vi.mock('@/lib/support/ticket.service', () => ({ createTicket: vi.fn(), getUserOpenTickets: vi.fn(), addTicketMessage: vi.fn() }));
vi.mock('@/lib/support/categorize', () => ({ categorizeSupport: vi.fn(), CATEGORY_LABELS: {}, RESIDENT_INTRO: '' }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: {} }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/config', () => ({ isTechnicalHost: () => false }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn() }));

// ── MAX ───────────────────────────────────────────────────────────────────
vi.mock('@/lib/max/max-fetch', () => ({ maxBot: () => ({ api: { sendMessageToChat: m.maxSend } }) }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ PARTNER_EMAIL_BIND_CLOSED: '', findPartnerByChat: vi.fn() }));
vi.mock('@/lib/auth/max-login', () => ({ authenticateMaxLoginSession: vi.fn() }));
vi.mock('@/lib/max/webhook-url', () => ({ isVerifiedMaxWebhook: m.verifiedMax }));

const telegram = await import('@/app/api/telegram/webhook/route');
const max = await import('@/app/api/max/kuzmich/route');

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.memberStart.mockResolvedValue(true);
  m.partnerStart.mockResolvedValue(false);
  m.tgSend.mockResolvedValue({ success: true });
  m.maxSend.mockResolvedValue({});
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const tgUpdate = (text: string, chat: { id: number; type: string } = { id: 4242, type: 'private' }) =>
  new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: chat.id, first_name: 'Анна' }, chat, text } }),
  });

describe('Telegram: /start om_', () => {
  it('ссылка менеджера уходит в привязку с этим чатом, ответ — в этот же чат', async () => {
    const res = await telegram.POST(tgUpdate('/start om_tok'));
    expect(await res.json()).toEqual({ ok: true });
    expect(m.memberStart).toHaveBeenCalledTimes(1);
    const [arg, channel, chatId, reply] = m.memberStart.mock.calls[0] as [string, string, number, (t: string) => Promise<unknown>];
    expect([arg, channel, chatId]).toEqual(['om_tok', 'telegram', 4242]);
    await reply('Готово');
    expect(m.tgSend).toHaveBeenCalledWith(expect.objectContaining({ chatId: '4242', text: 'Готово' }));
  });

  it('ссылка кабинета op_ в привязку менеджера не попадает', async () => {
    await telegram.POST(tgUpdate('/start op_tok'));
    expect(m.memberStart).not.toHaveBeenCalled();
  });

  it('в группе /start om_ никого не подключает', async () => {
    await telegram.POST(tgUpdate('/start om_tok', { id: -100500, type: 'supergroup' }));
    expect(m.memberStart).not.toHaveBeenCalled();
  });
});

const maxUpdate = (payload: string) =>
  new NextRequest('http://localhost/api/max/kuzmich', {
    method: 'POST',
    body: JSON.stringify({ update_type: 'bot_started', chat_id: 77, payload, user: { user_id: 77, name: 'Анна' } }),
  });

describe('MAX: /start om_ — только из заверенного апдейта', () => {
  it('заверенный апдейт — привязка с этим чатом, обычного /start нет', async () => {
    m.verifiedMax.mockReturnValue(true);
    await max.POST(maxUpdate('om_tok'));
    expect(m.memberStart).toHaveBeenCalledTimes(1);
    const [arg, channel, chatId, reply] = m.memberStart.mock.calls[0] as [string, string, number, (t: string) => Promise<unknown>];
    expect([arg, channel, chatId]).toEqual(['om_tok', 'max', 77]);
    await reply('Готово');
    expect(m.maxSend).toHaveBeenCalledWith(77, 'Готово', expect.anything());
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('незаверенный апдейт — чат не назначается, это обычный /start', async () => {
    m.verifiedMax.mockReturnValue(false);
    await max.POST(maxUpdate('om_tok'));
    expect(m.memberStart).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledTimes(1);
  });
});
