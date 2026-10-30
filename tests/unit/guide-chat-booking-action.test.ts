/**
 * Бронь своего тура кнопкой в чате гида (29.10, шаг 6 плана «гид в
 * мессенджере»): вопрос `bk:`, затем «Да» / «Не надо» `oc:` — как в разделе
 * «Свои туры» на сайте. Правило смены статуса одно — changeOwnerBookingStatus.
 *
 * Что держит — вызовом живых входов (POST /api/max/kuzmich,
 * POST /api/telegram/webhook) и функций; подменены база (поддельная таблица
 * partner_chat_actions на тех же запросах), правило смены статуса и транспорт:
 *  - чужая бронь — «не найдена»; гид команды, туроператор, карточка без
 *    аккаунта, привязка без записанного человека, нажал не тот, групповой чат
 *    — у каждого свой отказ, и ничего не записано;
 *  - незаверенное нажатие в MAX — «не засчитано», ничего не записано;
 *  - до «Да» бронь не меняется; повтор «Да» — прежний итог, правило зовётся
 *    один раз; исход письма назван словами, «нет почты» — тоже;
 *  - «Отклонить» без причины не исполняется; «отмена» гасит ожидание; беда в
 *    тексте причины — блок 112 над вопросом;
 *  - кнопки «Подтвердить» / «Отклонить» стоят под «Бронями», под ждущими
 *    бронями «Входящих» и под личным уведомлением о новой брони гиду — и не
 *    стоят у туроператора;
 *  - вопрос и итог не называют ни имени, ни телефона туриста.
 * Атомарность захвата, истёкший вопрос, CHECK таблицы и чужая карточка чата —
 * на настоящем PostgreSQL (tests/integration/tourist-cabinet.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { OwnBooking } from '@/lib/guides/own-tours';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  findPartner: vi.fn(),
  findAdmin: vi.fn(),
  processMessage: vi.fn(),
  processPartner: vi.fn(),
  change: vi.fn(),
  pdAlert: vi.fn(),
  bookings: vi.fn(),
  inbox: vi.fn(),
  tgSend: vi.fn(),
  team: vi.fn(),
}));

/** Поддельная база: только запросы, которыми ходит lib/bookings/chat-owner-action. */
interface FakeRow {
  id: string; partner_id: string; channel: string; chat_id: string; subject_kind: string; subject_id: string;
  action: string; reason: string | null; status: string; outcome: unknown; expired: boolean;
}
const db = vi.hoisted(() => ({
  owner: '601' as string | null,
  booking: null as null | { id: string; status: string; date: string; participants: number; title: string; partner: string },
  rows: [] as FakeRow[],
  seq: 0,
  writes: [] as string[],
}));

