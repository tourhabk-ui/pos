/**
 * Администратор в MAX (слово владельца 23.10: «Я админ и чат должен знать что
 * админ подключен со всеми правами»; «1а 2б») — вызовом вебхука
 * POST /api/max/kuzmich и роута /api/admin/max-link, а не поиском строк.
 *
 * Что держит:
 *  - администратора бот узнаёт только в заверенном апдейте личного диалога:
 *    группа и незаверенный апдейт базу администраторов не спрашивают;
 *  - ответ с ПД туристов уходит через sendPdAlert строго в его чат (без
 *    отката на рабочий чат и без Telegram), обычным ответом — никогда; не
 *    доставился — он узнаёт об этом текстом без ПД;
 *  - номер или фото от администратора не становятся заявкой и не уходят в
 *    модель; непонятое — подсказка, а не модель;
 *  - «не смог проверить» идёт обычным путём, а не отвечает «вы не админ»;
 *  - кнопки меню роли (rm:) выполняются только из заверенного апдейта
 *    личного диалога и по праву НАЖАВШЕГО: администратор — по его user_id,
 *    партнёр — по чату сообщения; отказ — до чтения броней и входящих;
 *    «роль не проверена» не выдаётся за «не ваш кабинет»;
 *  - роут ссылки: права — до любого обращения к данным; ответ не кешируется.
 *
 * Выдача, погашение и снятие роли на настоящей схеме —
 * tests/integration/max-login-confirm.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  pool: vi.fn(),
  processMessage: vi.fn(),
  findPartner: vi.fn(),
  createLead: vi.fn(),
  findAdmin: vi.fn(),
  adminReply: vi.fn(),
  pdAlert: vi.fn(),
  requireAdmin: vi.fn(),
  issue: vi.fn(),
  status: vi.fn(),
  unbind: vi.fn(),
  loadInbox: vi.fn(),
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: vi.fn(), answerOnCallback: vi.fn(async () => ({})) } }),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.pool } }));
vi.mock('@/lib/kuzmich/core', () => ({ processMessage: m.processMessage, cleanupPending: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
  findPartnerByChat: m.findPartner,
  processPartnerMessage: vi.fn(),
}));
vi.mock('@/lib/leads/create', () => ({ createLead: m.createLead }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: m.pdAlert }));
vi.mock('@/lib/max/admin-link', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: m.findAdmin,
  issueAdminMaxLink: m.issue,
  adminMaxStatus: m.status,
  unbindAdminMax: m.unbind,
}));
vi.mock('@/lib/max/admin-read', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-read')>()),
  adminReplyFor: m.adminReply,
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: m.requireAdmin }));
vi.mock('@/lib/crm/inbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/inbox')>()),
  loadInbox: m.loadInbox,
}));

const max = await import('@/app/api/max/kuzmich/route');
const { ADMIN_CHAT_TEXT } = await import('@/lib/max/admin-chat');
const { ADMIN_HELP_TEXT } = await import('@/lib/max/admin-read');

const KEY = 'test-webhook-key-23-10';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const UNVERIFIED = 'http://localhost/api/max/kuzmich';
const ADMIN_USER = 501;
const ADMIN_CHAT = 9_501;
const PD_TEXT = '<b>Ждут подтверждения оператора: 1</b>\n• №7 · Горелый · Турист Т., +70000000001 · ждёт 3 ч';

const post = (url: string, body: unknown) =>
  max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

const message = (text: string, opts: { chatType?: string; attachments?: unknown[] } = {}) => ({
  update_type: 'message_created',
  timestamp: 1,
  message: {
    sender: { user_id: ADMIN_USER, name: 'Админ' },
    recipient: { chat_id: ADMIN_CHAT, chat_type: opts.chatType ?? 'dialog' },
    body: { mid: 'm', seq: 1, text, attachments: opts.attachments ?? [] },
  },
});

const started = () => ({
  update_type: 'bot_started', timestamp: 1, chat_id: ADMIN_CHAT, payload: '', user: { user_id: ADMIN_USER, name: 'Админ' },
});

const repliesTo = (chatId: number) =>
  m.maxSend.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1]));

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.pool.mockResolvedValue({ rows: [] });
  m.findPartner.mockResolvedValue({ outcome: 'none' });
  m.findAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Админ <Тест>' });
  m.adminReply.mockResolvedValue({ text: PD_TEXT, pd: true });
  m.pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено в MAX' });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('администратор в MAX: опознание', () => {
  it('заверенный личный диалог — человек MAX ищется по user_id, а не по чату', async () => {
    await post(VERIFIED, message('брони'));
    expect(m.findAdmin).toHaveBeenCalledWith(ADMIN_USER);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('группа — база администраторов не спрашивается, отвечает обычный путь', async () => {
    await post(VERIFIED, message('брони', { chatType: 'chat' }));
    expect(m.findAdmin).not.toHaveBeenCalled();
    expect(m.adminReply).not.toHaveBeenCalled();
  });

  it('незаверенный апдейт (ключа нет) — администратора не узнают, брони не читаются', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    await post(UNVERIFIED, message('брони'));
    expect(m.findAdmin).not.toHaveBeenCalled();
    expect(m.adminReply).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({ verifiedOrigin: false }));
  });

  it('не администратор — обычный путь Кузьмича', async () => {
    m.findAdmin.mockResolvedValue({ outcome: 'none' });
    await post(VERIFIED, message('брони'));
    expect(m.adminReply).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'брони', verifiedOrigin: true }));
  });

  it('проверка не удалась — обычный путь, а не «вы не администратор»', async () => {
    m.findAdmin.mockResolvedValue({ outcome: 'unavailable' });
    await post(VERIFIED, message('брони'));
    expect(m.adminReply).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledTimes(1);
    expect(repliesTo(ADMIN_CHAT).join('\n')).not.toMatch(/администратор/i);
  });

  it('«Старт» администратора — своё приветствие с именем (экранированным), не туристское меню', async () => {
    await post(VERIFIED, started());
    const [hello] = repliesTo(ADMIN_CHAT);
    expect(hello).toContain('Вы подключены как администратор Ведара, Админ &lt;Тест&gt;');
    expect(hello).toContain(ADMIN_HELP_TEXT);
    expect(m.processMessage).not.toHaveBeenCalled();
  });
});

describe('администратор в MAX: ответы', () => {
  it('ответ с ПД — только через sendPdAlert строго в его чат, без Telegram', async () => {
    await post(VERIFIED, message('Покажи брони'));
    expect(m.adminReply).toHaveBeenCalledWith('bookings', undefined);
    expect(m.pdAlert).toHaveBeenCalledWith({
      text: PD_TEXT,
      stub: expect.any(String),
      buttons: expect.arrayContaining([expect.objectContaining({ payload: 'rm:ad:bk' })]),
      to: { maxChatId: ADMIN_CHAT, telegramChatId: null },
    });
    expect(m.pdAlert.mock.calls[0][0].stub).not.toMatch(/\+7|Турист/);
    expect(repliesTo(ADMIN_CHAT)).toEqual([]);
  });

  it('ПД не доставлены — он узнаёт об этом текстом без ПД', async () => {
    m.pdAlert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'MAX отказал' });
    await post(VERIFIED, message('заявки'));
    expect(repliesTo(ADMIN_CHAT)).toEqual([ADMIN_CHAT_TEXT.pdNotDelivered]);
    expect(errorLog.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toContain('+70000000001');
  });

  it('ответ без ПД — обычным сообщением, sendPdAlert не зовётся', async () => {
    m.adminReply.mockResolvedValue({ text: '<b>Сводка суток</b>', pd: false });
    await post(VERIFIED, message('сводка'));
    expect(m.adminReply).toHaveBeenCalledWith('summary', undefined);
    expect(m.pdAlert).not.toHaveBeenCalled();
    expect(repliesTo(ADMIN_CHAT)).toEqual(['<b>Сводка суток</b>']);
  });

  it('непонятое — подсказка, а не модель', async () => {
    await post(VERIFIED, message('как дела у вулкана'));
    expect(repliesTo(ADMIN_CHAT)).toEqual([ADMIN_CHAT_TEXT.notUnderstood]);
    expect(m.processMessage).not.toHaveBeenCalled();
    expect(m.adminReply).not.toHaveBeenCalled();
  });

  it('просьба туриста — Кузьмич туриста, не подсказка команд', async () => {
    await post(VERIFIED, message('найди мне в аренду автомобиль'));
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: ADMIN_CHAT, text: 'найди мне в аренду автомобиль', mode: 'max', verifiedOrigin: true,
    }));
    expect(m.adminReply).not.toHaveBeenCalled();
    expect(repliesTo(ADMIN_CHAT).join('\n')).not.toContain(ADMIN_CHAT_TEXT.notUnderstood);
  });

  it('«забронировать тур» — Кузьмич туриста, не сводка броней', async () => {
    await post(VERIFIED, message('хочу забронировать тур'));
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: ADMIN_CHAT, text: 'хочу забронировать тур', mode: 'max', verifiedOrigin: true,
    }));
    expect(m.adminReply).not.toHaveBeenCalled();
  });

  it('команда кабинета остаётся чтением администратора', async () => {
    await post(VERIFIED, message('Покажи брони'));
    expect(m.adminReply).toHaveBeenCalledWith('bookings', undefined);
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('номер без текста от администратора — не заявка и не модель', async () => {
    await post(VERIFIED, message('', { attachments: [{ type: 'contact', payload: { vcf_info: 'TEL:+79140000000' } }] }));
    expect(repliesTo(ADMIN_CHAT)).toEqual([ADMIN_CHAT_TEXT.textOnly]);
    expect(m.createLead).not.toHaveBeenCalled();
    expect(m.processMessage).not.toHaveBeenCalled();
  });
});

describe('команды администратора', () => {
  it('слова → команды; чужое — null', async () => {
    const { adminCommandOf } = await import('@/lib/max/admin-read');
    expect(adminCommandOf('/start')).toBe('help');
    expect(adminCommandOf('Что умеешь?')).toBe('help');
    expect(adminCommandOf('какие даты открыты?')).toBe('dates');
    expect(adminCommandOf('Брони')).toBe('bookings');
    expect(adminCommandOf('новые заявки')).toBe('leads');
    expect(adminCommandOf('сводка за сутки')).toBe('summary');
    expect(adminCommandOf('состояние платформы')).toBe('health');
    expect(adminCommandOf('привет')).toBeNull();
  });

  it('длинный список режется по пределу сообщения и называет остаток', async () => {
    const { fitLines, ADMIN_MAX_MESSAGE_CHARS } = await import('@/lib/max/admin-read');
    const lines = Array.from({ length: 200 }, (_, i) => `• строка ${i} ${'x'.repeat(40)}`);
    const out = fitLines(['шапка'], lines);
    expect(out.length).toBeLessThanOrEqual(ADMIN_MAX_MESSAGE_CHARS);
    expect(out).toMatch(/…и ещё \d+ — откройте админку\.$/);
  });
});

// ── /api/admin/max-link ─────────────────────────────────────────────────────

const route = await import('@/app/api/admin/max-link/route');
const req = (method: string) => new NextRequest('http://localhost/api/admin/max-link', { method });

describe('/api/admin/max-link', () => {
  it('без прав администратора — отказ до любого обращения к данным', async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    for (const [method, fn] of [['GET', route.GET], ['POST', route.POST], ['DELETE', route.DELETE]] as const) {
      const res = await fn(req(method));
      expect(res.status).toBe(403);
    }
    expect(m.issue).not.toHaveBeenCalled();
    expect(m.status).not.toHaveBeenCalled();
    expect(m.unbind).not.toHaveBeenCalled();
  });

  it('ссылка выдаётся вошедшему администратору и не кешируется', async () => {
    m.requireAdmin.mockResolvedValue({ userId: 'u-admin', email: 'a@b', role: 'admin' });
    m.issue.mockResolvedValue({ ok: true, link: 'https://max.ru/bot?start=adm_x', expiresAt: new Date('2026-10-23T10:10:00Z') });
    const res = await route.POST(req('POST'));
    expect(m.issue).toHaveBeenCalledWith('u-admin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      success: true, data: { link: 'https://max.ru/bot?start=adm_x', expires_at: '2026-10-23T10:10:00.000Z' },
    });
  });

  it('роль снята, пока шёл запрос, — 403 без ссылки', async () => {
    m.requireAdmin.mockResolvedValue({ userId: 'u-admin', email: 'a@b', role: 'admin' });
    m.issue.mockResolvedValue({ ok: false, reason: 'not_admin' });
    const res = await route.POST(req('POST'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('start=');
  });

  it('база не ответила — 500 с SQLSTATE в логе, а не «не подключён»', async () => {
    m.requireAdmin.mockResolvedValue({ userId: 'u-admin', email: 'a@b', role: 'admin' });
    m.status.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    const res = await route.GET(req('GET'));
    expect(res.status).toBe(500);
    expect(errorLog.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('57P01');
  });

  it('состояние и отключение — у вошедшего администратора', async () => {
    m.requireAdmin.mockResolvedValue({ userId: 'u-admin', email: 'a@b', role: 'admin' });
    m.status.mockResolvedValue({ bound: true, boundAt: '2026-10-23 10:00:00+00' });
    m.unbind.mockResolvedValue(true);
    expect(await (await route.GET(req('GET'))).json()).toEqual({
      success: true, data: { bound: true, bound_at: '2026-10-23 10:00:00+00' },
    });
    expect(await (await route.DELETE(req('DELETE'))).json()).toEqual({ success: true, data: { unbound: true } });
    expect(m.status).toHaveBeenCalledWith('u-admin');
    expect(m.unbind).toHaveBeenCalledWith('u-admin');
  });
});

// ── Кнопки меню роли (rm:) — нажатием, через вебхук ─────────────────────────

const STRANGER_USER = 502;
const OPERATOR = {
  partnerId: '33333333-3333-4333-8333-333333333333',
  partnerName: 'Тест-Оператор',
  slug: 'test-operator',
  category: 'operator',
  crmCategory: 'operator',
  userId: null,
};
const INBOX = {
  category: 'operator', items: [], failed: [], response: {}, chat: { state: 'none' }, not_here: [],
};

const roleTap = (
  payload: string,
  opts: { userId?: number | null; chatType?: string; noMessage?: boolean } = {},
) => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: {
    timestamp: 1,
    callback_id: 'cb-rm',
    payload,
    user: opts.userId === null ? { name: 'Без id' } : { user_id: opts.userId ?? ADMIN_USER, name: 'Админ' },
  },
  ...(opts.noMessage ? {} : {
    message: {
      recipient: { chat_id: ADMIN_CHAT, chat_type: opts.chatType ?? 'dialog' },
      body: { mid: 'm-menu', seq: 1, text: 'меню' },
    },
  }),
});

/** Ни одного чтения кабинета: ни броней администратора, ни входящих партнёра, ни ПД. */
function nothingRead() {
  expect(m.adminReply).not.toHaveBeenCalled();
  expect(m.loadInbox).not.toHaveBeenCalled();
  expect(m.pdAlert).not.toHaveBeenCalled();
}

