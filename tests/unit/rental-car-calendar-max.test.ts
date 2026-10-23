// @vitest-environment node
/**
 * Дверь вебхука MAX для календаря проката: незаверенное нажатие rb: не
 * пишет отметку, чужой чат — тоже. Заверенное из личного диалога пилота
 * правит то же сообщение.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { PRESS_WITHOUT_MESSAGE_REPLY, UNVERIFIED_PRESS_REPLY } from '@/lib/max/verified-press';
import { setPayload } from '@/lib/rental/car-calendar';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  answerCb: vi.fn(),
  edit: vi.fn(),
  pool: vi.fn(),
  tools: vi.fn(),
  partnerMessage: vi.fn(),
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: m.maxSend,
      sendMessageToUser: m.maxSendUser,
      answerOnCallback: m.answerCb,
      editMessage: m.edit,
    },
  }),
  maxFetch: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.pool(...a) } }));
vi.mock('@/lib/ai/providers', () => ({
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallOrNull: vi.fn(async () => null),
}));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/core', () => ({
  processMessage: vi.fn(), cleanupPending: vi.fn(), saveMsg: vi.fn(async () => undefined), getHistory: vi.fn(async () => []),
}));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn(),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: vi.fn(async () => ({ success: true })) },
}));

const max = await import('@/app/api/max/kuzmich/route');

const KEY = 'test-webhook-key-rental-calendar';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const CHAT = 8801;
const OFFER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const TODAY = kamchatkaDate(new Date());

const post = (url: string, body: unknown) => max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

function press(payload: string, opts: { chatId?: number | null; chatType?: string } = {}) {
  return {
    update_type: 'message_callback',
    timestamp: Date.now(),
    callback: { timestamp: Date.now(), callback_id: 'cb', payload, user: { user_id: CHAT, name: 'Акбар' } },
    ...(opts.chatId === null ? {} : {
      message: {
        recipient: { chat_id: opts.chatId ?? CHAT, chat_type: opts.chatType ?? 'dialog' },
        body: { mid: 'mid-cal', seq: 1, text: 'календарь' },
      },
    }),
  };
}

function message(text: string, chatType = 'dialog') {
  return {
    update_type: 'message_created',
    timestamp: Date.now(),
    message: {
      sender: { user_id: CHAT, name: 'Акбар' },
      recipient: { chat_id: CHAT, chat_type: chatType },
      body: { mid: 'mid-1', seq: 1, text },
    },
  };
}

function sqls(): string[] {
  return m.pool.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.maxSendUser.mockResolvedValue({});
  m.answerCb.mockResolvedValue({});
  m.edit.mockResolvedValue({ success: true });
  m.tools.mockResolvedValue({ content: 'ОТВЕТ', tool_calls: null });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  m.pool.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (/admin_max_bindings/.test(s)) return { rows: [] };
    if (/FROM partners/.test(s)) {
      return { rows: [{ id: PARTNER, slug: 'laguna-prokat', name: 'Лагуна Прокат', category: 'transfer', user_id: null, profile_status: null }] };
    }
    if (/FROM car_rental_offers/.test(s)) return { rows: [{ id: OFFER, title: 'Suzuki Jimny', is_active: true }] };
    if (/INSERT INTO rental_car_busy/.test(s)) return { rows: [{ offer_id: OFFER }] };
    if (/FROM rental_car_busy/.test(s)) return { rows: [{ day: TODAY, busy: true }] };
    return { rows: [] };
  });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('нажатие rb:', () => {
  const payload = () => setPayload(OFFER, TODAY, true);

  it('без ключа при заданном ключе не обрабатывается и ничего не пишет', async () => {
    await post('http://localhost/api/max/kuzmich', press(payload()));
    expect(m.maxSend).not.toHaveBeenCalled();
    expect(sqls().some((s) => /INSERT INTO rental_car_busy/.test(s))).toBe(false);
  });

  it('ключа нет — нажатие не засчитано и отметка не пишется', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    await post(VERIFIED, press(payload()));
    expect(m.maxSend.mock.calls.map((c) => String(c[1]))).toContain(UNVERIFIED_PRESS_REPLY.rental);
    expect(sqls().some((s) => /INSERT INTO rental_car_busy/.test(s))).toBe(false);
  });

  it('без сообщения с кнопкой не пишется, нажавший узнаёт об этом лично', async () => {
    await post(VERIFIED, press(payload(), { chatId: null }));
    expect(sqls().some((s) => /INSERT INTO rental_car_busy/.test(s))).toBe(false);
    expect(m.maxSendUser.mock.calls.map((c) => String(c[1]))).toContain(PRESS_WITHOUT_MESSAGE_REPLY.rental);
  });

  it('не из личного диалога не пишется', async () => {
    await post(VERIFIED, press(payload(), { chatType: 'chat' }));
    expect(sqls().some((s) => /INSERT INTO rental_car_busy/.test(s))).toBe(false);
    expect(m.maxSend.mock.calls.map((c) => String(c[1])).join('\n')).toMatch(/личном диалоге/);
  });

  it('заверенное нажатие пилота пишет день его машины и правит сообщение', async () => {
    await post(VERIFIED, press(payload()));
    const insert = m.pool.mock.calls.find((c) => /INSERT INTO rental_car_busy/.test(String(c[0])));
    expect(insert?.[1]).toEqual([OFFER, PARTNER, TODAY, true]);
    expect(m.edit).toHaveBeenCalled();
    const edited = String(m.edit.mock.calls[0]?.[1]?.text ?? '');
    expect(edited).toContain('занята');
    expect(edited).toContain('не отмечено');
  });
});

describe('фраза «календарь»', () => {
  it('пилоту показывает прайс без записи', async () => {
    await post(VERIFIED, message('календарь'));
    expect(sqls().some((s) => /INSERT INTO rental_car_busy/.test(s))).toBe(false);
    const sent = m.maxSend.mock.calls.map((c) => String(c[1])).join('\n');
    expect(sent).toContain('Suzuki Jimny');
    expect(sent).toContain('не отмечено');
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('в группе машины не читает', async () => {
    await post(VERIFIED, message('календарь', 'chat'));
    expect(sqls().some((s) => /car_rental_offers/.test(s))).toBe(false);
    expect(m.maxSend.mock.calls.map((c) => String(c[1])).join('\n')).toMatch(/личном диалоге/);
  });
});
