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
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: vi.fn(), answerOnCallback: vi.fn() } }),
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
