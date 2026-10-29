/**
 * Заявка своего тура кнопкой в чате гида (29.10, шаг 7 плана «гид в
 * мессенджере»): «Связался», «Договорились», «Отказ» — вопрос `ld:`, затем
 * «Да» / «Не надо» `oc:`, как отметка заявки в разделе «Свои туры» на сайте.
 * Правило смены одно — changeLeadStatus со скоупом раздела гида.
 *
 * Что держит — вызовом живых входов (POST /api/max/kuzmich,
 * POST /api/telegram/webhook) и функций; подменены база (поддельные таблицы
 * leads и partner_chat_actions на тех же запросах, условие владения — по
 * тексту скоупа), правило смены заявки и транспорт:
 *  - чужая и ничейная заявка — «не найдена среди ваших», строки нет, правило
 *    не зовётся: ничейную гид не видит и не занимает;
 *  - до «Да» заявка не меняется; «Да» — правило со скоупом карточки этого
 *    чата, от человека карточки, с каналом; повтор «Да» — прежний итог,
 *    правило один раз; тот же статус — «уже» без вопроса;
 *  - туроператор, гид команды, карточка без аккаунта, привязка без
 *    записанного человека, нажал не тот, групповой чат, незаверенный MAX —
 *    у каждого свой отказ, ничего не записано;
 *  - вопрос не называет имени и телефона туриста: тур словами через
 *    redactPII, число людей и день заявки;
 *  - кнопки стоят под ждущими заявками «Входящих» (две заявки — подписаны
 *    туром) и под личным уведомлением гиду о новой заявке — и не стоят у
 *    туроператора и гида без своих туров.
 * Два одновременных «Да», событие ленты с каналом, уход заявки из ждущих
 * «Входящих» — на настоящем PostgreSQL (tests/integration/tourist-cabinet.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  findPartner: vi.fn(),
  findAdmin: vi.fn(),
  processMessage: vi.fn(),
  processPartner: vi.fn(),
  changeLead: vi.fn(),
  changeBooking: vi.fn(),
  pdAlert: vi.fn(),
  inbox: vi.fn(),
  tgSend: vi.fn(),
  team: vi.fn(),
  reach: vi.fn(),
}));

/** Поддельная база: только запросы, которыми ходит lib/bookings/chat-owner-action. */
interface FakeRow {
  id: string; partner_id: string; channel: string; chat_id: string; subject_kind: string; subject_id: string;
  action: string; status: string; outcome: unknown; expired: boolean;
}
const db = vi.hoisted(() => ({
  owner: '602' as string | null,
  leads: [] as Array<{ id: string; status: string; title: string; people: number | null; created_at: string; operator: string | null }>,
  rows: [] as FakeRow[],
  seq: 0,
  writes: [] as string[],
  leadSql: [] as string[],
}));

