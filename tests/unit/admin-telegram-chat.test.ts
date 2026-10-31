/**
 * Администратор в Telegram (слово владельца 24.10: «нет привязки админа к
 * Telegram») — вызовом, не поиском строк.
 *
 * Ссылка adt_ одноразовая, в базе только хеш. Привязан человек (from.id),
 * не чат. На каждом сообщении роль читается заново. Контакты туристов в
 * Telegram не уходят: канал telegram подменяет ответ с ПД. Группа таблицу
 * привязки не спрашивает. «Не смог проверить» кнопку не выполняет и не
 * говорит «вы не админ».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const USER = '11111111-1111-4111-8111-111111111111';
const ADMIN_TG = 880_001;
const LEGACY = 777;
const PD = 'Турист Т., +70000000001';

const m = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  tgSend: vi.fn(),
  answer: vi.fn(),
  aiChat: vi.fn(),
  processMessage: vi.fn(),
  adminReply: vi.fn(),
  requireAdmin: vi.fn(),
  botName: vi.fn(),
  pd: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => m.poolQuery(...a),
    connect: (...a: unknown[]) => m.poolConnect(...a),
  },
}));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: {
    sendMessage: (...a: unknown[]) => m.tgSend(...a),
    answerCallback: (...a: unknown[]) => m.answer(...a),
  },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({
  verifyWebhookSecret: () => 'ok',
  refuseUnconfiguredWebhook: vi.fn(),
}));
vi.mock('@/lib/telegram/bot-username', () => ({
  resolveTelegramBotUsername: (...a: unknown[]) => m.botName(...a),
  DEFAULT_BOT_USERNAME: 'kuzmichai_bot',
}));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => m.pd(...a) }));
vi.mock('@/lib/kuzmich/core', () => ({
  // Живого черновика заявки нет: развилка чата судится без него.
  hasLiveBookingFlow: vi.fn(async () => false),
  KUZMICH_SYSTEM: '',
  aiChat: (...a: unknown[]) => m.aiChat(...a),
  getHistory: vi.fn(),
  processMessage: (...a: unknown[]) => m.processMessage(...a),
  cleanupPending: vi.fn(),
  isBookingTrigger: () => false,
  buildTourContext: vi.fn(),
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: vi.fn(async () => ({ outcome: 'not_found' })),
  partnerGreeting: () => 'кабинет',
  processPartnerMessage: vi.fn(),
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
}));
vi.mock('@/lib/max/admin-read', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-read')>()),
  adminReplyFor: (...a: unknown[]) => m.adminReply(...a),
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => m.requireAdmin(...a) }));
vi.mock('@/lib/agents', () => ({ PlatformAgent: class {} }));

const webhook = await import('@/app/api/telegram/webhook/route');
const kuzmich = await import('@/app/api/telegram/kuzmich/route');
const linkRoute = await import('@/app/api/admin/telegram-link/route');

let updateId = 81_000;
let queryMode: 'none' | 'admin' | 'throw' = 'none';
const queries: string[] = [];

function webhookPost(text: string, opts: { chat?: number; type?: string; from?: number } = {}) {
  const chat = opts.chat ?? 4242;
  const from = opts.from ?? chat;
  return webhook.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: updateId++,
      message: {
        message_id: 1,
        from: { id: from, first_name: 'Анна' },
        chat: { id: chat, type: opts.type ?? 'private' },
        text,
      },
    }),
  }));
}

function webhookPress(data: string, from: number, type = 'private') {
  return webhook.POST(new NextRequest('http://localhost/api/telegram/webhook', {
    method: 'POST',
    body: JSON.stringify({
      update_id: updateId++,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: from },
        message: { chat: { id: from, type } },
        data,
      },
    }),
  }));
}

function kuzmichPost(body: unknown) {
  return kuzmich.POST(new NextRequest('http://localhost/api/telegram/kuzmich', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
}

function sentWebhook(): string[] {
  return m.tgSend.mock.calls.map((c) => String((c[0] as { text?: string }).text ?? ''));
}

function sentKuzmich(): string[] {
  return m.fetch.mock.calls
    .filter(([url]) => String(url).includes('/sendMessage'))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { text: string }).text);
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  queryMode = 'none';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_CHAT_ID', String(LEGACY));
  vi.stubEnv('TELEGRAM_OWNER_ID', '1');
  m.tgSend.mockResolvedValue({ success: true });
  m.answer.mockResolvedValue({});
  m.aiChat.mockResolvedValue(undefined);
  m.processMessage.mockResolvedValue(undefined);
  m.adminReply.mockResolvedValue({ text: PD, pd: true });
  m.botName.mockResolvedValue({ name: 'kuzmichai_bot', source: 'getMe', reason: null, env_mismatch: null });
  m.pd.mockResolvedValue({ delivered: true });
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', m.fetch);
  m.poolConnect.mockRejectedValue(new Error('connect не ожидался'));
  m.poolQuery.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    queries.push(q);
    if (queryMode === 'throw') throw Object.assign(new Error('db'), { code: '57P01' });
    if (q.includes('INSERT INTO admin_tg_link_tokens')) return { rows: [{ id: '9' }], rowCount: 1 };
    if (q.includes('admin_tg_bindings') && q.includes('user_id::text') && queryMode === 'admin') {
      return { rows: [{ user_id: USER, name: 'Анна' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ключ ссылки Telegram', () => {
  it('adt_ — наш ключ, adm_ и битый adt_ — не гасятся как чужой токен', async () => {
    const { adminTelegramTokenFromStart } = await import('@/lib/telegram/admin-link');
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(adminTelegramTokenFromStart(`adt_${token}`)).toBe(token);
    expect(adminTelegramTokenFromStart(`adm_${token}`)).toBeNull();
    expect(adminTelegramTokenFromStart('adt_short')).toBe('malformed');
  });

  it('выдача кладёт в базу хеш, не ключ, и собирает t.me', async () => {
    const { issueAdminTelegramLink } = await import('@/lib/telegram/admin-link');
    const { ownsAdminSql, hashAdminLinkToken } = await import('@/lib/max/admin-link');
    const issued = await issueAdminTelegramLink(USER, 'kuzmichai_bot', { query: m.poolQuery }, new Date('2026-10-24T00:00:00Z'), () => Buffer.from('0123456789abcdef01234567'));
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const arg = new URL(issued.link).searchParams.get('start') ?? '';
    expect(issued.link.startsWith('https://t.me/kuzmichai_bot?start=adt_')).toBe(true);
    expect(arg).toMatch(/^adt_[A-Za-z0-9_-]{32}$/);
    const sql = String(m.poolQuery.mock.calls[0]?.[0]);
    const params = m.poolQuery.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain(ownsAdminSql('u'));
    expect(sql).toContain('admin_tg_link_tokens');
    expect(params[1]).toBe(hashAdminLinkToken(arg.slice(4)));
    expect(JSON.stringify(params)).not.toContain(arg.slice(4));
  });

  it('не администратор — ссылки нет; имя бота не username — ссылку не собирает и базу не трогает', async () => {
    const { issueAdminTelegramLink } = await import('@/lib/telegram/admin-link');
    m.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await issueAdminTelegramLink(USER, 'kuzmichai_bot', { query: m.poolQuery })).toEqual({ ok: false, reason: 'not_admin' });
    m.poolQuery.mockClear();
    expect(await issueAdminTelegramLink(USER, 'не бот', { query: m.poolQuery })).toEqual({ ok: false, reason: 'bot_name' });
    expect(m.poolQuery).not.toHaveBeenCalled();
  });
});

describe('погашение ссылки', () => {
  function client(steps: Array<{ rows?: unknown[]; rowCount?: number }>) {
    const seen: string[] = [];
    let i = 0;
    return {
      seen,
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        seen.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        const step = steps[i++];
        if (!step) throw new Error(`лишний запрос: ${sql}`);
        return { rows: step.rows ?? [], rowCount: step.rowCount ?? (step.rows?.length ?? 0) };
      }),
    };
  }

  it('нет строки — invalid, транзакция откатывается', async () => {
    const { consumeAdminTelegramLink } = await import('@/lib/telegram/admin-link');
    const c = client([{ rows: [] }]);
    const res = await consumeAdminTelegramLink('a'.repeat(32), ADMIN_TG, async () => c);
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    expect(c.seen).toContain('ROLLBACK');
    expect(c.release).toHaveBeenCalled();
  });

  it('роль уже снята — ссылка погашена, привязки нет', async () => {
    const { consumeAdminTelegramLink } = await import('@/lib/telegram/admin-link');
    const c = client([
      { rows: [{ id: '4', user_id: USER, expired: false, used: false }] },
      { rowCount: 1 },
      { rowCount: 0 },
    ]);
    const res = await consumeAdminTelegramLink('b'.repeat(32), ADMIN_TG, async () => c);
    expect(res).toEqual({ ok: false, reason: 'not_admin' });
    expect(c.seen).toContain('COMMIT');
    expect(c.seen.join('\n')).not.toContain('INSERT INTO admin_tg_bindings');
  });

  it('человек другого администратора переходит к выдавшему ссылку', async () => {
    const { consumeAdminTelegramLink } = await import('@/lib/telegram/admin-link');
    const c = client([
      { rows: [{ id: '4', user_id: USER, expired: false, used: false }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [{ user_id: '22222222-2222-4222-8222-222222222222' }] },
      { rowCount: 1 },
    ]);
    const res = await consumeAdminTelegramLink('c'.repeat(32), ADMIN_TG, async () => c);
    expect(res).toEqual({
      ok: true,
      userId: USER,
      movedFromUserId: '22222222-2222-4222-8222-222222222222',
    });
    expect(c.seen.some((sql) => sql.includes('ON CONFLICT (user_id)'))).toBe(true);
    expect(c.seen).toContain('COMMIT');
  });

  it('id группы ссылку не гасит', async () => {
    const { consumeAdminTelegramLink } = await import('@/lib/telegram/admin-link');
    const connect = vi.fn();
    expect(await consumeAdminTelegramLink('d'.repeat(32), -100, connect)).toEqual({ ok: false, reason: 'invalid' });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('вебхук: кабинет администратора', () => {
  it('«Покажи брони» привязанного — меню, без телефона и без sendPdAlert', async () => {
    queryMode = 'admin';
    const res = await webhookPost('Покажи брони', { from: ADMIN_TG, chat: ADMIN_TG });
    expect(await res.json()).toEqual({ ok: true });
    const text = sentWebhook().join('\n');
    expect(text).toContain('Контакты туристов в этом списке есть только в MAX');
    expect(text).not.toContain('+70000000001');
    expect(text).not.toContain(PD);
    expect(m.pd).not.toHaveBeenCalled();
    expect(m.aiChat).not.toHaveBeenCalled();
    const markup = m.tgSend.mock.calls.at(-1)?.[0] as { replyMarkup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    // Шесть кнопок — два ряда по три (31.10: больше трёх в ряд подписи режутся).
    expect(markup.replyMarkup?.inline_keyboard.map((r) => r.map((b) => b.callback_data))).toEqual(
      [['rm:ad:dt', 'rm:ad:bk', 'rm:ad:ld'], ['rm:ad:sm', 'rm:ad:hl', 'rm:ad:hp']],
    );
  });

  it('«хочу забронировать тур» — Кузьмич туриста, не список броней', async () => {
    queryMode = 'admin';
    await webhookPost('хочу забронировать тур', { from: ADMIN_TG, chat: ADMIN_TG });
    expect(m.aiChat).toHaveBeenCalled();
    expect(m.adminReply).not.toHaveBeenCalled();
    expect(sentWebhook().join('\n')).not.toContain('только в MAX');
  });

  it('непонятое — справка кабинета, не модель', async () => {
    queryMode = 'admin';
    await webhookPost('как дела у вулкана', { from: ADMIN_TG, chat: ADMIN_TG });
    expect(m.aiChat).not.toHaveBeenCalled();
    expect(sentWebhook().join('\n')).toContain('Кабинет администратора');
  });

  it('владелец консоли TELEGRAM_CHAT_ID с привязкой adt_ — /leads отвечает консоль, а не «Не понял команду» (25.10)', async () => {
    queryMode = 'admin';
    await webhookPost('/leads', { from: LEGACY, chat: LEGACY });
    const text = sentWebhook().join('\n');
    expect(text).not.toContain('Не понял команду');
    expect(text).not.toContain('Кабинет администратора');
    // Ответила консоль (getLastLeads): кабинет чтения таблицу привязки для
    // этого текста не спрашивал.
    expect(text).toContain('Заявок пока нет.');
    expect(queries.some((q) => q.includes('admin_tg_bindings'))).toBe(false);
  });

  it('владелец консоли гасит ссылку adt_ — до него ссылка доходит', async () => {
    await webhookPost('/start adt_short', { from: LEGACY, chat: LEGACY });
    expect(sentWebhook().join('\n')).toContain('повреждена');
  });

  it('группа таблицу привязки не спрашивает', async () => {
    queryMode = 'throw';
    await webhookPost('привет всем', { type: 'group', chat: -100, from: ADMIN_TG });
    expect(queries.some((q) => q.includes('admin_tg_'))).toBe(false);
    expect(m.adminReply).not.toHaveBeenCalled();
  });

  it('битая ссылка adt_ — отказ, базу ключей не открывает', async () => {
    await webhookPost('/start adt_short', { from: ADMIN_TG, chat: ADMIN_TG });
    expect(sentWebhook().join('\n')).toContain('повреждена');
    expect(m.poolConnect).not.toHaveBeenCalled();
  });

  it('кнопка при отказе базы — «не проверена», не «не админ»', async () => {
    queryMode = 'throw';
    await webhookPress('rm:ad:bk', 4242);
    expect(sentWebhook().join('\n')).toContain('Роль администратора не проверена');
    expect(sentWebhook().join('\n')).not.toContain('В этом чате её не выполняю');
    expect(m.adminReply).not.toHaveBeenCalled();
  });

  it('кнопка чата TELEGRAM_CHAT_ID без привязки всё ещё открывает чтение', async () => {
    m.adminReply.mockResolvedValue({ text: 'открытые даты', pd: false });
    await webhookPress('rm:ad:dt', LEGACY);
    expect(sentWebhook().join('\n')).toContain('открытые даты');
  });

  it('кнопка чужого чата не выполняется', async () => {
    await webhookPress('rm:ad:bk', 4242);
    expect(sentWebhook().join('\n')).toContain('В этом чате её не выполняю');
    expect(m.adminReply).not.toHaveBeenCalled();
  });

  it('кнопка в группе базу не спрашивает', async () => {
    queryMode = 'throw';
    await webhookPress('rm:ad:bk', ADMIN_TG, 'group');
    expect(queries.some((q) => q.includes('admin_tg_'))).toBe(false);
    expect(sentWebhook().join('\n')).toContain('личном диалоге');
  });
});

describe('вторая дверь Кузьмича понимает ту же привязку', () => {
  it('«Покажи брони» — без телефона, с меню', async () => {
    queryMode = 'admin';
    const res = await kuzmichPost({
      update_id: updateId++,
      message: {
        message_id: 1,
        from: { id: ADMIN_TG, first_name: 'Анна' },
        chat: { id: ADMIN_TG, type: 'private' },
        text: 'Покажи брони',
      },
    });
    expect(res.status).toBe(200);
    const text = sentKuzmich().join('\n');
    expect(text).toContain('Контакты туристов в этом списке есть только в MAX');
    expect(text).not.toContain('+70000000001');
    expect(m.processMessage).not.toHaveBeenCalled();
    const init = m.fetch.mock.calls.find(([url]) => String(url).includes('/sendMessage'))?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    expect(body.reply_markup.inline_keyboard[0]?.map((b) => b.callback_data)).toContain('rm:ad:bk');
  });

  it('фото привязанного — не модель и не заявка', async () => {
    queryMode = 'admin';
    await kuzmichPost({
      update_id: updateId++,
      message: {
        message_id: 1,
        from: { id: ADMIN_TG, first_name: 'Анна' },
        chat: { id: ADMIN_TG, type: 'private' },
        photo: [{ file_id: 'ph', width: 10, height: 10 }],
      },
    });
    expect(sentKuzmich().join('\n')).toContain('только текст');
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('роль не проверена — обычный ответ туриста, не «вы не администратор»', async () => {
    queryMode = 'throw';
    await kuzmichPost({
      update_id: updateId++,
      message: {
        message_id: 1,
        from: { id: ADMIN_TG, first_name: 'Анна' },
        chat: { id: ADMIN_TG, type: 'private' },
        text: 'когда сезон на Авачинский',
      },
    });
    expect(m.processMessage).toHaveBeenCalled();
    expect(sentKuzmich().join('\n')).not.toContain('не администратор');
  });

  it('группа не спрашивает привязку', async () => {
    queryMode = 'throw';
    await kuzmichPost({
      update_id: updateId++,
      message: {
        message_id: 1,
        from: { id: ADMIN_TG, first_name: 'Анна' },
        chat: { id: -200, type: 'group', title: 'Группа' },
        text: 'ок',
      },
    });
    expect(queries.some((q) => q.includes('admin_tg_'))).toBe(false);
  });
});

describe('снятие роли закрывает и Telegram', () => {
  it('одна команда стирает привязки MAX и Telegram', async () => {
    const { applyAdminRoleChange } = await import('@/lib/auth/admin-role-change');
    const seen: string[] = [];
    const db = {
      query: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('SELECT role')) {
          return { rows: [{ role: 'admin', preferences: { roles: ['admin'] } }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const res = await applyAdminRoleChange(db, USER, 'tourist', USER);
    expect(res?.ownedAdminBefore).toBe(true);
    const wipe = seen.find((sql) => sql.includes('admin_tg_bindings'));
    expect(wipe).toContain('admin_max_bindings');
    expect(wipe).toContain('admin_tg_link_tokens');
  });
});

describe('/api/admin/telegram-link', () => {
  const req = (method: string) => new NextRequest('http://localhost/api/admin/telegram-link', { method });

  it('без прав — отказ до базы', async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    for (const [method, fn] of [['GET', linkRoute.GET], ['POST', linkRoute.POST], ['DELETE', linkRoute.DELETE]] as const) {
      const res = await fn(req(method));
      expect(res.status).toBe(403);
    }
    expect(m.poolQuery).not.toHaveBeenCalled();
    expect(m.botName).not.toHaveBeenCalled();
  });

  it('ссылка не кешируется и называет источник имени бота', async () => {
    m.requireAdmin.mockResolvedValue({ userId: USER, email: 'a@b.c', role: 'admin' });
    m.botName.mockResolvedValue({ name: 'kuzmichai_bot', source: 'env', reason: 'getMe не ответил', env_mismatch: null });
    const res = await linkRoute.POST(req('POST'));
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as { success: boolean; data: { link: string; bot_source: string; bot_reason: string } };
    expect(body.success).toBe(true);
    expect(body.data.link).toMatch(/^https:\/\/t\.me\/kuzmichai_bot\?start=adt_[A-Za-z0-9_-]{32}$/);
    expect(body.data.bot_source).toBe('env');
    expect(body.data.bot_reason).toBe('getMe не ответил');
    expect(queries.join('\n')).not.toContain(body.data.link.split('adt_')[1] ?? 'нет');
  });

  it('база не ответила — 500 и SQLSTATE в логе, не «не подключён»', async () => {
    m.requireAdmin.mockResolvedValue({ userId: USER, email: 'a@b.c', role: 'admin' });
    queryMode = 'throw';
    const res = await linkRoute.GET(req('GET'));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).not.toContain('не подключён');
    expect(vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('57P01');
  });
});
