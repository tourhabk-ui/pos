/**
 * MAX: строка кабинета под ответом прокатчика и не под ответом туриста.
 * Кнопка «Помощь» открывает справку, а не модель.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  answerCb: vi.fn(),
  edit: vi.fn(),
  pool: vi.fn(),
  tools: vi.fn(),
  processMessage: vi.fn(),
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
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => m.pool(...a),
    connect: async () => ({ query: (...a: unknown[]) => m.pool(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/ai/providers', () => ({
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallOrNull: vi.fn(async () => null),
}));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/core', () => ({
  processMessage: (...a: unknown[]) => m.processMessage(...a),
  cleanupPending: vi.fn(),
  saveMsg: vi.fn(async () => undefined),
  getHistory: vi.fn(async () => []),
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

const KEY = 'test-webhook-key-rental-bar';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const CHAT = 8802;
const PARTNER = '22222222-2222-4222-8222-222222222222';

const post = (body: unknown) => max.POST(new NextRequest(VERIFIED, { method: 'POST', body: JSON.stringify(body) }));

function message(text: string) {
  return {
    update_type: 'message_created',
    timestamp: Date.now(),
    message: {
      sender: { user_id: CHAT, name: 'Акбар' },
      recipient: { chat_id: CHAT, chat_type: 'dialog' },
      body: { mid: 'mid-1', seq: 1, text },
    },
  };
}

function press(payload: string) {
  return {
    update_type: 'message_callback',
    timestamp: Date.now(),
    callback: { timestamp: Date.now(), callback_id: 'cb', payload, user: { user_id: CHAT, name: 'Акбар' } },
    message: {
      recipient: { chat_id: CHAT, chat_type: 'dialog' },
      body: { mid: 'mid-bar', seq: 1, text: 'кабинет' },
    },
  };
}

function barPayloads(call: unknown[]): string[] {
  const opts = call[2] as { attachments?: Array<{ payload?: { buttons?: Array<Array<{ payload?: string }>> } }> } | undefined;
  return (opts?.attachments ?? []).flatMap((a) => a.payload?.buttons ?? []).flat().map((b) => String(b.payload));
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.maxSendUser.mockResolvedValue({});
  m.answerCb.mockResolvedValue({});
  m.edit.mockResolvedValue({ success: true });
  m.tools.mockResolvedValue({ content: 'ОТВЕТ КАБИНЕТА', tool_calls: null });
  m.processMessage.mockImplementation(async (opts: { reply: (id: number, text: string) => Promise<void>; chatId: number }) => {
    await opts.reply(opts.chatId, 'ОТВЕТ ТУРИСТА');
  });
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
    return { rows: [] };
  });
});

afterEach(() => { vi.unstubAllEnvs(); });

const BAR = ['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help'];

describe('строка кабинета в MAX', () => {
  it('ответ кабинета несёт пять кнопок', async () => {
    await post(message('как дела'));
    expect(m.tools).toHaveBeenCalled();
    expect(m.processMessage).not.toHaveBeenCalled();
    const call = m.maxSend.mock.calls.find((c) => String(c[1]).includes('ОТВЕТ КАБИНЕТА'));
    expect(call).toBeTruthy();
    expect(barPayloads(call!)).toEqual(BAR);
  });

  it('просьба туриста идёт Кузьмичу без строки кабинета', async () => {
    await post(message('найди мне в аренду автомобиль'));
    expect(m.processMessage).toHaveBeenCalled();
    expect(m.tools).not.toHaveBeenCalled();
    const call = m.maxSend.mock.calls.find((c) => String(c[1]).includes('ОТВЕТ ТУРИСТА'));
    expect(call).toBeTruthy();
    expect(barPayloads(call!)).toEqual([]);
  });

  it('«Помощь» — справка, не модель', async () => {
    await post(press('rk:help'));
    expect(m.tools).not.toHaveBeenCalled();
    expect(m.processMessage).not.toHaveBeenCalled();
    const call = m.maxSend.mock.calls.find((c) => String(c[1]).includes('Кабинет проката'));
    expect(call).toBeTruthy();
    expect(barPayloads(call!)).toEqual(BAR);
    expect(String(call?.[1])).not.toMatch(/\d[\d\s]*₽/);
  });
});

describe('меню роли оператора в MAX', () => {
  const OP = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    m.pool.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/admin_max_bindings/.test(s)) return { rows: [] };
      if (/FROM partners/.test(s)) {
        return { rows: [{ id: OP, slug: 'mesto-kamchatka', name: 'Местечко', category: 'operator', user_id: null, profile_status: null }] };
      }
      return { rows: [] };
    });
  });

  it('«Старт» привязанного оператора — справка роли, не меню туриста', async () => {
    await post({
      update_type: 'bot_started', timestamp: 1, chat_id: CHAT, payload: '', user: { user_id: CHAT, name: 'Оператор' },
    });
    expect(m.processMessage).not.toHaveBeenCalled();
    const call = m.maxSend.mock.calls.find((c) => String(c[1]).includes('Кабинет туроператора'));
    expect(call).toBeTruthy();
    expect(barPayloads(call!)).toEqual(['rm:op:in', 'opd:tours', 'opd:seats', 'rm:op:hp', 'sup:new']);
    expect(String(call?.[1])).not.toMatch(/₽/);
  });

  it('«Входящие» — список без модели и без строки проката', async () => {
    await post(message('Входящие'));
    expect(m.tools).not.toHaveBeenCalled();
    expect(m.processMessage).not.toHaveBeenCalled();
    const call = m.maxSend.mock.calls.at(-1);
    expect(String(call?.[1])).toContain('Входящие');
    expect(barPayloads(call!)).toEqual(['rm:op:in', 'rm:op:hp']);
  });
});