function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const p = params.map((x) => (x === null || x === undefined ? x : String(x)));
  const res = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return res([]);
  if (/INSERT|UPDATE|DELETE/i.test(sql) && /partner_chat_actions/.test(sql)) db.writes.push(sql);
  if (/owner_user_id::text AS owner/.test(sql)) return res([{ owner: db.owner }]);
  if (/FROM operator_bookings b\s+JOIN operator_tours t/.test(sql)) {
    const b = db.booking;
    return res(b && b.id === p[0] && b.partner === p[1] ? [b] : []);
  }
  if (/SET status = 'superseded'/.test(sql)) {
    for (const r of db.rows) if (r.channel === p[0] && r.chat_id === p[1] && ['awaiting_reason', 'ready'].includes(r.status)) r.status = 'superseded';
    return res([]);
  }
  if (/INSERT INTO partner_chat_actions/.test(sql)) {
    const id = `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
    db.rows.push({ id, partner_id: p[0]!, channel: p[1]!, chat_id: p[2]!, subject_kind: p[3]!, subject_id: p[4]!, action: p[5]!, reason: null, status: p[6]!, outcome: null, expired: false });
    return res([{ id }]);
  }
  const mine = (r: FakeRow) => r.id === p[0] && r.channel === p[1] && r.chat_id === p[2] && r.partner_id === p[3];
  if (/SET status = 'cancelled'\s+WHERE id = \$1::uuid AND channel/.test(sql)) {
    const r = db.rows.find((x) => mine(x) && ['awaiting_reason', 'ready'].includes(x.status));
    if (!r) return res([]);
    r.status = 'cancelled';
    return res([{ subject_kind: r.subject_kind, subject_id: r.subject_id }]);
  }
  if (/SET status = 'running'/.test(sql)) {
    const r = db.rows.find((x) => mine(x) && x.status === 'ready' && !x.expired);
    if (!r) return res([]);
    r.status = 'running';
    return res([{ subject_kind: r.subject_kind, subject_id: r.subject_id, action: r.action, reason: r.reason }]);
  }
  if (/SELECT status, subject_kind, subject_id, outcome/.test(sql)) {
    const r = db.rows.find(mine);
    return res(r ? [{ status: r.status, subject_kind: r.subject_kind, subject_id: r.subject_id, outcome: r.outcome, expired: r.expired, stale: false }] : []);
  }
  if (/SET status = \$2, outcome = \$3::jsonb/.test(sql)) {
    const r = db.rows.find((x) => x.id === p[0] && x.status === 'running');
    if (!r) return res([], 0);
    r.status = p[1]!;
    r.outcome = JSON.parse(p[2]!);
    return res([], 1);
  }
  if (/SELECT id::text AS id, subject_id FROM partner_chat_actions/.test(sql)) {
    const r = db.rows.find((x) => x.channel === p[0] && x.chat_id === p[1] && x.partner_id === p[2] && x.status === 'awaiting_reason' && !x.expired);
    return res(r ? [{ id: r.id, subject_id: r.subject_id }] : []);
  }
  if (/SET status = 'cancelled' WHERE id = \$1::uuid AND status = 'awaiting_reason'/.test(sql)) {
    const r = db.rows.find((x) => x.id === p[0] && x.status === 'awaiting_reason');
    if (r) r.status = 'cancelled';
    return res([], r ? 1 : 0);
  }
  if (/SET reason = \$2, status = 'ready'/.test(sql)) {
    const r = db.rows.find((x) => x.id === p[0] && x.status === 'awaiting_reason' && !x.expired);
    if (!r) return res([], 0);
    r.reason = p[1]!;
    r.status = 'ready';
    return res([], 1);
  }
  if (/SELECT 1 FROM partner_chat_actions/.test(sql)) {
    return res(db.rows.some((x) => x.channel === p[0] && x.chat_id === p[1] && x.status === 'awaiting_reason' && !x.expired) ? [{}] : []);
  }
  return res([]);
}

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: m.maxSendUser, answerOnCallback: vi.fn(async () => ({})) } }),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string, params?: unknown[]) => fakeQuery(sql, params),
    connect: async () => ({ query: async (sql: string, params?: unknown[]) => fakeQuery(sql, params), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({ query: async () => ({ rows: [] }) }));
vi.mock('@/lib/kuzmich/core', () => ({ hasLiveBookingFlow: vi.fn(async () => false), processMessage: m.processMessage, cleanupPending: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/operator-chat')>()),
  findPartnerByChat: m.findPartner,
  processPartnerMessage: m.processPartner,
}));
vi.mock('@/lib/max/admin-link', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: m.findAdmin,
}));
vi.mock('@/lib/bookings/owner-status', () => ({ changeOwnerBookingStatus: m.change }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: m.pdAlert }));
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeam: m.team }));
vi.mock('@/lib/guides/own-tours', async (orig) => ({
  ...(await orig<typeof import('@/lib/guides/own-tours')>()),
  loadOwnBookings: m.bookings,
}));
vi.mock('@/lib/crm/inbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/inbox')>()),
  loadInbox: m.inbox,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'test_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));

const { OWNER_ACTION_TEXT, awaitsOwnerReason } = await import('@/lib/bookings/chat-owner-action');
const press = await import('@/lib/bookings/chat-owner-press');
const { pressActionOf, UNVERIFIED_PRESS_REPLY, PRESS_WITHOUT_MESSAGE_REPLY } = await import('@/lib/max/verified-press');
const screens = await import('@/lib/guides/chat-screens');
const { roleMenuScreen } = await import('@/lib/roles/role-screen');
const { adminChatYieldsToPartner } = await import('@/lib/roles/admin-partner-chat');
const { notifyNewBooking } = await import('@/lib/notifications/operator-booking');
const { withSosBlock } = await import('@/lib/safety/sos-detector');
const max = await import('@/app/api/max/kuzmich/route');
const telegram = await import('@/app/api/telegram/webhook/route');
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

// ── Данные: выдуманные турист, тур и гид ────────────────────────────────────

const NAME = 'Турист Пробный';
const PHONE = '+70000000077';
const EMAIL = 'pd-probe@example.com';
const PD = [NAME, PHONE, '0000000077', EMAIL];
/** 29.10 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 9, 29, 0, 0);

const SELLER = {
  partnerId: '44444444-4444-4444-8444-444444444444',
  partnerName: 'Гид-продавец',
  slug: 'guide-seller',
  category: 'guide',
  crmCategory: 'guide',
  userId: '55555555-5555-4555-8555-555555555555',
  sellsTours: true,
};
const GUIDE_USER = 601;
const GUIDE_CHAT = 9_601;
const TG_CHAT = 7_601;
const KEY = 'test-webhook-key-29-10-bk';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const UNVERIFIED = 'http://localhost/api/max/kuzmich';

function bk(over: Partial<OwnBooking>): OwnBooking {
  return {
    id: '501', tour_id: '77', tour_title: 'Пещеры <Камчатки>', booking_date: '2026-11-05', participants: 2,
    booking_status: 'new', tourist_name: NAME, tourist_phone: PHONE, tourist_email: EMAIL,
    special_requests: null, created_at: '2026-10-28 10:00:00+12', ...over,
  };
}

const noPd = (text: string) => { for (const v of PD) expect(text).not.toContain(v); };

const postMax = (url: string, body: unknown) =>
  max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

let midSeq = 0;
const tap = (payload: string, chatType = 'dialog', withMessage = true) => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: `cb-${++midSeq}`, payload, user: { user_id: GUIDE_USER, name: 'Гид' } },
  ...(withMessage ? { message: { recipient: { chat_id: GUIDE_CHAT, chat_type: chatType }, body: { mid: `m-tap-${midSeq}`, seq: 1, text: 'брони' } } } : {}),
});
const said = (text: string) => ({
  update_type: 'message_created',
  timestamp: 1,
  message: {
    sender: { user_id: GUIDE_USER, name: 'Гид' },
    recipient: { chat_id: GUIDE_CHAT, chat_type: 'dialog' },
    body: { mid: `m-said-${++midSeq}`, seq: 1, text, attachments: [] },
  },
});

/** Ответы бота в чат гида: текст и payload кнопок. */
const maxReplies = () => m.maxSend.mock.calls.filter((c) => c[0] === GUIDE_CHAT).map((c) => ({
  text: String(c[1]),
  payloads: ((c[2] as { attachments?: Array<{ payload: { buttons: Array<Array<{ payload?: string }>> } }> } | undefined)
    ?.attachments?.[0]?.payload.buttons ?? []).flat().map((b) => b.payload ?? ''),
}));
const lastMax = () => maxReplies().at(-1) ?? { text: '', payloads: [] };
const idFrom = (payloads: string[], prefix: string) => {
  const p = payloads.find((x) => x.startsWith(prefix));
  if (!p) throw new Error(`нет кнопки ${prefix} среди ${payloads.join(', ')}`);
  return p.slice(prefix.length);
};

let updateId = 61_000;
const postTg = (body: Record<string, unknown>) => telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
  method: 'POST',
  body: JSON.stringify({ update_id: updateId++, ...body }),
}));
const tgTap = (data: string, type = 'private') => postTg({
  callback_query: { id: `cb-${updateId}`, from: { id: TG_CHAT }, message: { chat: { id: TG_CHAT, type } }, data },
});
const tgSay = (text: string) => postTg({
  message: { message_id: updateId, from: { id: TG_CHAT, first_name: 'Гид' }, chat: { id: TG_CHAT, type: 'private' }, text },
});
type TgMessage = { chatId: string; text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
const tgSent = () => m.tgSend.mock.calls.map((c) => c[0] as TgMessage).filter((x) => x.chatId === String(TG_CHAT));

const actionWrites = () => db.writes.length;

beforeEach(() => {
  clearMaxMessageDedup();
  for (const f of Object.values(m)) f.mockReset();
  db.owner = String(GUIDE_USER);
  db.booking = { id: '501', status: 'new', date: '2026-11-05', participants: 2, title: 'Пещеры <Камчатки>', partner: SELLER.partnerId };
  db.rows = [];
  db.writes = [];
  m.maxSend.mockResolvedValue({});
  m.findPartner.mockResolvedValue({ outcome: 'found', partner: SELLER });
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.change.mockResolvedValue({ kind: 'ok', changed: true, data: { booking_status: 'confirmed' }, touristNotice: 'sent' });
  m.pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено в MAX' });
  m.bookings.mockResolvedValue([bk({})]);
  m.tgSend.mockResolvedValue({ success: true });
  m.team.mockResolvedValue({ state: 'none' });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tg-test-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// ── Форма кнопок ────────────────────────────────────────────────────────────

describe('форма кнопок брони', () => {
  it('каждая кнопка, которую ставят экраны и уведомление, — действие MAX «owner» (только по заверенному апдейту) и разбирается обратно', () => {
    const payloads = [
      ...press.bookingAnswerButtons('7001'), ...press.bookingOutcomeButtons('7001'),
    ].map((b) => b.payload);
    payloads.push(press.answerPressPayload(true, '00000000-0000-4000-8000-000000000001'));
    payloads.push(press.answerPressPayload(false, '00000000-0000-4000-8000-000000000001'));
    expect(payloads).toEqual([
      'bk:c:7001', 'bk:x:7001', 'bk:d:7001', 'bk:n:7001',
      'oc:y:00000000-0000-4000-8000-000000000001', 'oc:x:00000000-0000-4000-8000-000000000001',
    ]);
    for (const p of payloads) {
      expect(pressActionOf(p), p).toBe('owner');
      expect(press.parseOwnerPress(p), p).not.toBeNull();
      // Telegram: callback_data не длиннее 64 байт.
      expect(Buffer.byteLength(p), p).toBeLessThanOrEqual(64);
    }
    for (const bad of ['bk:q:7001', 'bk:c:abc', 'bk:c:', 'oc:y:not-a-uuid', 'oc:z:00000000-0000-4000-8000-000000000001']) {
      expect(press.parseOwnerPress(bad), bad).toBeNull();
    }
  });

  it('кнопки включены гиду со своими турами; туроператору и гиду команды — нет', () => {
    expect(press.chatActionsEnabledFor({ category: 'guide', sellsTours: true })).toBe(true);
    expect(press.chatActionsEnabledFor({ category: 'guide', sellsTours: false })).toBe(false);
    expect(press.chatActionsEnabledFor({ category: 'operator', sellsTours: true })).toBe(false);
    expect(press.chatActionsEnabledFor({ category: 'stay', sellsTours: true })).toBe(false);
  });
});

// ── Кто вправе ──────────────────────────────────────────────────────────────

describe('MAX: кто вправе нажать', () => {
  it('чужая бронь — «не найдена», строки нет', async () => {
    db.booking = null;
    await postMax(VERIFIED, tap('bk:c:777'));
    expect(lastMax().text).toBe('Бронь №777 не найдена среди ваших туров — ничего не изменено.');
    expect(actionWrites()).toBe(0);
    expect(m.change).not.toHaveBeenCalled();
  });

  const REFUSALS: Array<{ name: string; setup: () => void; text: string; chatType?: string }> = [
    { name: 'групповой чат', setup: () => undefined, text: OWNER_ACTION_TEXT.notDialog, chatType: 'chat' },
    { name: 'гид команды без своих туров', setup: () => m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, sellsTours: false } }), text: OWNER_ACTION_TEXT.notThis },
    { name: 'туроператор', setup: () => m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, category: 'operator', crmCategory: 'operator' } }), text: OWNER_ACTION_TEXT.operatorNotYet },
    { name: 'карточка без аккаунта', setup: () => m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, userId: null } }), text: OWNER_ACTION_TEXT.noAccount },
    { name: 'привязка без записанного человека', setup: () => { db.owner = null; }, text: OWNER_ACTION_TEXT.noBindOwner },
    { name: 'нажал не тот, кто подключил чат', setup: () => { db.owner = '999'; }, text: OWNER_ACTION_TEXT.notOwner },
    { name: 'не смогли проверить карточку чата', setup: () => m.findPartner.mockResolvedValue({ outcome: 'unavailable' }), text: OWNER_ACTION_TEXT.unchecked },
    { name: 'чат не кабинет', setup: () => m.findPartner.mockResolvedValue({ outcome: 'none' }), text: OWNER_ACTION_TEXT.notThis },
  ];
  for (const r of REFUSALS) {
    it(`${r.name}: свой отказ, ничего не записано — ни вопросом, ни «Да»`, async () => {
      r.setup();
      for (const payload of ['bk:c:501', 'bk:x:501', 'oc:y:00000000-0000-4000-8000-000000000009']) {
        m.maxSend.mockClear();
        await postMax(VERIFIED, tap(payload, r.chatType));
        expect(lastMax().text, payload).toBe(r.text);
      }
      expect(actionWrites()).toBe(0);
      expect(m.change).not.toHaveBeenCalled();
    });
  }

  it('незаверенное нажатие — «не засчитано», карточка не читается, ничего не записано', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    await postMax(UNVERIFIED, tap('bk:c:501'));
    await postMax(UNVERIFIED, tap('oc:y:00000000-0000-4000-8000-000000000009'));
    expect(maxReplies().map((x) => x.text)).toEqual([UNVERIFIED_PRESS_REPLY.owner, UNVERIFIED_PRESS_REPLY.owner]);
    expect(m.findPartner).not.toHaveBeenCalled();
    expect(actionWrites()).toBe(0);
    expect(m.change).not.toHaveBeenCalled();
  });

  it('нажатие без сообщения — не применено, нажавший узнаёт об этом лично', async () => {
    await postMax(VERIFIED, tap('bk:c:501', 'dialog', false));
    expect(m.maxSendUser.mock.calls.map((c) => c[1])).toEqual([PRESS_WITHOUT_MESSAGE_REPLY.owner]);
    expect(actionWrites()).toBe(0);
  });
});

// ── Два шага ────────────────────────────────────────────────────────────────

describe('MAX: вопрос, затем «Да»', () => {
  it('подтверждение: вопрос без ПД, до «Да» бронь не меняется; «Да» — правило с каналом; повтор — прежний итог, правило один раз', async () => {
    await postMax(VERIFIED, tap('bk:c:501'));
    const q = lastMax();
    expect(q.text).toBe('Подтвердить бронь №501 («Пещеры &lt;Камчатки&gt;», 05.11, 2 чел)? Туристу уйдёт письмо, что бронь подтверждена.');
    noPd(q.text);
    expect(m.change).not.toHaveBeenCalled();
    const id = idFrom(q.payloads, 'oc:y:');
    expect(q.payloads).toEqual([`oc:y:${id}`, `oc:x:${id}`, 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);

    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(m.change).toHaveBeenCalledTimes(1);
    expect(m.change).toHaveBeenCalledWith({
      ownerPartnerId: SELLER.partnerId, actorUserId: SELLER.userId, bookingId: '501',
      input: { booking_status: 'confirmed' }, via: 'max',
    });
    expect(lastMax().text).toBe('Бронь №501 подтверждена. Туристу ушло письмо.');

    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(m.change).toHaveBeenCalledTimes(1);
    expect(lastMax().text).toBe('Уже нажато раньше. Бронь №501 подтверждена. Туристу ушло письмо.');
  });

  it('у брони нет почты — так и сказано; повтор того же статуса — «уже», а не «подтверждена»', async () => {
    m.change.mockResolvedValueOnce({ kind: 'ok', changed: true, data: { booking_status: 'confirmed' }, touristNotice: 'no_email' });
    await postMax(VERIFIED, tap('bk:c:501'));
    await postMax(VERIFIED, tap(`oc:y:${idFrom(lastMax().payloads, 'oc:y:')}`));
    expect(lastMax().text).toBe('Бронь №501 подтверждена. У брони нет почты — письмо туристу не ушло, свяжитесь с ним сами.');

    m.change.mockResolvedValueOnce({ kind: 'ok', changed: false, data: { booking_status: 'confirmed' }, touristNotice: null });
    await postMax(VERIFIED, tap('bk:c:501'));
    await postMax(VERIFIED, tap(`oc:y:${idFrom(lastMax().payloads, 'oc:y:')}`));
    expect(lastMax().text).toBe('Бронь №501 уже подтверждена — туристу повторно ничего не отправлено.');
  });

  it('переход проверяется до вопроса: уже подтверждённая — «уже», отменённая — «так не перевести», строки нет', async () => {
    db.booking = { ...db.booking!, status: 'confirmed' };
    await postMax(VERIFIED, tap('bk:c:501'));
    expect(lastMax().text).toBe('Бронь №501 уже подтверждена — туристу повторно ничего не отправлено.');
    db.booking = { ...db.booking!, status: 'cancelled' };
    await postMax(VERIFIED, tap('bk:d:501'));
    expect(lastMax().text).toBe('Бронь №501 сейчас: «Отменена» — так её уже не перевести. Ничего не изменено.');
    expect(actionWrites()).toBe(0);
  });

  it('«Не надо» — бронь без изменений, и «Да» после него не исполняется', async () => {
    await postMax(VERIFIED, tap('bk:c:501'));
    const id = idFrom(lastMax().payloads, 'oc:x:');
    await postMax(VERIFIED, tap(`oc:x:${id}`));
    expect(lastMax().text).toBe('Хорошо, бронь №501 без изменений.');
    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(lastMax().text).toBe('Это действие отменено — бронь №501 без изменений.');
    expect(m.change).not.toHaveBeenCalled();
  });

  it('отклонение: без причины «Да» не исполняется; «отмена» гасит ожидание', async () => {
    await postMax(VERIFIED, tap('bk:x:501'));
    const ask = lastMax();
    expect(ask.text).toContain('Напишите одним сообщением причину — её получит турист в письме.');
    expect(ask.payloads.filter((x) => x.startsWith('oc:'))).toEqual([`oc:x:${idFrom(ask.payloads, 'oc:x:')}`]);
    const id = idFrom(ask.payloads, 'oc:x:');
    // Подделанное «Да» без причины.
    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(lastMax().text).toBe('Сначала напишите причину отклонения одним сообщением — её получит турист.');
    expect(m.change).not.toHaveBeenCalled();
    // «отмена» — ожидание погашено, помощник кабинета не зовётся.
    await postMax(VERIFIED, said('Отмена'));
    expect(lastMax().text).toBe('Не отклоняю: бронь №501 без изменений.');
    expect(m.processPartner).not.toHaveBeenCalled();
    expect(await awaitsOwnerReason('max', GUIDE_CHAT)).toBe(false);
    // Следующее сообщение — уже не причина: оно идёт помощнику кабинета.
    await postMax(VERIFIED, said('кто ждёт ответа'));
    expect(m.processPartner).toHaveBeenCalledTimes(1);
  });

  it('причина с бедой — блок 112 над вопросом; «Да» отклоняет с этой причиной', async () => {
    const reason = 'Турист сломал ногу, выезд отменяем';
    expect(withSosBlock('x', reason).emergency).toBe(true);
    await postMax(VERIFIED, tap('bk:x:501'));
    await postMax(VERIFIED, said(reason));
    const q = lastMax();
    expect(q.text).toContain('112');
    expect(q.text).toContain(`Причина для туриста: «${reason}». Туристу уйдёт письмо с причиной.`);
    expect(m.processMessage).not.toHaveBeenCalled();
    m.change.mockResolvedValueOnce({ kind: 'ok', changed: true, data: { booking_status: 'cancelled' }, touristNotice: 'sent' });
    await postMax(VERIFIED, tap(`oc:y:${idFrom(q.payloads, 'oc:y:')}`));
    expect(m.change).toHaveBeenCalledWith(expect.objectContaining({
      input: { booking_status: 'cancelled', cancellation_reason: reason }, via: 'max',
    }));
    expect(lastMax().text).toBe('Бронь №501 отклонена. Туристу ушло письмо с причиной.');
  });

  it('пока ждём причину, консоль администратора в том же чате отдаёт текст кабинету', async () => {
    // «Брони перенесли» — команда консоли по слову «брон»: обычно её берёт консоль.
    expect(await adminChatYieldsToPartner('max', GUIDE_CHAT, 'брони перенесли')).toBe(false);
    await postMax(VERIFIED, tap('bk:x:501'));
    expect(await awaitsOwnerReason('max', GUIDE_CHAT)).toBe(true);
    // Пока ждём причину — тот же текст кабинету: он станет причиной отклонения.
    expect(await adminChatYieldsToPartner('max', GUIDE_CHAT, 'брони перенесли')).toBe(true);
  });
});

// ── Telegram ────────────────────────────────────────────────────────────────

describe('Telegram: те же два шага', () => {
  beforeEach(() => { db.owner = String(TG_CHAT); });

  it('личный чат: вопрос без ПД, «Да» — правило с каналом telegram; причина — следующим сообщением', async () => {
    await tgTap('bk:c:501');
    const q = tgSent().at(-1)!;
    expect(q.text).toContain('Подтвердить бронь №501');
    noPd(q.text);
    const yes = q.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data ?? '').find((x) => x.startsWith('oc:y:'));
    await tgTap(yes!);
    expect(m.change).toHaveBeenCalledWith(expect.objectContaining({ bookingId: '501', via: 'telegram' }));
    expect(tgSent().at(-1)!.text).toBe('Бронь №501 подтверждена. Туристу ушло письмо.');

    await tgTap('bk:x:501');
    await tgSay('Перевал закрыт');
    expect(tgSent().at(-1)!.text).toContain('Причина для туриста: «Перевал закрыт»');
  });

  it('«Брони» кнопкой меню и командой в личном чате — кнопки ответа над строкой меню, текст без ПД', async () => {
    await tgTap('rm:gd:bk');
    const viaButton = tgSent().at(-1)!;
    noPd(viaButton.text);
    expect(viaButton.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data))
      .toEqual(['bk:c:501', 'bk:x:501', 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
    await tgSay('/bookings');
    expect(tgSent().at(-1)!.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data))
      .toEqual(['bk:c:501', 'bk:x:501', 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
  });

  it('группа — отказ без записи; кнопка без сообщения — не применена', async () => {
    await tgTap('bk:c:501', 'group');
    expect(tgSent().at(-1)!.text).toBe(OWNER_ACTION_TEXT.notDialog);
    await postTg({ callback_query: { id: 'cb-nomsg', from: { id: TG_CHAT }, data: 'bk:c:501' } });
    expect(tgSent().at(-1)!.text).toContain('сообщение с кнопкой не найдено');
    expect(actionWrites()).toBe(0);
  });
});

// ── Где стоят кнопки ────────────────────────────────────────────────────────

describe('кнопки под экранами и уведомлением', () => {
  it('«Брони»: ответ двум первым ждущим, исход двум первым прошедшим подтверждённым; отменённая и будущая подтверждённая — без кнопок', () => {
    const rows = [
      bk({ id: '501' }), bk({ id: '502' }), bk({ id: '503' }),
      bk({ id: '504', booking_status: 'confirmed', booking_date: '2026-10-20' }),
      bk({ id: '505', booking_status: 'confirmed', booking_date: '2026-11-02' }),
      bk({ id: '506', booking_status: 'cancelled', booking_date: '2026-10-21' }),
    ];
    expect(screens.bookingButtons(rows, NOW).map((r) => r.map((b) => b.payload))).toEqual([
      ['bk:c:501', 'bk:x:501'], ['bk:c:502', 'bk:x:502'], ['bk:d:504', 'bk:n:504'],
    ]);
    const tg = screens.guideBookingsTelegramText(rows.map(screens.withoutPd), NOW);
    expect(tg.text).toContain('Прошли — отметьте, как всё прошло: 1.');
    expect(tg.text).toContain('Ответить — кнопками ниже');
    noPd(tg.text);
    for (const b of tg.buttons.flat()) noPd(b.text);
  });

  it('MAX «Брони» кнопкой меню — кнопки действий над строкой меню, через sendPdAlert в этот чат', async () => {
    await postMax(VERIFIED, tap('rm:gd:bk'));
    const alert = m.pdAlert.mock.calls[0]![0] as { to: unknown; buttons: Array<{ payload?: string }> };
    expect(alert.to).toEqual({ maxChatId: GUIDE_CHAT, telegramChatId: null });
    expect(alert.buttons.map((b) => b.payload)).toEqual(['bk:c:501', 'bk:x:501', 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
  });

  it('«Входящие» гида-продавца — кнопки ответа под ждущими бронями (и заявками, шаг 7); гиду команды — нет', async () => {
    m.inbox.mockResolvedValue({
      category: 'guide', failed: [], not_here: [], chat: { state: 'none' },
      response: { window_days: 30, median_minutes: null, responded: 0, enough: false, complete: true },
      items: [
        { kind: 'operator_booking', id: '501', created_at: '2026-10-28', title: 'Пещеры', date: '2026-11-05', people: 2, contact_id: null, contact_name: null, waiting_minutes: 30 },
        { kind: 'lead', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', created_at: '2026-10-28', title: null, date: null, people: null, contact_id: null, contact_name: null, waiting_minutes: 30 },
      ],
    });
    const seller = await roleMenuScreen({ role: 'guide', action: 'inbox', channel: 'telegram', partner: SELLER, nowMs: NOW });
    expect(seller.buttons?.map((r) => r.map((b) => b.payload))).toEqual([
      ['bk:c:501', 'bk:x:501'],
      ['ld:k:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'ld:w:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'ld:l:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ]);
    const team = await roleMenuScreen({ role: 'guide', action: 'inbox', channel: 'telegram', partner: { ...SELLER, sellsTours: false }, nowMs: NOW });
    expect(team.buttons).toBeUndefined();
  });

  it('текст привязки: продавцу названы кнопки под «Бронями», гиду команды — только кабинет', async () => {
    const { guideBoundText } = await import('@/lib/partners/bind-channel');
    const { partnerMenu } = await import('@/lib/roles/role-menu');
    const seller = guideBoundText('Гид', 'max', partnerMenu(SELLER));
    expect(seller).toContain('кнопками под «Бронями» (бот спросит, бронь меняется после «Да»)');
    const team = guideBoundText('Гид', 'max', partnerMenu({ ...SELLER, sellsTours: false }));
    expect(team).toContain('Подтвердить или отклонить бронь — в кабинете');
    expect(team).not.toContain('кнопками');
  });

  it('личное уведомление о новой брони: гиду со ждущей бронью — «Подтвердить» и «Отклонить»; туроператору и уже подтверждённой — нет', async () => {
    const base = {
      booking_id: '501', tour_title: 'Пещеры', tourist_name: NAME, tourist_phone: PHONE, booking_date: '2026-11-05',
      participants: 2, operator_name: 'Гид', operator_max_chat_id: GUIDE_CHAT, operator_telegram_chat_id: String(TG_CHAT),
    };
    const payloadsOf = async (over: Record<string, unknown>) => {
      m.pdAlert.mockClear();
      await notifyNewBooking({ ...base, ...over });
      const own = m.pdAlert.mock.calls.map((c) => c[0] as { to?: unknown; buttons: Array<{ payload?: string; url?: string }> })
        .find((a) => a.to !== undefined);
      return own!.buttons.map((b) => b.payload ?? `url:${b.url?.replace(/^https?:\/\/[^/]+/, '')}`);
    };
    expect(await payloadsOf({ operator_category: 'guide', booking_status: 'new' }))
      .toEqual(['bk:c:501', 'bk:x:501', 'url:/hub/guide/own']);
    expect(await payloadsOf({ operator_category: 'guide', booking_status: 'confirmed' })).toEqual(['url:/hub/guide/own']);
    expect(await payloadsOf({ operator_category: 'guide' })).toEqual(['url:/hub/guide/own']);
    expect(await payloadsOf({ operator_category: 'operator', booking_status: 'new' })).toEqual(['url:/hub/operator/bookings/501']);
  });
});
