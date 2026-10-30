/**
 * Кабинет в чате на втором входе Telegram (/api/telegram/kuzmich, вебхуком не
 * зарегистрирован). Этот вход умеет нажимать только кнопки кабинета (`cb:`) и
 * меню роли (`rm:`): ответы на бронь и заявку (`bk:`, `ia:`, `opd:`) живут в
 * основном боте. Кнопка, которую вход не умеет, была бы мёртвой — карточка и
 * «Брони» гида приходят без неё, а не с ней (ревью 30.10).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  find: vi.fn(),
  inbox: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.poolQuery(...a), connect: vi.fn() } }));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/kuzmich/core', () => ({
  hasLiveBookingFlow: vi.fn(async () => false),
  KUZMICH_SYSTEM: '',
  aiChat: vi.fn(),
  getHistory: vi.fn(),
  processMessage: vi.fn(),
  cleanupPending: vi.fn(),
  isBookingTrigger: () => false,
  buildTourContext: vi.fn(),
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: (...a: unknown[]) => m.find(...a),
  partnerGreeting: () => 'кабинет',
  processPartnerMessage: vi.fn(),
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
}));
vi.mock('@/lib/crm/inbox', () => ({ loadInbox: (...a: unknown[]) => m.inbox(...a) }));
vi.mock('@/lib/agents', () => ({ PlatformAgent: class {} }));

const kuzmich = await import('@/app/api/telegram/kuzmich/route');

const CHAT = 77_001;
const OPERATOR = {
  partnerId: '11111111-1111-4111-8111-111111111111', partnerName: 'Местечко', slug: 'mesto',
  category: 'operator', crmCategory: 'operator', userId: '22222222-2222-4222-8222-222222222222', sellsTours: true,
};
const BOOKING = {
  kind: 'operator_booking', id: '501', created_at: '2026-10-29T00:00:00.000Z', title: 'Горелый', date: '2026-11-05',
  people: 2, contact_id: null, contact_name: null, waiting_minutes: 30,
};
let updateId = 91_000;

function press(data: string) {
  return kuzmich.POST(new NextRequest('http://localhost/api/telegram/kuzmich', {
    method: 'POST',
    body: JSON.stringify({
      update_id: updateId++,
      callback_query: { id: `cb-${updateId}`, from: { id: CHAT }, message: { chat: { id: CHAT, type: 'private' } }, data },
    }),
  }));
}

type Kb = { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>> };
function lastReply(): { text: string; reply_markup?: Kb } {
  const sends = m.fetch.mock.calls.filter(([url]) => String(url).includes('/sendMessage'));
  const [, init] = sends.at(-1) ?? [];
  return JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as { text: string; reply_markup?: Kb };
}
const callbacks = (r: { reply_markup?: Kb }) =>
  (r.reply_markup?.inline_keyboard ?? []).flat().flatMap((b) => (b.callback_data ? [b.callback_data] : []));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', m.fetch);
  m.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  m.find.mockResolvedValue({ outcome: 'found', partner: OPERATOR });
  m.inbox.mockResolvedValue({
    category: 'operator', items: [BOOKING], failed: [], chat: { state: 'none' }, not_here: [],
    response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('второй вход Telegram: только кнопки, которые он умеет нажимать', () => {
  it('карточка брони из «Входящих» — без «Подтвердить» и «Отклонить» (их ведёт основной бот), со строкой кабинета', async () => {
    await press('cb:o:ob:501');
    const card = lastReply();
    expect(card.text).toMatch(/^<b>Бронь тура<\/b>/);
    const cbs = callbacks(card);
    expect(cbs.length).toBeGreaterThan(0);
    expect(cbs.every((p) => p.startsWith('cb:') || p.startsWith('rm:'))).toBe(true);
    expect(cbs).toEqual(expect.arrayContaining(['cb:i', 'cb:t', 'cb:c', 'cb:m']));
  });

  it('вкладка «Входящие» строки меню — список со строками карточек и кабинета', async () => {
    await press('rm:op:in');
    const list = lastReply();
    expect(list.text).toContain('Ждут ответа: 1');
    expect(callbacks(list)).toEqual(expect.arrayContaining(['cb:o:ob:501', 'cb:i']));
  });
});