describe('кнопки меню роли в MAX (rm:)', () => {
  beforeEach(() => {
    m.loadInbox.mockResolvedValue(INBOX);
  });

  it('незаверенный апдейт: «Брони» не выполняется, администратор не ищется', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    const { UNVERIFIED_CHAT_REPLY } = await import('@/lib/max/verified-press');
    await post(UNVERIFIED, roleTap('rm:ad:bk'));
    expect(m.findAdmin).not.toHaveBeenCalled();
    nothingRead();
    expect(repliesTo(ADMIN_CHAT)).toEqual([UNVERIFIED_CHAT_REPLY.partner]);
  });

  it('группа: «Брони» не выполняется, база администраторов не спрашивается', async () => {
    await post(VERIFIED, roleTap('rm:ad:bk', { chatType: 'chat' }));
    expect(m.findAdmin).not.toHaveBeenCalled();
    nothingRead();
    expect(repliesTo(ADMIN_CHAT)).toEqual(['Кнопки кабинета работают в личном диалоге.']);
  });

  it('нажал не администратор: право — по user_id нажавшего, отказ без чтения броней', async () => {
    m.findAdmin.mockImplementation(async (id: number) => (
      id === ADMIN_USER ? { outcome: 'admin', userId: 'u-admin', name: 'Админ' } : { outcome: 'none' }
    ));
    await post(VERIFIED, roleTap('rm:ad:bk', { userId: STRANGER_USER }));
    expect(m.findAdmin).toHaveBeenCalledWith(STRANGER_USER);
    expect(m.findAdmin).not.toHaveBeenCalledWith(ADMIN_CHAT);
    nothingRead();
    const { ADMIN_MAX_TEXT } = await import('@/lib/max/admin-link');
    expect(repliesTo(ADMIN_CHAT)).toEqual([ADMIN_MAX_TEXT.deny]);
  });

  it('MAX не назвал, кто нажал, — отказ, база не спрашивается', async () => {
    await post(VERIFIED, roleTap('rm:ad:ld', { userId: null }));
    expect(m.findAdmin).not.toHaveBeenCalled();
    nothingRead();
    const { ADMIN_MAX_TEXT } = await import('@/lib/max/admin-link');
    expect(repliesTo(ADMIN_CHAT)).toEqual([ADMIN_MAX_TEXT.deny]);
  });

  it('база не ответила — «роль не проверена», а не «не ваш кабинет»', async () => {
    m.findAdmin.mockResolvedValue({ outcome: 'unavailable' });
    await post(VERIFIED, roleTap('rm:ad:bk'));
    nothingRead();
    const { ADMIN_MAX_TEXT } = await import('@/lib/max/admin-link');
    const replies = repliesTo(ADMIN_CHAT);
    expect(replies).toEqual([ADMIN_MAX_TEXT.unchecked]);
    expect(replies.join('\n')).toContain('не проверена');
    expect(replies.join('\n')).not.toContain(ADMIN_MAX_TEXT.deny);
  });

  it('нажал администратор: брони с ПД — только через sendPdAlert в чат этого сообщения', async () => {
    await post(VERIFIED, roleTap('rm:ad:bk'));
    expect(m.findAdmin).toHaveBeenCalledWith(ADMIN_USER);
    expect(m.adminReply).toHaveBeenCalledWith('bookings', expect.any(Number));
    expect(m.pdAlert).toHaveBeenCalledTimes(1);
    expect(m.pdAlert).toHaveBeenCalledWith({
      text: PD_TEXT,
      stub: expect.any(String),
      buttons: expect.arrayContaining([expect.objectContaining({ payload: 'rm:ad:bk' })]),
      to: { maxChatId: ADMIN_CHAT, telegramChatId: null },
    });
    expect(m.pdAlert.mock.calls[0][0].stub).not.toMatch(/\+7|Турист/);
    // Обычным сообщением ПД не уходят.
    expect(repliesTo(ADMIN_CHAT).join('\n')).not.toContain('+70000000001');
  });

  it('ПД по кнопке не доставлены — текст без ПД в тот же чат', async () => {
    m.pdAlert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'MAX отказал' });
    await post(VERIFIED, roleTap('rm:ad:ld'));
    expect(m.adminReply).toHaveBeenCalledWith('leads', expect.any(Number));
    const replies = repliesTo(ADMIN_CHAT);
    expect(replies).toEqual([ADMIN_CHAT_TEXT.pdNotDelivered]);
    expect(replies.join('\n')).not.toContain('+70000000001');
  });

  it('«Входящие» оператора из чужого чата — отказ без чтения входящих', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'none' });
    await post(VERIFIED, roleTap('rm:op:in', { userId: STRANGER_USER }));
    expect(m.findPartner).toHaveBeenCalledWith('max', ADMIN_CHAT);
    nothingRead();
    expect(repliesTo(ADMIN_CHAT)).toEqual(['Эта кнопка — меню кабинета. В этом чате её не выполняю.']);
  });

  it('«Входящие» оператора в чате жилья — кнопка чужой роли не выполняется', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...OPERATOR, category: 'stay', crmCategory: 'stay' } });
    await post(VERIFIED, roleTap('rm:op:in'));
    nothingRead();
    expect(repliesTo(ADMIN_CHAT)).toEqual(['Эта кнопка — меню кабинета. В этом чате её не выполняю.']);
  });

  it('«Входящие» оператора: незаверенный апдейт и группа — чат не ищется, входящие не читаются', async () => {
    await post(VERIFIED, roleTap('rm:op:in', { chatType: 'chat' }));
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    await post(UNVERIFIED, roleTap('rm:op:in'));
    expect(m.findPartner).not.toHaveBeenCalled();
    nothingRead();
  });

  it('«Входящие» оператора: база не ответила — «не удалось проверить», без чтения', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'unavailable' });
    await post(VERIFIED, roleTap('rm:op:in'));
    nothingRead();
    expect(repliesTo(ADMIN_CHAT)).toEqual(['Не удалось проверить, чей это чат. Кнопку не выполнил.']);
  });

  it('«Входящие» в чате этого оператора — его входящие, со строкой его меню', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: OPERATOR });
    await post(VERIFIED, roleTap('rm:op:in'));
    expect(m.loadInbox).toHaveBeenCalledWith(OPERATOR.partnerId, 'operator', null, expect.any(Object));
    expect(m.findAdmin).not.toHaveBeenCalled();
    expect(m.pdAlert).not.toHaveBeenCalled();
    const call = m.maxSend.mock.calls.find((c) => c[0] === ADMIN_CHAT);
    expect(String(call?.[1])).toContain('Входящие');
    const buttons = JSON.stringify(call?.[2] ?? {});
    expect(buttons).toContain('rm:op:in');
    expect(buttons).not.toContain('rm:ad:');
  });
});