function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const p = params.map((x) => (x === null || x === undefined ? x : String(x)));
  const res = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return res([]);
  if (/INSERT|UPDATE|DELETE/i.test(sql) && /partner_chat_actions/.test(sql)) db.writes.push(sql);
  if (/owner_user_id::text AS owner/.test(sql)) return res([{ owner: db.owner }]);
  if (/FROM leads/.test(sql)) {
    db.leadSql.push(sql);
    // Условие владения — как его пишет скоуп: «свои» всегда, ничейные — только
    // если в запросе есть `operator_id IS NULL` (скоуп кабинета оператора).
    const unowned = /operator_id IS NULL/.test(sql);
    const l = db.leads.find((x) => x.id === p[0]);
    const ok = l && (l.operator === p[1] || (unowned && l.operator === null));
    return res(ok ? [{ id: l.id, status: l.status, title: l.title, people: l.people, created_at: l.created_at }] : []);
  }
  if (/SET status = 'superseded'/.test(sql)) {
    for (const r of db.rows) if (r.channel === p[0] && r.chat_id === p[1] && ['awaiting_reason', 'ready'].includes(r.status)) r.status = 'superseded';
    return res([]);
  }
  if (/INSERT INTO partner_chat_actions/.test(sql)) {
    const id = `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
    db.rows.push({ id, partner_id: p[0]!, channel: p[1]!, chat_id: p[2]!, subject_kind: p[3]!, subject_id: p[4]!, action: p[5]!, status: p[6]!, outcome: null, expired: false });
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
    return res([{ subject_kind: r.subject_kind, subject_id: r.subject_id, action: r.action, reason: null }]);
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
vi.mock('@/lib/leads/owner-lead-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/leads/owner-lead-status')>()),
  changeLeadStatus: m.changeLead,
}));
vi.mock('@/lib/bookings/owner-status', () => ({ changeOwnerBookingStatus: m.changeBooking }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: m.pdAlert }));
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeam: m.team }));
vi.mock('@/lib/partners/reach', async (orig) => ({
  ...(await orig<typeof import('@/lib/partners/reach')>()),
  reachForPartner: m.reach,
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

const { OWNER_ACTION_TEXT, handleOwnerPress } = await import('@/lib/bookings/chat-owner-action');
const press = await import('@/lib/bookings/chat-owner-press');
const { pressActionOf, UNVERIFIED_PRESS_REPLY } = await import('@/lib/max/verified-press');
const { roleMenuScreen } = await import('@/lib/roles/role-screen');
const { partnerMenuHelp, partnerMenu } = await import('@/lib/roles/role-menu');
const { notifyPartnerNewLeadPersonally } = await import('@/lib/notifications/lead-notify');
const max = await import('@/app/api/max/kuzmich/route');
const telegram = await import('@/app/api/telegram/webhook/route');
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

// ── Данные: выдуманные турист, тур и гид ────────────────────────────────────

const NAME = 'Турист Заявочный';
const PHONE = '+70000000088';
const PD = [NAME, PHONE, '0000000088'];
const NOW = Date.UTC(2026, 9, 29, 0, 0);

const SELLER = {
  partnerId: '66666666-6666-4666-8666-666666666666',
  partnerName: 'Гид-продавец заявок',
  slug: 'guide-leads',
  category: 'guide',
  crmCategory: 'guide',
  userId: '77777777-7777-4777-8777-777777777777',
  sellsTours: true,
};
const OTHER_PARTNER = '88888888-8888-4888-8888-888888888888';
const LEAD = 'aaaaaaaa-1111-4222-8333-444444444444';
const GUIDE_USER = 602;
const GUIDE_CHAT = 9_602;
const TG_CHAT = 7_602;
const KEY = 'test-webhook-key-29-10-ld';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const UNVERIFIED = 'http://localhost/api/max/kuzmich';

const noPd = (text: string) => { for (const v of PD) expect(text).not.toContain(v); };

const postMax = (url: string, body: unknown) =>
  max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

let midSeq = 0;
const tap = (payload: string, chatType = 'dialog') => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: `cb-ld-${++midSeq}`, payload, user: { user_id: GUIDE_USER, name: 'Гид' } },
  message: { recipient: { chat_id: GUIDE_CHAT, chat_type: chatType }, body: { mid: `m-ld-${midSeq}`, seq: 1, text: 'входящие' } },
});

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

let updateId = 62_000;
const postTg = (body: Record<string, unknown>) => telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
  method: 'POST',
  body: JSON.stringify({ update_id: updateId++, ...body }),
}));
const tgTap = (data: string, type = 'private') => postTg({
  callback_query: { id: `cb-${updateId}`, from: { id: TG_CHAT }, message: { chat: { id: TG_CHAT, type } }, data },
});
type TgMessage = { chatId: string; text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
const tgSent = () => m.tgSend.mock.calls.map((c) => c[0] as TgMessage).filter((x) => x.chatId === String(TG_CHAT));

const OK = (status: string, changed = true) => ({ kind: 'ok', changed, prevStatus: 'new', lead: { id: LEAD, status, notes: null } });

beforeEach(() => {
  clearMaxMessageDedup();
  for (const f of Object.values(m)) f.mockReset();
  db.owner = String(GUIDE_USER);
  db.leads = [{ id: LEAD, status: 'new', title: 'Пещеры <Камчатки>', people: 2, created_at: '2026-10-28T02:00:00Z', operator: SELLER.partnerId }];
  db.rows = [];
  db.writes = [];
  db.leadSql = [];
  m.maxSend.mockResolvedValue({});
  m.findPartner.mockResolvedValue({ outcome: 'found', partner: SELLER });
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.changeLead.mockResolvedValue(OK('contacted'));
  m.pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено в MAX' });
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

const actionWrites = () => db.writes.length;

// ── Форма кнопок ────────────────────────────────────────────────────────────

describe('форма кнопок заявки', () => {
  it('«Связался», «Договорились», «Отказ» — действие MAX «owner» (только заверенное), разбирается обратно, влезает в callback_data', () => {
    const row = press.leadAnswerButtons(LEAD);
    expect(row.map((b) => b.text)).toEqual(['Связался', 'Договорились', 'Отказ']);
    expect(row.map((b) => b.payload)).toEqual([`ld:k:${LEAD}`, `ld:w:${LEAD}`, `ld:l:${LEAD}`]);
    const actions = ['contacted', 'converted', 'lost'];
    row.forEach((b, i) => {
      expect(pressActionOf(b.payload), b.payload).toBe('owner');
      expect(press.isOwnerPressPayload(b.payload)).toBe(true);
      expect(press.parseOwnerPress(b.payload)).toEqual({ kind: 'lead', action: actions[i], leadId: LEAD });
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(64);
    });
    // Номер заявки — только uuid; заглавные буквы приводятся.
    expect(press.parseOwnerPress(`ld:k:${LEAD.toUpperCase()}`)).toEqual({ kind: 'lead', action: 'contacted', leadId: LEAD });
    for (const bad of [`ld:q:${LEAD}`, 'ld:k:501', 'ld:k:', `ld:k:${LEAD}x`, 'ld:kk:x']) {
      expect(press.parseOwnerPress(bad), bad).toBeNull();
    }
  });

  it('подпись тура на кнопке — когда заявок под экраном несколько; длинная — обрезана', () => {
    expect(press.leadAnswerButtons(LEAD, 'Толбачик').map((b) => b.text)).toEqual([
      'Связался · Толбачик', 'Договорились · Толбачик', 'Отказ · Толбачик',
    ]);
    const long = press.leadAnswerButtons(LEAD, 'Вулкан Горелый и Мутновский за день')[0]!.text;
    expect(long).toBe('Связался · Вулкан Горелы…');
  });
});

// ── Кто вправе ──────────────────────────────────────────────────────────────

describe('MAX: кто вправе отметить заявку', () => {
  it('чужая заявка — «не найдена среди ваших», строки нет, правило не зовётся', async () => {
    db.leads[0]!.operator = OTHER_PARTNER;
    await postMax(VERIFIED, tap(`ld:k:${LEAD}`));
    expect(lastMax().text).toBe(OWNER_ACTION_TEXT.leadNotFound);
    expect(actionWrites()).toBe(0);
    expect(m.changeLead).not.toHaveBeenCalled();
  });

  it('ничейная заявка — тоже «не найдена»: гид её не видит и не занимает', async () => {
    db.leads[0]!.operator = null;
    await postMax(VERIFIED, tap(`ld:w:${LEAD}`));
    expect(lastMax().text).toBe(OWNER_ACTION_TEXT.leadNotFound);
    expect(db.leadSql.every((sql) => !/operator_id IS NULL/.test(sql))).toBe(true);
    expect(actionWrites()).toBe(0);
    expect(m.changeLead).not.toHaveBeenCalled();
  });

  const REFUSALS: Array<{ name: string; setup: () => void; text: string; chatType?: string }> = [
    { name: 'групповой чат', setup: () => undefined, text: OWNER_ACTION_TEXT.notDialog, chatType: 'chat' },
    { name: 'гид команды без своих туров', setup: () => m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, sellsTours: false } }), text: OWNER_ACTION_TEXT.notThis },
    { name: 'туроператор', setup: () => m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, category: 'operator', crmCategory: 'operator' } }), text: OWNER_ACTION_TEXT.operatorNotYet },
    { name: 'карточка без аккаунта', setup: () => m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, userId: null } }), text: OWNER_ACTION_TEXT.noAccount },
    { name: 'привязка без записанного человека', setup: () => { db.owner = null; }, text: OWNER_ACTION_TEXT.noBindOwner },
    { name: 'нажал не тот, кто подключил чат', setup: () => { db.owner = '999'; }, text: OWNER_ACTION_TEXT.notOwner },
    { name: 'не смогли проверить карточку чата', setup: () => m.findPartner.mockResolvedValue({ outcome: 'unavailable' }), text: OWNER_ACTION_TEXT.unchecked },
  ];
  for (const r of REFUSALS) {
    it(`${r.name}: свой отказ, ничего не записано`, async () => {
      r.setup();
      for (const payload of [`ld:k:${LEAD}`, `ld:l:${LEAD}`]) {
        m.maxSend.mockClear();
        await postMax(VERIFIED, tap(payload, r.chatType));
        expect(lastMax().text, payload).toBe(r.text);
      }
      expect(actionWrites()).toBe(0);
      expect(db.leadSql).toEqual([]);
      expect(m.changeLead).not.toHaveBeenCalled();
    });
  }

  it('незаверенное нажатие — «не засчитано», карточка не читается, ничего не записано', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    await postMax(UNVERIFIED, tap(`ld:w:${LEAD}`));
    expect(maxReplies().map((x) => x.text)).toEqual([UNVERIFIED_PRESS_REPLY.owner]);
    expect(m.findPartner).not.toHaveBeenCalled();
    expect(actionWrites()).toBe(0);
    expect(m.changeLead).not.toHaveBeenCalled();
  });
});

// ── Два шага ────────────────────────────────────────────────────────────────

describe('MAX: вопрос, затем «Да»', () => {
  it('«Связался»: вопрос без ПД, до «Да» заявка не меняется; «Да» — правило гида с каналом; повтор — прежний итог, правило один раз', async () => {
    await postMax(VERIFIED, tap(`ld:k:${LEAD}`));
    const q = lastMax();
    expect(q.text).toBe('Отметить заявку «Пещеры &lt;Камчатки&gt;», 2 чел, от 28.10: «Связался»? Сейчас: «Новая — ждёт вашего ответа». '
      + 'Туристу ничего не уйдёт — отметка для вашего кабинета и ленты клиента.');
    expect(m.changeLead).not.toHaveBeenCalled();
    const id = idFrom(q.payloads, 'oc:y:');
    expect(q.payloads).toEqual([`oc:y:${id}`, `oc:x:${id}`, 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
    expect(db.rows).toMatchObject([{ subject_kind: 'lead', subject_id: LEAD, action: 'contacted', status: 'ready' }]);

    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(m.changeLead).toHaveBeenCalledTimes(1);
    expect(m.changeLead).toHaveBeenCalledWith({
      leadId: LEAD,
      status: 'contacted',
      actor: { kind: 'partner_user', userId: SELLER.userId },
      scope: { kind: 'owner', partnerId: SELLER.partnerId, claimUnowned: false },
      via: 'max',
    });
    expect(lastMax().text).toBe('Заявка отмечена: «Вы связались». Туристу ничего не отправлено.');
    expect(db.rows[0]).toMatchObject({ status: 'done', outcome: { kind: 'lead_done', lead: LEAD, status: 'contacted', changed: true } });

    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(m.changeLead).toHaveBeenCalledTimes(1);
    expect(lastMax().text).toBe('Уже нажато раньше. Заявка отмечена: «Вы связались». Туристу ничего не отправлено.');
  });

  it('тот же статус — «уже» без вопроса и без строки; другой — вопрос называет, что стоит сейчас', async () => {
    db.leads[0]!.status = 'converted';
    await postMax(VERIFIED, tap(`ld:w:${LEAD}`));
    expect(lastMax().text).toBe('Заявка уже отмечена: «Договорились» — ничего не изменено.');
    expect(actionWrites()).toBe(0);
    // Перехода «нельзя» у заявки нет: отказ после «Договорились» — вопросом.
    await postMax(VERIFIED, tap(`ld:l:${LEAD}`));
    expect(lastMax().text).toContain('«Отказ»? Сейчас: «Договорились».');
  });

  it('пока думали, заявку отметили на сайте — «уже», а не «отмечена»', async () => {
    m.changeLead.mockResolvedValueOnce(OK('converted', false));
    await postMax(VERIFIED, tap(`ld:w:${LEAD}`));
    await postMax(VERIFIED, tap(`oc:y:${idFrom(lastMax().payloads, 'oc:y:')}`));
    expect(lastMax().text).toBe('Заявка уже отмечена: «Договорились» — ничего не изменено.');
  });

  it('между вопросом и «Да» заявка ушла другому — «не найдена», строка — отказ', async () => {
    m.changeLead.mockResolvedValueOnce({ kind: 'not_found' });
    await postMax(VERIFIED, tap(`ld:l:${LEAD}`));
    await postMax(VERIFIED, tap(`oc:y:${idFrom(lastMax().payloads, 'oc:y:')}`));
    expect(lastMax().text).toBe(OWNER_ACTION_TEXT.leadNotFound);
    expect(db.rows[0]).toMatchObject({ status: 'refused', outcome: { kind: 'lead_refused', reason: 'not_found' } });
  });

  it('отказ базы на «Да» — «не знаю, изменилась ли», в лог — имя проверки и SQLSTATE', async () => {
    m.changeLead.mockRejectedValueOnce(Object.assign(new Error('связь оборвалась'), { code: '08006' }));
    await postMax(VERIFIED, tap(`ld:k:${LEAD}`));
    await postMax(VERIFIED, tap(`oc:y:${idFrom(lastMax().payloads, 'oc:y:')}`));
    expect(lastMax().text).toContain('Не удалось записать отметку: не знаю, изменилась ли заявка. Проверьте её в разделе «Свои туры»');
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[chat-owner-action] отметка заявки из чата — отказ, SQLSTATE 08006');
    expect(db.rows[0]).toMatchObject({ status: 'refused', outcome: { kind: 'lead_refused', reason: 'error' } });
  });

  it('«Не надо» — заявка без изменений, «Да» после него не исполняется; истёкший вопрос — «нажмите кнопку заявки ещё раз»', async () => {
    await postMax(VERIFIED, tap(`ld:k:${LEAD}`));
    const id = idFrom(lastMax().payloads, 'oc:x:');
    await postMax(VERIFIED, tap(`oc:x:${id}`));
    expect(lastMax().text).toBe('Хорошо, заявка без изменений.');
    await postMax(VERIFIED, tap(`oc:y:${id}`));
    expect(lastMax().text).toBe('Это действие отменено — заявка без изменений.');

    await postMax(VERIFIED, tap(`ld:w:${LEAD}`));
    const late = idFrom(lastMax().payloads, 'oc:y:');
    db.rows.find((r) => r.id === late)!.expired = true;
    await postMax(VERIFIED, tap(`oc:y:${late}`));
    expect(lastMax().text).toBe('Вопрос устарел (15 минут) — нажмите кнопку заявки ещё раз. Ничего не изменено.');
    expect(m.changeLead).not.toHaveBeenCalled();
  });

  it('вопрос не называет телефона, вписанного туристом в поле тура: тур словами — через redactPII', async () => {
    db.leads[0]!.title = `Толбачик, звоните ${PHONE}`;
    await postMax(VERIFIED, tap(`ld:k:${LEAD}`));
    noPd(lastMax().text);
    expect(lastMax().text).toContain('«Толбачик, звоните [телефон]»');
  });

  it('прямой вызов: нажатие брони и заявки из одного чата — одна действующая строка (новая заменяет прежнюю)', async () => {
    const first = await handleOwnerPress({ channel: 'max', chatId: GUIDE_CHAT, privateChat: true, presserId: GUIDE_USER, payload: `ld:k:${LEAD}` });
    const firstId = idFrom(first.buttons.flat().map((b) => b.payload), 'oc:y:');
    await handleOwnerPress({ channel: 'max', chatId: GUIDE_CHAT, privateChat: true, presserId: GUIDE_USER, payload: `ld:l:${LEAD}` });
    const again = await handleOwnerPress({ channel: 'max', chatId: GUIDE_CHAT, privateChat: true, presserId: GUIDE_USER, payload: `oc:y:${firstId}` });
    expect(again.text).toBe('Это действие заменено следующей кнопкой — ничего не изменено.');
    expect(m.changeLead).not.toHaveBeenCalled();
  });
});

// ── Telegram ────────────────────────────────────────────────────────────────

describe('Telegram: те же два шага', () => {
  beforeEach(() => { db.owner = String(TG_CHAT); });

  it('личный чат: вопрос без ПД, «Да» — правило с каналом telegram; группа — отказ без записи', async () => {
    await tgTap(`ld:w:${LEAD}`);
    const q = tgSent().at(-1)!;
    expect(q.text).toContain('Отметить заявку «Пещеры &lt;Камчатки&gt;», 2 чел, от 28.10: «Договорились»?');
    noPd(q.text);
    const yes = q.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data ?? '').find((x) => x.startsWith('oc:y:'));
    m.changeLead.mockResolvedValueOnce(OK('converted'));
    await tgTap(yes!);
    expect(m.changeLead).toHaveBeenCalledWith(expect.objectContaining({ leadId: LEAD, status: 'converted', via: 'telegram' }));
    expect(tgSent().at(-1)!.text).toBe('Заявка отмечена: «Договорились». Туристу ничего не отправлено.');

    const before = actionWrites();
    await tgTap(`ld:l:${LEAD}`, 'group');
    expect(tgSent().at(-1)!.text).toBe(OWNER_ACTION_TEXT.notDialog);
    expect(actionWrites()).toBe(before);
  });
});

// ── Где стоят кнопки ────────────────────────────────────────────────────────

const inboxWith = (items: Array<{ kind: string; id: string; title: string | null }>) => ({
  category: 'guide', failed: [], not_here: [], chat: { state: 'none' },
  response: { window_days: 30, median_minutes: null, responded: 0, enough: false, complete: true },
  items: items.map((i) => ({ ...i, created_at: '2026-10-28', date: null, people: 2, contact_id: null, contact_name: null, waiting_minutes: 40 })),
});

describe('кнопки под «Входящими» и уведомлением', () => {
  const LEAD2 = 'bbbbbbbb-1111-4222-8333-444444444444';
  const LEAD3 = 'cccccccc-1111-4222-8333-444444444444';

  it('«Входящие» продавца: одна заявка — кнопки без подписи; две и больше — две первые, подписаны туром; гиду команды — нет', async () => {
    m.inbox.mockResolvedValueOnce(inboxWith([{ kind: 'lead', id: LEAD, title: 'Толбачик' }]));
    const one = await roleMenuScreen({ role: 'guide', action: 'inbox', channel: 'telegram', partner: SELLER, nowMs: NOW });
    expect(one.buttons?.map((r) => r.map((b) => b.text))).toEqual([['Связался', 'Договорились', 'Отказ']]);

    m.inbox.mockResolvedValueOnce(inboxWith([
      { kind: 'lead', id: LEAD, title: 'Толбачик' }, { kind: 'lead', id: LEAD2, title: null }, { kind: 'lead', id: LEAD3, title: 'Курильское' },
    ]));
    const three = await roleMenuScreen({ role: 'guide', action: 'inbox', channel: 'telegram', partner: SELLER, nowMs: NOW });
    expect(three.buttons?.map((r) => r.map((b) => b.payload))).toEqual([
      [`ld:k:${LEAD}`, `ld:w:${LEAD}`, `ld:l:${LEAD}`],
      [`ld:k:${LEAD2}`, `ld:w:${LEAD2}`, `ld:l:${LEAD2}`],
    ]);
    expect(three.buttons?.[0]?.[0]?.text).toBe('Связался · Толбачик');
    expect(three.buttons?.[1]?.[0]?.text).toBe('Связался · Подбор тура');

    m.inbox.mockResolvedValueOnce(inboxWith([{ kind: 'lead', id: LEAD, title: 'Толбачик' }]));
    const team = await roleMenuScreen({ role: 'guide', action: 'inbox', channel: 'telegram', partner: { ...SELLER, sellsTours: false }, nowMs: NOW });
    expect(team.buttons).toBeUndefined();
  });

  it('Telegram «Входящие» кнопкой меню в личном чате — кнопки заявки над строкой меню', async () => {
    m.inbox.mockResolvedValue(inboxWith([{ kind: 'lead', id: LEAD, title: 'Толбачик' }]));
    await tgTap('rm:gd:in');
    expect(tgSent().at(-1)!.replyMarkup?.inline_keyboard?.flat().map((b) => b.callback_data))
      .toEqual([`ld:k:${LEAD}`, `ld:w:${LEAD}`, `ld:l:${LEAD}`, 'rm:gd:in', 'rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
  });

  it('справка меню продавца называет кнопки заявки и кто их нажимает', () => {
    const help = partnerMenuHelp('guide', partnerMenu(SELLER) ?? []);
    expect(help).toContain('Под ждущими заявками во «Входящих» — «Связался», «Договорились», «Отказ»');
    expect(help).toContain('Кнопки брони и заявки нажимает тот, кто подключил этот чат ссылкой из кабинета.');
    const team = partnerMenuHelp('guide', partnerMenu({ ...SELLER, sellsTours: false }) ?? []);
    expect(team).not.toContain('«Связался»');
  });

  const LEAD_MSG = { operatorId: SELLER.partnerId, leadId: LEAD, name: NAME, phone: PHONE, comment: 'двое, конец июля' };
  const BOUND = { maxChatId: String(GUIDE_CHAT), telegramChatId: String(TG_CHAT), telegramSource: 'partner' as const, reachable: true };
  const personal = () => m.pdAlert.mock.calls.map((c) => c[0] as { to?: unknown; text: string; stub: string; buttons: Array<{ payload?: string; url?: string }> })
    .find((a) => a.to !== undefined)!;

  it('личное уведомление о новой заявке: гиду-продавцу — «Связался», «Договорились», «Отказ» над ссылкой; ПД — только в тексте для MAX', async () => {
    m.reach.mockResolvedValue({ ...BOUND, category: 'guide', sellsTours: true });
    expect(await notifyPartnerNewLeadPersonally(LEAD_MSG)).toEqual({ state: 'delivered', channel: 'max' });
    const own = personal();
    expect(own.to).toEqual({ maxChatId: String(GUIDE_CHAT), telegramChatId: String(TG_CHAT) });
    expect(own.buttons.map((b) => b.payload ?? `url:${b.url?.replace(/^https?:\/\/[^/]+/, '')}`))
      .toEqual([`ld:k:${LEAD}`, `ld:w:${LEAD}`, `ld:l:${LEAD}`, 'url:/hub/guide/own']);
    expect(own.text).toContain(PHONE);
    noPd(own.stub);
    // Копия команде — только ссылка: кнопки нажимает человек, подключивший чат кабинета.
    const [, msg] = m.team.mock.calls[0] as [string, { buttons: Array<Record<string, string>> }];
    expect(msg.buttons.every((b) => 'url' in b && !('payload' in b))).toBe(true);
  });

  it('туроператору, гиду без своих туров и при непрочитанном адресе — кнопок ответа нет', async () => {
    for (const reach of [
      { ...BOUND, category: 'operator', sellsTours: true },
      { ...BOUND, category: 'guide', sellsTours: false },
      { ...BOUND, category: 'guide' },
    ]) {
      m.pdAlert.mockClear();
      m.reach.mockResolvedValueOnce(reach);
      await notifyPartnerNewLeadPersonally(LEAD_MSG);
      expect(personal().buttons.some((b) => 'payload' in b), JSON.stringify(reach)).toBe(false);
    }
    m.pdAlert.mockClear();
    m.reach.mockResolvedValueOnce(null);
    expect(await notifyPartnerNewLeadPersonally(LEAD_MSG)).toEqual({ state: 'unknown' });
    expect(m.pdAlert).not.toHaveBeenCalled();
  });
});
