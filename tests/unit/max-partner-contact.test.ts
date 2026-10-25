/**
 * Карточка контакта в привязанном чате MAX — не заявка (проверка CRM и каналов 25.10).
 *
 * Оператор в своём привязанном чате прикладывает карточку контакта клиента.
 * До правки ветка контакта стояла раньше проверки партнёра: бот отвечал ему
 * как туристу («Номер получен. Оператор свяжется с вами»), заявка ложилась без
 * адресата и без согласия, и через 2 часа крон добивки (leads-followup) отдавал
 * имя и телефон клиента другому оператору.
 *
 * Сторож — вызов настоящего роута MAX: из чата партнёра заявки нет и ответ
 * называет почему; база не ответила — номер не принят; турист без привязки —
 * заявка, как раньше.
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

const max = await import('@/app/api/max/kuzmich/route');
const { createLead } = await import('@/lib/leads/create');

const MAX_KEY = 'test-webhook-key-25-10-contact';
let MAX_CHAT = 0;
let nextChat = 61_000;
let nextUpdate = 61_000;
/** null — партнёр не найден; 'fail' — база не ответила на поиск партнёра. */
let partnerMode: 'found' | 'none' | 'fail' = 'none';

const OPERATOR = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'vulkan-tur', name: 'Вулкан-Тур',
  category: 'operator', user_id: 'u-operator', profile_status: 'approved',
};

/** Карточка контакта: номер выдуманный. */
function maxContact(): Promise<Response> {
  return max.POST(new NextRequest(`http://localhost/api/max/kuzmich?s=${MAX_KEY}`, {
    method: 'POST',
    body: JSON.stringify({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: { user_id: MAX_CHAT, name: 'Иван' },
        recipient: { chat_id: MAX_CHAT, chat_type: 'dialog' },
        body: {
          mid: `mid-${nextUpdate++}`, seq: 1, text: '',
          attachments: [{ type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\nTEL:+79000000000\nEND:VCARD', tam_info: { name: 'Анна' } } }],
        },
      },
    }),
  }));
}

function maxSent(): string[] {
  return m.maxSend.mock.calls.filter((c) => c[0] === MAX_CHAT).map((c) => String(c[1]));
}

beforeEach(() => {
  MAX_CHAT = nextChat++;
  partnerMode = 'none';
  clearBoundChatEmergencies();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', MAX_KEY);
  vi.stubEnv('TELEGRAM_CHAT_ID', '777');
  m.fetch.mockImplementation(async () => { throw new Error('сеть в тестах закрыта'); });
  vi.stubGlobal('fetch', m.fetch);
  m.pool.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('FROM partners') && q.includes('max_chat_id')) {
      if (partnerMode === 'fail') throw Object.assign(new Error('нет соединения'), { code: '08006' });
      return { rows: partnerMode === 'found' ? [OPERATOR] : [] };
    }
    return { rows: [] };
  });
  m.db.mockResolvedValue({ rows: [] });
  m.maxSend.mockResolvedValue({});
  m.findMaxAdmin.mockResolvedValue({ outcome: 'none' });
  m.findTelegramAdmin.mockResolvedValue({ outcome: 'none' });
  vi.mocked(createLead).mockResolvedValue('lead-1');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('MAX: карточка контакта в привязанном чате партнёра', () => {
  it('заявки нет; ответ называет кабинет и почему', async () => {
    partnerMode = 'found';
    await maxContact();

    expect(createLead).not.toHaveBeenCalled();
    const out = maxSent().join('\n');
    expect(out).toContain('Это чат кабинета «Вулкан-Тур»');
    expect(out).toContain('другим партнёрам');
    expect(out).not.toContain('Номер получен');
    expect(out).not.toContain('+79000000000');
  });

  it('база не ответила, чей это чат, — номер не принят, заявки нет', async () => {
    partnerMode = 'fail';
    await maxContact();

    expect(createLead).not.toHaveBeenCalled();
    expect(maxSent().join('\n')).toContain('Номер не принят');
  });

  it('турист без привязки — заявка, как раньше', async () => {
    await maxContact();

    expect(createLead).toHaveBeenCalledTimes(1);
    expect(maxSent().join('\n')).toContain('Номер получен');
  });
});
