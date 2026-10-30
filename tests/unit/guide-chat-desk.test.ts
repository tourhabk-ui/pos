/**
 * Сторож связки «что гид может в чате» (29.10, шаг 10 плана «гид в
 * мессенджере»; с 30.10 — кабинет в чате: вкладки «Входящие», «Задачи»,
 * «Клиенты», «Ещё», прежние кнопки — в «Ещё»). Одна таблица — `DESK`:
 * действие × канал × исход. Строка таблицы — то, что справка меню гида
 * называет кнопкой (или фразой), и что с этим происходит в MAX и в Telegram.
 *
 * Что держит, вызовом живых входов (POST /api/max/kuzmich,
 * POST /api/telegram/webhook) и функций:
 *  - справка, которую гид-продавец своих туров получает кнопкой «Помощь» в
 *    канале, называет ровно таблицу: имя в «…», которого в таблице нет, —
 *    красное (кнопка без обработчика — обещание без исполнения, §10.09), и
 *    строка таблицы, которую справка не называет, — тоже;
 *  - кнопка берётся не из таблицы, а из настоящего ответа в этом канале — из
 *    того экрана, под которым её обещает таблица, — и нажимается через живой
 *    вход. Исход — экран, вопрос и «Да» с правилом смены статуса и каналом,
 *    предложение дат с «Открыть», — а не «такой кнопки нет» и не помощник;
 *  - гид команды оператора без своих туров: в справке и строке только
 *    «Входящие» и «Помощь»; устаревшие кнопки продавца — отказ, ничего не
 *    прочитано и не записано;
 *  - на данных с ПД (имя, телефон, почта и пожелания в брони, телефон и
 *    почта в свободном тексте заявки) Telegram не получает ни одного из них
 *    ни в тексте, ни в подписи кнопки; MAX получает имя и телефон только
 *    через sendPdAlert в этот чат без заглушки в Telegram;
 *  - тексты привязки (оба канала, продавец и гид команды) и приветствие
 *    Telegram называют только то, что есть в таблице для этого гида.
 * Регулярка по исходнику одна, и это запрет: Telegram-ветка экрана «Брони»
 * (lib/guides/chat-screens) не читает полей ПД.
 *
 * Подменены база (поддельные partner_chat_actions, бронь и заявка на тех же
 * запросах, что у lib/bookings/chat-owner-action), чтения раздела «Свои туры»
 * и «Входящих», правила смены статуса брони и заявки (их судят свои тесты и
 * tests/integration/tourist-cabinet.pg.test.ts), хранилище предложений дат
 * (tests/integration/chat-open-dates.pg.test.ts) и транспорт. Разбор кнопок,
 * экраны, справка, тексты, поток дат и оба вебхука — настоящие.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnBooking, OwnTour } from '@/lib/guides/own-tours';
import type { MenuButton } from '@/lib/roles/chat-menu';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  findPartner: vi.fn(),
  findAdmin: vi.fn(),
  processMessage: vi.fn(),
  processPartner: vi.fn(),
  change: vi.fn(),
  changeLead: vi.fn(),
  pdAlert: vi.fn(),
  bookings: vi.fn(),
  tours: vi.fn(),
  inbox: vi.fn(),
  tgSend: vi.fn(),
  team: vi.fn(),
  datesTours: vi.fn(),
  preview: vi.fn(),
  createProposal: vi.fn(),
  pressOpen: vi.fn(),
}));

/** Поддельная база: только запросы lib/bookings/chat-owner-action. */
interface FakeRow {
  id: string; partner_id: string; channel: string; chat_id: string; subject_kind: string; subject_id: string;
  action: string; reason: string | null; status: string; outcome: unknown;
}
interface FakeBooking { id: string; status: string; date: string; participants: number; title: string; partner: string }
interface FakeLead { id: string; status: string; title: string; people: number | null; created_at: string; operator: string }
interface FakeTask { id: string; title: string; due_at: string; done_at: string | null; partner: string }
const db = vi.hoisted(() => ({
  owner: { max: null as string | null, telegram: null as string | null },
  bookings: [] as FakeBooking[],
  leads: [] as FakeLead[],
  rows: [] as FakeRow[],
  tasks: [] as FakeTask[],
  seq: 0,
  writes: [] as string[],
}));

/** Строка задачи в форме lib/crm/tasks (TaskJoinRow). */
function taskRow(t: FakeTask) {
  return {
    id: t.id, title: t.title, details: null, due_at: t.due_at, done_at: t.done_at, contact_id: null,
    created_at: '2026-10-28T00:00:00Z', reminded_at: null, reminder_channel: null, contact_name: null,
  };
}

function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  const p = params.map((x) => (x === null || x === undefined ? x : String(x)));
  const res = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return res([]);
  // Задачи CRM — те же запросы, что lib/crm/tasks (кабинет в чате, 30.10).
  if (/FROM crm_tasks t\s+LEFT JOIN crm_contacts c/.test(sql) && /t\.done_at IS NULL/.test(sql)) {
    return res(db.tasks.filter((t) => t.partner === p[0] && t.done_at === null).map(taskRow));
  }
  if (/UPDATE crm_tasks SET done_at = NOW\(\)/.test(sql)) {
    const t = db.tasks.find((x) => x.partner === p[0] && x.id === p[1] && x.done_at === null);
    if (!t) return res([]);
    t.done_at = '2026-10-29T00:00:00Z';
    db.writes.push(sql);
    return res([taskRow(t)]);
  }
  if (/UPDATE crm_tasks\s+SET title = COALESCE/.test(sql)) {
    const t = db.tasks.find((x) => x.partner === p[0] && x.id === p[1] && x.done_at === null);
    if (!t) return res([]);
    if (p[5]) t.due_at = p[5];
    db.writes.push(sql);
    return res([taskRow(t)]);
  }
  if (/INSERT|UPDATE|DELETE/i.test(sql) && /partner_chat_actions/.test(sql)) db.writes.push(sql);
  if (/max_owner_user_id::text AS owner/.test(sql)) return res([{ owner: db.owner.max }]);
  if (/telegram_owner_user_id::text AS owner/.test(sql)) return res([{ owner: db.owner.telegram }]);
  if (/FROM operator_bookings b\s+JOIN operator_tours t/.test(sql)) {
    return res(db.bookings.filter((b) => b.id === p[0] && b.partner === p[1]));
  }
  if (/FROM leads/.test(sql)) {
    const l = db.leads.find((x) => x.id === p[0] && x.operator === p[1]);
    return res(l ? [{ id: l.id, status: l.status, title: l.title, people: l.people, created_at: l.created_at }] : []);
  }
  if (/SET status = 'superseded'/.test(sql)) {
    for (const r of db.rows) if (r.channel === p[0] && r.chat_id === p[1] && ['awaiting_reason', 'ready'].includes(r.status)) r.status = 'superseded';
    return res([]);
  }
  if (/INSERT INTO partner_chat_actions/.test(sql)) {
    const id = `dddddddd-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
    db.rows.push({
      id, partner_id: p[0]!, channel: p[1]!, chat_id: p[2]!, subject_kind: p[3]!, subject_id: p[4]!, action: p[5]!,
      reason: null, status: p[6]!, outcome: null,
    });
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
    const r = db.rows.find((x) => mine(x) && x.status === 'ready');
    if (!r) return res([]);
    r.status = 'running';
    return res([{ subject_kind: r.subject_kind, subject_id: r.subject_id, action: r.action, reason: r.reason }]);
  }
  if (/SELECT status, subject_kind, subject_id, outcome/.test(sql)) {
    const r = db.rows.find(mine);
    return res(r ? [{ status: r.status, subject_kind: r.subject_kind, subject_id: r.subject_id, outcome: r.outcome, expired: false, stale: false }] : []);
  }
  if (/SET status = \$2, outcome = \$3::jsonb/.test(sql)) {
    const r = db.rows.find((x) => x.id === p[0] && x.status === 'running');
    if (!r) return res([], 0);
    r.status = p[1]!;
    r.outcome = JSON.parse(p[2]!);
    return res([], 1);
  }
  if (/SELECT id::text AS id, subject_id FROM partner_chat_actions/.test(sql)) {
    const r = db.rows.find((x) => x.channel === p[0] && x.chat_id === p[1] && x.partner_id === p[2] && x.status === 'awaiting_reason');
    return res(r ? [{ id: r.id, subject_id: r.subject_id }] : []);
  }
  if (/SET reason = \$2, status = 'ready'/.test(sql)) {
    const r = db.rows.find((x) => x.id === p[0] && x.status === 'awaiting_reason');
    if (!r) return res([], 0);
    r.reason = p[1]!;
    r.status = 'ready';
    return res([], 1);
  }
  if (/SELECT 1 FROM partner_chat_actions/.test(sql)) {
    return res(db.rows.some((x) => x.channel === p[0] && x.chat_id === p[1] && x.status === 'awaiting_reason') ? [{}] : []);
  }
  // «Мои туры» гида (lib/guides/tour-edit, 30.10): свои туры и черновик правки.
  if (/FROM operator_tours t\s+WHERE t\.operator_id = \$1::uuid/.test(sql)) {
    return res([{
      id: '77', title: 'Восхождение на Горелый', slug: 'desk-gorely', is_active: true, is_published: true,
      base_price: '15000.00', price_unit: 'per_person', max_participants: 8, short_description: null, description: 'Было.',
      program: null, included: null, not_included: null, what_to_bring: null, safety_notes: null,
    }]);
  }
  if (/INSERT INTO tour_chat_edits/.test(sql)) {
    db.writes.push(sql);
    return res([{ id: `eeeeeeee-0000-4000-8000-${String(++db.seq).padStart(12, '0')}` }]);
  }
  if (/UPDATE operator_tours/.test(sql)) db.writes.push(sql);
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
vi.mock('@/lib/kuzmich/core', () => ({
  hasLiveBookingFlow: vi.fn(async () => false),
  processMessage: m.processMessage,
  cleanupPending: vi.fn(),
  saveMsg: vi.fn(async () => undefined),
  getHistory: vi.fn(async () => []),
}));
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
vi.mock('@/lib/leads/owner-lead-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/leads/owner-lead-status')>()),
  changeLeadStatus: m.changeLead,
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: m.pdAlert }));
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeam: m.team }));
vi.mock('@/lib/guides/own-tours', async (orig) => ({
  ...(await orig<typeof import('@/lib/guides/own-tours')>()),
  loadOwnBookings: m.bookings,
  loadOwnTours: m.tours,
}));
vi.mock('@/lib/crm/inbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/inbox')>()),
  loadInbox: m.inbox,
}));
// Хранилище предложений дат — своя таблица и свой pg-тест; здесь поток дат
// настоящий, а записи предложения подменены.
vi.mock('@/lib/operators/chat-dates/proposals', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/chat-dates/proposals')>()),
  readPartnerTours: m.datesTours,
  readAutoConfirm: vi.fn(async () => false),
  previewDates: m.preview,
  createProposal: m.createProposal,
  retireActive: vi.fn(async () => 0),
  draftWaiting: vi.fn(async () => 'none'),
  pressOpen: m.pressOpen,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a), answerCallback: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/telegram/bot-username', () => ({ resolveTelegramBotUsername: vi.fn().mockResolvedValue({ name: 'test_bot' }) }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));

const { OWNER_ACTION_TEXT } = await import('@/lib/bookings/chat-owner-action');
const { bookingPressPayload, leadPressPayload, answerPressPayload } = await import('@/lib/bookings/chat-owner-press');
const { partnerMenu, partnerMenuExtras } = await import('@/lib/roles/role-menu');
const { GUIDE_NO_OWN_TOURS } = await import('@/lib/roles/role-screen');
const { withoutPd } = await import('@/lib/guides/chat-screens');
const { channelBoundText } = await import('@/lib/partners/bind-channel');
const { buildWelcomeText } = await import('@/lib/telegram/welcome');
const { INBOX_NOT_HERE } = await import('@/lib/crm/inbox-kinds');
const { LEAD_STATUS_WORDS } = await import('@/lib/leads/owner-lead-words');
const { telegramDatesText } = await import('@/lib/operators/chat-dates/texts');
const { roleChatCommands } = await import('@/lib/telegram/role-commands');
const max = await import('@/app/api/max/kuzmich/route');
const telegram = await import('@/app/api/telegram/webhook/route');
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

// ── Данные: выдуманные турист, тур и гид ────────────────────────────────────

const NAME = 'Турист Связочный';
const PHONE = '+70000000079';
const EMAIL = 'desk-probe@example.com';
const WISH = 'аллергия на мёд';
/** Всё, что не должно уйти в Telegram ни в каком виде. */
const PD = [NAME, PHONE, '0000000079', EMAIL, WISH];
/** 29.10 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 9, 29, 0, 0);

const SELLER = {
  partnerId: '12121212-1212-4121-8121-121212121212',
  partnerName: 'Гид-продавец',
  slug: 'guide-desk',
  category: 'guide',
  crmCategory: 'guide',
  userId: '34343434-3434-4343-8343-343434343434',
  sellsTours: true,
};
/** Гид из команды оператора: своих туров нет. */
const TEAM = { ...SELLER, partnerName: 'Гид команды', slug: 'guide-team', sellsTours: false };
const LEAD = 'eeeeeeee-1111-4222-8333-444444444444';
const GUIDE_USER = 610;
const GUIDE_CHAT = 9_610;
const TG_CHAT = 7_610;
const KEY = 'test-webhook-key-29-10-desk';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const PROPOSAL = 'ffffffff-1111-4222-8333-444444444444';
const TOUR_TITLE = 'Пещеры Камчатки';

function ownBooking(over: Partial<OwnBooking>): OwnBooking {
  return {
    id: '501', tour_id: '77', tour_title: TOUR_TITLE, booking_date: '2026-11-05', participants: 2,
    booking_status: 'new', tourist_name: NAME, tourist_phone: PHONE, tourist_email: EMAIL,
    special_requests: WISH, created_at: '2026-10-28 10:00:00+12', ...over,
  };
}
const OWN_BOOKINGS: OwnBooking[] = [
  ownBooking({}),
  // Подтверждённая, дата прошла: под ней «Тур прошёл» и «Не пришёл».
  ownBooking({ id: '502', booking_status: 'confirmed', booking_date: '2026-10-25', participants: 3 }),
];
const OWN_TOURS: OwnTour[] = [{
  id: '77', title: TOUR_TITLE, slug: 'caves', is_published: true, is_active: true, base_price: '15000',
  max_participants: 8, season_start: null, season_end: null, open_dates: 4,
}];
/** «Входящие» гида: ждущая бронь и заявка, где турист вписал телефон и почту в свободный текст. */
const INBOX = {
  category: 'guide', failed: [], not_here: INBOX_NOT_HERE.guide, chat: { state: 'none' },
  response: { window_days: 30, median_minutes: null, responded: 0, enough: false, complete: true },
  items: [
    { kind: 'operator_booking', id: '501', created_at: '2026-10-28', title: TOUR_TITLE, date: '2026-11-05', people: 2, contact_id: null, contact_name: NAME, waiting_minutes: 40 },
    { kind: 'lead', id: LEAD, created_at: '2026-10-28', title: `Толбачик, звоните ${PHONE}`, date: `конец июля, ${EMAIL}`, people: 2, contact_id: null, contact_name: NAME, waiting_minutes: 30 },
  ],
};

// ── Таблица: действие × канал × исход ───────────────────────────────────────

type Channel = 'max' | 'telegram';
const CHANNELS: readonly Channel[] = ['max', 'telegram'];

/**
 * Исход нажатия (или фразы) в канале:
 *  - `screen` — экран раздела под строкой меню, обычным ответом;
 *  - `screen_pd` — тот же экран с именем и телефоном туриста, только через
 *    sendPdAlert в этот чат MAX;
 *  - `ask_yes` — вопрос без ПД, затем «Да» — правило смены статуса с этим
 *    каналом (у «Отклонить» между ними — причина одним сообщением);
 *  - `repeat` — «Да» исполняет правило один раз, повтор отвечает прежним итогом;
 *  - `kept` — «Не надо»: ничего не изменено, и «Да» того же вопроса уже не исполняется;
 *  - `dates_open` — фраза даёт предложение с «Открыть», нажатие пишет даты
 *    карточки гида;
 *  - `dates_link` — фраза получает «это в MAX» со ссылкой в «Свои туры», без кнопки;
 *  - `task_done` / `task_tomorrow` — кнопка экрана «Задачи» отмечает задачу
 *    (completeTask) или переносит её на завтра, 10:00 (updateTask), и экран
 *    приходит с отметкой о сделанном;
 *  - `max_only` — в этом канале кнопки нет: заголовков задач в Telegram нет,
 *    экран говорит, что они в MAX.
 */
type Outcome =
  | 'screen' | 'screen_pd' | 'ask_yes' | 'repeat' | 'kept' | 'dates_open' | 'dates_link'
  | 'task_done' | 'task_tomorrow' | 'max_only';

/** Вкладки строки меню и экраны «Ещё». */
type MenuName = 'Входящие' | 'Задачи' | 'Клиенты' | 'Ещё' | 'Брони' | 'Мои туры' | 'Помощь';

interface DeskRow {
  /** Как действие называет справка (у кнопки — начало подписи). */
  name: string;
  /** Кто называет: справка меню или сам вопрос «Да / Не надо». */
  namedBy: 'help' | 'question';
  max: Outcome;
  telegram: Outcome;
  /** Экран строки меню: каким текстом он начинается. */
  screen?: RegExp;
  /** Экран кабинета в чате: под ним строка кабинета (`cb:`), а не строка меню. */
  cabinet?: boolean;
  /** Под какими экранами кнопка стоит (первый — откуда нажимаем). */
  under?: MenuName[];
  /** Вопрос после нажатия. */
  ask?: RegExp;
  /** Сначала причина одним сообщением, потом вопрос. */
  reason?: boolean;
  /** Что правило получает от «Да»: статус брони или заявки. */
  status?: string;
  subject?: 'booking' | 'lead';
  /** Ответ после «Да». */
  done?: RegExp;
}

const DESK: readonly DeskRow[] = [
  // Строка меню — вкладки кабинета в чате.
  { name: 'Входящие', namedBy: 'help', max: 'screen', telegram: 'screen', screen: /^<b>Входящие<\/b>/, cabinet: true },
  { name: 'Задачи', namedBy: 'help', max: 'screen', telegram: 'screen', screen: /^<b>Задачи<\/b>/, cabinet: true },
  { name: 'Клиенты', namedBy: 'help', max: 'screen', telegram: 'screen', screen: /^<b>Клиенты<\/b>/, cabinet: true },
  { name: 'Ещё', namedBy: 'help', max: 'screen', telegram: 'screen', screen: /^<b>Ещё<\/b>/, cabinet: true },
  // «Ещё».
  { name: 'Брони', namedBy: 'help', max: 'screen_pd', telegram: 'screen', screen: /^<b>Брони<\/b>/ },
  { name: 'Мои туры', namedBy: 'help', max: 'screen', telegram: 'screen', screen: /^<b>Мои туры<\/b>/ },
  { name: 'Помощь', namedBy: 'help', max: 'screen', telegram: 'screen', screen: /^Кабинет гида в чате\./ },
  // Задачи: «Готово» и «На завтра» — в MAX, где видно, что за задача.
  { name: 'Готово', namedBy: 'help', max: 'task_done', telegram: 'max_only' },
  { name: 'На завтра', namedBy: 'help', max: 'task_tomorrow', telegram: 'max_only' },
  // Бронь: вопрос, затем «Да» — правило сайта.
  {
    name: 'Подтвердить', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Брони', 'Входящие'], subject: 'booking',
    ask: /^Подтвердить бронь №501 /, status: 'confirmed', done: /^Бронь №501 подтверждена\. Туристу ушло письмо\./,
  },
  {
    name: 'Отклонить', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Брони', 'Входящие'], subject: 'booking',
    reason: true, ask: /^Отклонить бронь №501 .*Причина для туриста: «Турист перенёс поездку»/, status: 'cancelled',
    done: /^Бронь №501 отклонена\. Туристу ушло письмо с причиной\./,
  },
  {
    name: 'Тур прошёл', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Брони'], subject: 'booking',
    ask: /^Отметить, что тур прошёл: бронь №502 /, status: 'completed', done: /^Бронь №502 отмечена: тур прошёл\.$/,
  },
  {
    name: 'Не пришёл', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Брони'], subject: 'booking',
    ask: /^Отметить, что турист не пришёл: бронь №502 /, status: 'no_show', done: /^Бронь №502 отмечена: турист не пришёл\.$/,
  },
  // Заявка: те же два шага, туристу ничего не уходит.
  {
    name: 'Связался', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Входящие'], subject: 'lead',
    ask: /^Отметить заявку .*: «Связался»\?/, status: 'contacted', done: new RegExp(`^Заявка отмечена: «${LEAD_STATUS_WORDS.contacted}»`),
  },
  {
    name: 'Договорились', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Входящие'], subject: 'lead',
    ask: /^Отметить заявку .*: «Договорились»\?/, status: 'converted', done: new RegExp(`^Заявка отмечена: «${LEAD_STATUS_WORDS.converted}»`),
  },
  {
    name: 'Отказ', namedBy: 'help', max: 'ask_yes', telegram: 'ask_yes', under: ['Входящие'], subject: 'lead',
    ask: /^Отметить заявку .*: «Отказ»\?/, status: 'lost', done: new RegExp(`^Заявка отмечена: «${LEAD_STATUS_WORDS.lost}»`),
  },
  // Под вопросом.
  { name: 'Да', namedBy: 'help', max: 'repeat', telegram: 'repeat' },
  { name: 'Не надо', namedBy: 'question', max: 'kept', telegram: 'kept' },
  // Фраза про даты: в MAX — поток с кнопкой «Открыть», в Telegram — ссылка.
  { name: 'Открыть', namedBy: 'help', max: 'dates_open', telegram: 'dates_link' },
];

/** Вкладки строки меню — одни у продавца и у гида команды. */
const MENU_NAMES: readonly MenuName[] = ['Входящие', 'Задачи', 'Клиенты', 'Ещё'];
/** Что лежит в «Ещё» у продавца своих туров. */
const MORE_NAMES: readonly MenuName[] = ['Брони', 'Мои туры', 'Помощь'];
/** Что есть у гида команды без своих туров. */
const TEAM_NAMES: ReadonlySet<string> = new Set([...MENU_NAMES, 'Помощь', 'Готово', 'На завтра']);
/** Падежные формы, которыми тексты называют экраны строки. */
const ALIASES: Readonly<Record<string, string>> = {
  Бронях: 'Брони', Бронями: 'Брони', Входящих: 'Входящие', Входящими: 'Входящие',
};
/**
 * Названо в «…», но не кнопка чата: раздел кабинета и отметка заявки, которую
 * ставят только там. Чат такой кнопки не рисует — это проверяется ниже.
 */
const SITE_ONLY: ReadonlySet<string> = new Set(['Свои туры', 'Обсуждаем', 'кабинет на сайте']);
/** Фраза-пример из справки: её надо написать, а не нажать. */
const isPhrase = (name: string) => /^открой /.test(name);

/** Имя из текста → строка таблицы; null — названо то, чего в чате нет. */
function resolveName(raw: string, who: 'seller' | 'team', partnerName: string | null = null): DeskRow | 'site' | 'phrase' | 'partner' | null {
  if (partnerName !== null && raw === partnerName) return 'partner';
  if (SITE_ONLY.has(raw)) return 'site';
  if (who === 'seller' && isPhrase(raw)) return 'phrase';
  const name = ALIASES[raw] ?? raw;
  const row = DESK.find((r) => r.name === name);
  if (!row) return null;
  if (who === 'team' && !TEAM_NAMES.has(row.name)) return null;
  return row;
}

/** Вкладки, которые называет справка: перечень после «Под ответами кнопки:». */
const tabsIn = (text: string) => /Под ответами кнопки: ([^.\n]+)\./.exec(text)?.[1]?.split(', ').map((s) => s.trim());
/** Что в «Ещё» называет справка: перечень после «Ещё — ». */
const moreIn = (text: string) => /^Ещё — ([^\n]+)\.$/m.exec(text)?.[1]?.split(', ').map((s) => s.trim());

/** Имена, которые текст называет: всё в «…», вкладки и перечень «Ещё». */
function namesIn(text: string): string[] {
  const quoted = [...text.matchAll(/«([^«»]+)»/g)].map((x) => x[1]!.trim());
  return [...quoted, ...(tabsIn(text) ?? []), ...(moreIn(text) ?? [])];
}

/** Подпись кнопки — это имя (ровно, с номером «1 · », хвостом через пробел, запятую или «·»). */
const labelIs = (label: string, name: string) => label === name || new RegExp(`^(?:\\d+ · )?${name}(?:$|[ ,·])`).test(label);

// ── Каналы ──────────────────────────────────────────────────────────────────

interface Btn { text: string; payload: string }
interface Said { text: string; buttons: Btn[]; viaPd: boolean }
interface Driver {
  channel: Channel;
  press(payload: string): Promise<Said[]>;
  say(text: string): Promise<Said[]>;
}

const postMax = (body: unknown) => max.POST(new NextRequest(VERIFIED, { method: 'POST', body: JSON.stringify(body) }));
let seq = 0;

type MaxOpts = { attachments?: Array<{ payload: { buttons: Array<Array<{ text: string; payload?: string }>> } }> };
type PdArgs = { text: string; stub: string; to?: unknown; buttons?: Array<{ text: string; payload?: string; url?: string }> };

function maxSaidSince(sendFrom: number, pdFrom: number): Said[] {
  const plain = m.maxSend.mock.calls.slice(sendFrom).filter((c) => c[0] === GUIDE_CHAT).map((c) => ({
    text: String(c[1]),
    buttons: ((c[2] as MaxOpts | undefined)?.attachments?.[0]?.payload.buttons ?? []).flat()
      .map((b) => ({ text: b.text, payload: b.payload ?? '' })),
    viaPd: false,
  }));
  const pd = m.pdAlert.mock.calls.slice(pdFrom).map((c) => c[0] as PdArgs).map((a) => ({
    text: a.text,
    buttons: (a.buttons ?? []).filter((b) => typeof b.payload === 'string').map((b) => ({ text: b.text, payload: b.payload! })),
    viaPd: true,
  }));
  return [...plain, ...pd];
}

const maxDriver: Driver = {
  channel: 'max',
  async press(payload) {
    const [a, b] = [m.maxSend.mock.calls.length, m.pdAlert.mock.calls.length];
    await postMax({
      update_type: 'message_callback',
      timestamp: 1,
      callback: { timestamp: 1, callback_id: `cb-desk-${++seq}`, payload, user: { user_id: GUIDE_USER, name: 'Гид' } },
      message: { recipient: { chat_id: GUIDE_CHAT, chat_type: 'dialog' }, body: { mid: `m-desk-tap-${seq}`, seq: 1, text: 'кабинет' } },
    });
    return maxSaidSince(a, b);
  },
  async say(text) {
    const [a, b] = [m.maxSend.mock.calls.length, m.pdAlert.mock.calls.length];
    await postMax({
      update_type: 'message_created',
      timestamp: 1,
      message: {
        sender: { user_id: GUIDE_USER, name: 'Гид' },
        recipient: { chat_id: GUIDE_CHAT, chat_type: 'dialog' },
        body: { mid: `m-desk-say-${++seq}`, seq: 1, text, attachments: [] },
      },
    });
    return maxSaidSince(a, b);
  },
};

let updateId = 63_000;
const postTg = (body: Record<string, unknown>) => telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
  method: 'POST',
  body: JSON.stringify({ update_id: updateId++, ...body }),
}));
type TgMessage = { chatId: string; text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } };

function tgSaidSince(from: number): Said[] {
  return m.tgSend.mock.calls.slice(from).map((c) => c[0] as TgMessage).filter((x) => x.chatId === String(TG_CHAT)).map((x) => ({
    text: x.text,
    buttons: (x.replyMarkup?.inline_keyboard ?? []).flat().filter((b) => typeof b.callback_data === 'string')
      .map((b) => ({ text: b.text, payload: b.callback_data! })),
    viaPd: false,
  }));
}

const tgDriver: Driver = {
  channel: 'telegram',
  async press(payload) {
    const a = m.tgSend.mock.calls.length;
    await postTg({ callback_query: { id: `cb-${updateId}`, from: { id: TG_CHAT }, message: { chat: { id: TG_CHAT, type: 'private' } }, data: payload } });
    return tgSaidSince(a);
  },
  async say(text) {
    const a = m.tgSend.mock.calls.length;
    await postTg({ message: { message_id: updateId, from: { id: TG_CHAT, first_name: 'Гид' }, chat: { id: TG_CHAT, type: 'private' }, text } });
    return tgSaidSince(a);
  },
};

const DRIVERS: Record<Channel, Driver> = { max: maxDriver, telegram: tgDriver };

/** Ровно один ответ — его и судим. */
function one(said: Said[], what: string): Said {
  expect(said.map((s) => s.text), what).toHaveLength(1);
  return said[0]!;
}

function buttonNamed(s: Said, name: string): Btn {
  const b = s.buttons.find((x) => labelIs(x.text, name));
  if (!b) throw new Error(`под ответом «${s.text.slice(0, 60)}…» нет кнопки «${name}»: ${s.buttons.map((x) => x.text).join(', ')}`);
  return b;
}

const menuOf = (partner: typeof SELLER): MenuButton[] => partnerMenu(partner) ?? [];

/**
 * Экран — нажатием настоящей кнопки: вкладка — из строки, которую ставит
 * partnerMenu; экран «Ещё» — из ответа на вкладку «Ещё».
 */
async function openScreen(d: Driver, name: MenuName, partner: typeof SELLER = SELLER): Promise<Said> {
  const tab = menuOf(partner).find((x) => x.text === name);
  if (tab) return one(await d.press(tab.payload), `экран «${name}» (${d.channel})`);
  const more = await openScreen(d, 'Ещё', partner);
  const b = more.buttons.find((x) => x.text === name);
  if (!b) throw new Error(`в «Ещё» нет «${name}»: ${more.buttons.map((x) => x.text).join(', ')}`);
  return one(await d.press(b.payload), `экран «${name}» (${d.channel})`);
}

/** Карточка предмета «Входящих» — нажатием его номера в списке. */
async function inboxCard(d: Driver, kind: 'Бронь тура' | 'Заявка на подбор'): Promise<Said> {
  const list = await openScreen(d, 'Входящие');
  const b = list.buttons.find((x) => new RegExp(`^\\d+\\. ${kind}`).test(x.text));
  if (!b) throw new Error(`во «Входящих» нет «${kind}»: ${list.buttons.map((x) => x.text).join(', ')}`);
  return one(await d.press(b.payload), `карточка «${kind}» (${d.channel})`);
}

/** Экран, под которым таблица обещает кнопку: у «Входящих» — карточка предмета. */
async function screenWith(d: Driver, where: MenuName, row: DeskRow): Promise<Said> {
  if (where !== 'Входящие') return openScreen(d, where);
  return inboxCard(d, row.subject === 'lead' ? 'Заявка на подбор' : 'Бронь тура');
}

/** Строка меню — последней под ответом. */
function expectMenuUnder(s: Said, partner: typeof SELLER = SELLER): void {
  const row = menuOf(partner).map((b) => b.payload);
  expect(s.buttons.slice(-row.length).map((b) => b.payload)).toEqual(row);
}

/** Строка кабинета в чате — последней под его экраном: листает это же сообщение. */
const CABINET_NAV = ['cb:i', 'cb:t', 'cb:c', 'cb:m'];
function expectNavUnder(s: Said): void {
  expect(s.buttons.slice(-CABINET_NAV.length).map((b) => b.payload)).toEqual(CABINET_NAV);
}

// ── Границы ПД — после каждого прогона ──────────────────────────────────────

function expectPdBoundaries(): void {
  // Telegram: ни имени, ни телефона, ни почты, ни пожеланий — ни в тексте, ни в подписи кнопки.
  for (const c of m.tgSend.mock.calls) {
    const msg = JSON.stringify(c[0]);
    for (const v of PD) expect(msg, 'Telegram').not.toContain(v);
  }
  // MAX обычным ответом — тоже без ПД.
  for (const c of m.maxSend.mock.calls) {
    const msg = JSON.stringify([c[1], c[2]]);
    for (const v of PD) expect(msg, 'MAX обычным ответом').not.toContain(v);
  }
  // Имя и телефон — только sendPdAlert в этот чат MAX, без заглушки в Telegram;
  // почты и пожеланий нет и там.
  for (const c of m.pdAlert.mock.calls) {
    const a = c[0] as PdArgs;
    expect(a.to).toEqual({ maxChatId: GUIDE_CHAT, telegramChatId: null });
    for (const v of [EMAIL, WISH]) expect(a.text).not.toContain(v);
    for (const v of PD) expect(a.stub).not.toContain(v);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  clearMaxMessageDedup();
  for (const f of Object.values(m)) f.mockReset();
  db.owner = { max: String(GUIDE_USER), telegram: String(TG_CHAT) };
  db.bookings = [
    { id: '501', status: 'new', date: '2026-11-05', participants: 2, title: TOUR_TITLE, partner: SELLER.partnerId },
    { id: '502', status: 'confirmed', date: '2026-10-25', participants: 3, title: TOUR_TITLE, partner: SELLER.partnerId },
  ];
  db.leads = [{ id: LEAD, status: 'new', title: `Толбачик, звоните ${PHONE}`, people: 2, created_at: '2026-10-28T02:00:00Z', operator: SELLER.partnerId }];
  db.rows = [];
  db.writes = [];
  db.seq = 0;
  // Задача на сегодня, 15:00 по Камчатке: в MAX под ней «Готово» и «На завтра».
  db.tasks = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Уточнить состав группы', due_at: '2026-10-29T03:00:00.000Z', done_at: null, partner: SELLER.partnerId }];
  m.maxSend.mockResolvedValue({});
  m.maxSendUser.mockResolvedValue({});
  m.findPartner.mockResolvedValue({ outcome: 'found', partner: SELLER });
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.change.mockImplementation(async (a: { input: { booking_status: string } }) => ({
    kind: 'ok', changed: true, data: { booking_status: a.input.booking_status }, touristNotice: 'sent',
  }));
  m.changeLead.mockImplementation(async (a: { leadId: string; status: string }) => ({
    kind: 'ok', changed: true, prevStatus: 'new', lead: { id: a.leadId, status: a.status, notes: null },
  }));
  m.pdAlert.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено в MAX' });
  m.bookings.mockResolvedValue(OWN_BOOKINGS);
  m.tours.mockResolvedValue(OWN_TOURS);
  m.inbox.mockResolvedValue(INBOX);
  m.tgSend.mockResolvedValue({ success: true });
  m.team.mockResolvedValue({ state: 'none' });
  m.processPartner.mockResolvedValue(undefined);
  m.datesTours.mockResolvedValue([{ id: '77', title: TOUR_TITLE, active: true }]);
  m.preview.mockImplementation(async (input: { rows: Array<{ date: string }> }) => ({
    ok: true,
    tour: { title: TOUR_TITLE, maxParticipants: 8, isPublished: true, isActive: true, days: 1 },
    perDate: input.rows.map((r) => ({ date: r.date, result: 'opened' })),
  }));
  m.createProposal.mockResolvedValue({ kind: 'created', id: PROPOSAL });
  m.pressOpen.mockResolvedValue({
    kind: 'done',
    outcome: { kind: 'done', tourTitle: TOUR_TITLE, seats: 8, written: 5, perDate: [{ date: '2027-07-03', result: 'opened' }] },
  });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tg-test-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// ── Исходы ──────────────────────────────────────────────────────────────────

/** Справка, которую гид получает кнопкой «Помощь» в этом канале. */
async function helpIn(d: Driver, partner: typeof SELLER = SELLER): Promise<string> {
  return (await openScreen(d, 'Помощь', partner)).text;
}

const RUN: Record<Outcome, (d: Driver, row: DeskRow) => Promise<void>> = {
  async screen(d, row) {
    const s = await openScreen(d, row.name as MenuName);
    expect(s.text).toMatch(row.screen!);
    expect(s.viaPd).toBe(false);
    if (row.cabinet) expectNavUnder(s);
    else expectMenuUnder(s);
  },
  async screen_pd(d, row) {
    const s = await openScreen(d, row.name as MenuName);
    expect(s.text).toMatch(row.screen!);
    expect(s.viaPd).toBe(true);
    expect(s.text).toContain(PHONE);
    expectMenuUnder(s);
  },
  async ask_yes(d, row) {
    // Кнопка стоит под каждым экраном, где её обещает таблица.
    const screens: Said[] = [];
    for (const where of row.under!) {
      const s = await screenWith(d, where, row);
      buttonNamed(s, row.name);
      screens.push(s);
    }
    let ask = one(await d.press(buttonNamed(screens[0]!, row.name).payload), `вопрос «${row.name}»`);
    if (row.reason) {
      expect(ask.text).toMatch(/Напишите одним сообщением причину/);
      expect(ask.buttons.some((b) => labelIs(b.text, 'Да'))).toBe(false);
      ask = one(await d.say('Турист перенёс поездку'), 'вопрос с причиной');
    }
    expect(ask.text).toMatch(row.ask!);
    expectMenuUnder(ask);
    // До «Да» ничего не изменено.
    expect(m.change).not.toHaveBeenCalled();
    expect(m.changeLead).not.toHaveBeenCalled();
    const done = one(await d.press(buttonNamed(ask, 'Да').payload), `итог «${row.name}»`);
    expect(done.text).toMatch(row.done!);
    if (row.subject === 'booking') {
      expect(m.change).toHaveBeenCalledTimes(1);
      expect(m.change.mock.calls[0]![0]).toMatchObject({
        ownerPartnerId: SELLER.partnerId,
        actorUserId: SELLER.userId,
        input: { booking_status: row.status, ...(row.reason ? { cancellation_reason: 'Турист перенёс поездку' } : {}) },
        via: d.channel,
      });
    } else {
      expect(m.changeLead).toHaveBeenCalledTimes(1);
      expect(m.changeLead.mock.calls[0]![0]).toMatchObject({
        leadId: LEAD,
        status: row.status,
        scope: { kind: 'owner', partnerId: SELLER.partnerId, claimUnowned: false },
        via: d.channel,
      });
    }
  },
  async repeat(d) {
    const ask = one(await d.press(buttonNamed(await openScreen(d, 'Брони'), 'Подтвердить').payload), 'вопрос');
    const yes = buttonNamed(ask, 'Да');
    expect(one(await d.press(yes.payload), 'первое «Да»').text).toMatch(/^Бронь №501 подтверждена\./);
    expect(one(await d.press(yes.payload), 'повтор «Да»').text).toMatch(/^Уже нажато раньше\. Бронь №501 подтверждена\./);
    expect(m.change).toHaveBeenCalledTimes(1);
  },
  async kept(d) {
    const ask = one(await d.press(buttonNamed(await inboxCard(d, 'Бронь тура'), 'Подтвердить').payload), 'вопрос');
    expect(one(await d.press(buttonNamed(ask, 'Не надо').payload), '«Не надо»').text).toBe('Хорошо, бронь №501 без изменений.');
    expect(one(await d.press(buttonNamed(ask, 'Да').payload), '«Да» после «Не надо»').text).toBe('Это действие отменено — бронь №501 без изменений.');
    expect(m.change).not.toHaveBeenCalled();
  },
  async dates_open(d) {
    const phrase = namesIn(await helpIn(d)).find(isPhrase);
    if (!phrase) throw new Error('справка не называет фразу про даты');
    const offer = one(await d.say(phrase), 'предложение дат');
    expect(m.processPartner).not.toHaveBeenCalled();
    expect(m.preview.mock.calls[0]![0]).toMatchObject({ operatorId: SELLER.partnerId, tourId: '77' });
    expectMenuUnder(offer);
    const opened = one(await d.press(buttonNamed(offer, 'Открыть').payload), 'нажатие «Открыть»');
    expect(m.pressOpen).toHaveBeenCalledTimes(1);
    expect(m.pressOpen.mock.calls[0]!.slice(0, 3)).toEqual([SELLER.partnerId, GUIDE_CHAT, PROPOSAL]);
    // Итог и ссылки — раздел гида, не кабинет оператора.
    expect(opened.text).not.toMatch(/\/hub\/operator/);
    expect(m.processPartner).not.toHaveBeenCalled();
  },
  async task_done(d) {
    const tasks = await openScreen(d, 'Задачи');
    expect(tasks.text).toContain('Уточнить состав группы');
    const done = one(await d.press(buttonNamed(tasks, 'Готово').payload), '«Готово»');
    expect(done.text).toMatch(/^<b>Задачи<\/b>\n<i>Готово: «Уточнить состав группы»\.<\/i>/);
    expect(done.text).toContain('Открытых задач нет.');
    expect(db.tasks[0]!.done_at).not.toBeNull();
    expectNavUnder(done);
  },
  async task_tomorrow(d) {
    const tasks = await openScreen(d, 'Задачи');
    const moved = one(await d.press(buttonNamed(tasks, 'На завтра').payload), '«На завтра»');
    expect(moved.text).toContain('Перенёс «Уточнить состав группы» на завтра, 10:00.');
    // Завтра 10:00 по Камчатке — 30.10 в 22:00 UTC 29.10.
    expect(db.tasks[0]!.due_at).toBe('2026-10-29T22:00:00.000Z');
    expect(db.tasks[0]!.done_at).toBeNull();
    // Перенесённая на завтра — без «На завтра»: будущую кнопка не придвигает.
    expect(moved.buttons.some((b) => labelIs(b.text, 'На завтра'))).toBe(false);
    expectNavUnder(moved);
  },
  async max_only(d, row) {
    const tasks = await openScreen(d, 'Задачи');
    expect(tasks.buttons.some((b) => labelIs(b.text, row.name))).toBe(false);
    expect(tasks.text).not.toContain('Уточнить состав группы');
    expect(tasks.text).toContain('они в MAX и в кабинете');
    expect(db.writes).toEqual([]);
  },
  async dates_link(d) {
    const phrase = namesIn(await helpIn(d)).find(isPhrase);
    if (!phrase) throw new Error('справка не называет фразу про даты');
    const reply = one(await d.say(phrase), 'ответ на фразу про даты');
    expect(reply.text).toBe(telegramDatesText('guide'));
    expect(reply.text).toMatch(/\/hub\/guide\/own/);
    expect(reply.buttons.some((b) => labelIs(b.text, 'Открыть'))).toBe(false);
    expect(m.createProposal).not.toHaveBeenCalled();
    expect(m.processPartner).not.toHaveBeenCalled();
  },
};

const OUTCOME_WORDS: Record<Outcome, string> = {
  screen: 'экран под строкой меню',
  screen_pd: 'экран с контактами — только через sendPdAlert в этот чат',
  ask_yes: 'вопрос, затем «Да» — правило с этим каналом',
  repeat: '«Да» исполняет один раз, повтор — прежний итог',
  kept: '«Не надо» — без изменений, «Да» того же вопроса не исполняется',
  dates_open: 'фраза — предложение с «Открыть», нажатие пишет даты карточки гида',
  dates_link: 'фраза — «это в MAX» со ссылкой в «Свои туры», без кнопки',
  task_done: 'кнопка «Задач» отмечает задачу, экран — с отметкой',
  task_tomorrow: 'кнопка «Задач» переносит на завтра 10:00, экран — с отметкой',
  max_only: 'кнопки здесь нет: заголовки задач — только в MAX',
};

describe('таблица: каждое действие гида-продавца в каждом канале доходит до своего исхода', () => {
  for (const row of DESK) {
    for (const ch of CHANNELS) {
      it(`«${row.name}» · ${ch}: ${OUTCOME_WORDS[row[ch]]}`, async () => {
        await RUN[row[ch]](DRIVERS[ch], row);
        expectPdBoundaries();
      });
    }
  }

  // Команды чата Telegram ставятся из вкладок и «Ещё» (roleChatCommands):
  // команда без обработчика была бы той же кнопкой в никуда. У «Ещё» команды нет.
  it('telegram: каждая команда чата из вкладок и «Ещё» открывает тот же экран, что её кнопка', async () => {
    const commands = roleChatCommands([...menuOf(SELLER), ...partnerMenuExtras(SELLER)]);
    expect(commands.map((c) => c.description)).toEqual([...MENU_NAMES.filter((n) => n !== 'Ещё'), ...MORE_NAMES]);
    for (const c of commands) {
      const row = DESK.find((r) => r.name === c.description)!;
      const s = one(await tgDriver.say(`/${c.command}`), `/${c.command}`);
      expect(s.text, `/${c.command}`).toMatch(row.screen!);
      if (row.cabinet) expectNavUnder(s);
      else expectMenuUnder(s);
    }
    expect(m.processPartner).not.toHaveBeenCalled();
    expectPdBoundaries();
  });
});

// ── Справка ↔ таблица ───────────────────────────────────────────────────────

describe('справка называет ровно таблицу', () => {
  for (const ch of CHANNELS) {
    it(`${ch}: продавец — каждое имя справки есть в таблице, каждая строка таблицы названа`, async () => {
      const help = await helpIn(DRIVERS[ch]);
      const names = namesIn(help);
      expect(names.filter((n) => resolveName(n, 'seller') === null), 'названо, но в чате этого нет').toEqual([]);
      const named = new Set(names.map((n) => ALIASES[n] ?? n));
      const silent = DESK.filter((r) => r.namedBy === 'help' && !named.has(r.name)).map((r) => r.name);
      expect(silent, 'в таблице есть, справка молчит').toEqual([]);
      // Перечень вкладок — ровно строка под ответом; «Ещё» — ровно экран «Ещё».
      expect(tabsIn(help)).toEqual(MENU_NAMES);
      expect(tabsIn(help)).toEqual(menuOf(SELLER).map((b) => b.text));
      const more = await openScreen(DRIVERS[ch], 'Ещё');
      expect(moreIn(help)).toEqual([...MORE_NAMES, 'кабинет на сайте']);
      for (const name of MORE_NAMES) buttonNamed(more, name);
      expectPdBoundaries();
    });

    it(`${ch}: «Обсуждаем» и «Свои туры» — только в кабинете: ссылка в справке есть, кнопки в чате нет`, async () => {
      const help = await helpIn(DRIVERS[ch]);
      expect(help).toMatch(/https?:\/\/\S+\/hub\/guide\/own/);
      const shown = [
        await openScreen(DRIVERS[ch], 'Входящие'), await inboxCard(DRIVERS[ch], 'Бронь тура'),
        await inboxCard(DRIVERS[ch], 'Заявка на подбор'), await openScreen(DRIVERS[ch], 'Брони'),
      ];
      for (const s of shown) {
        for (const site of SITE_ONLY) expect(s.buttons.some((b) => labelIs(b.text, site)), site).toBe(false);
      }
    });

    it(`${ch}: гид команды без своих туров — вкладки те же, в «Ещё» только «Помощь»; кнопки продавца — отказ без чтения и записи`, async () => {
      m.findPartner.mockResolvedValue({ outcome: 'found', partner: TEAM });
      const d = DRIVERS[ch];
      const help = await helpIn(d, TEAM);
      expect(namesIn(help).filter((n) => resolveName(n, 'team') === null), 'названо, но гиду команды этого нет').toEqual([]);
      expect(tabsIn(help)).toEqual(MENU_NAMES);
      expect(moreIn(help)).toEqual(['Помощь', 'кабинет на сайте']);
      const more = await openScreen(d, 'Ещё', TEAM);
      for (const name of ['Брони', 'Мои туры']) expect(more.buttons.some((b) => b.text === name), name).toBe(false);
      // Карточка брони во «Входящих» гида команды — без кнопок ответа.
      const card = await inboxCard(d, 'Бронь тура');
      expect(card.buttons.some((b) => /^(?:bk|ld|oc):/.test(b.payload))).toBe(false);
      for (const payload of ['rm:gd:bk', 'rm:gd:tr']) {
        expect(one(await d.press(payload), payload).text).toBe(GUIDE_NO_OWN_TOURS);
      }
      for (const payload of [bookingPressPayload('confirm', '501'), leadPressPayload('contacted', LEAD), answerPressPayload(true, PROPOSAL)]) {
        expect(one(await d.press(payload), payload).text).toBe(OWNER_ACTION_TEXT.notThis);
      }
      expect(m.bookings).not.toHaveBeenCalled();
      expect(m.tours).not.toHaveBeenCalled();
      expect(db.writes).toEqual([]);
      expect(m.change).not.toHaveBeenCalled();
      expect(m.changeLead).not.toHaveBeenCalled();
      expectPdBoundaries();
    });
  }
});

// ── Тексты привязки и приветствия ───────────────────────────────────────────

describe('тексты привязки и приветствия называют только то, что есть', () => {
  const bound = (sellsTours: boolean) => ({
    ok: true as const, partnerName: 'Гид Пробный', displayName: 'Гид Пробный', category: 'guide', slug: 'guide-desk',
    previousChatId: null, rebound: false, cabinetOf: null, others: [], partnerId: SELLER.partnerId, sellsTours,
  });

  for (const ch of CHANNELS) {
    it(`${ch}: привязка продавца называет кнопки таблицы, гида команды — только вкладки и «Помощь»`, () => {
      for (const [who, sells] of [['seller', true], ['team', false]] as const) {
        const text = channelBoundText(ch, bound(sells));
        const names = namesIn(text);
        expect(names.filter((n) => resolveName(n, who, 'Гид Пробный') === null), `${who}: названо, но этого нет`).toEqual([]);
        // Кнопки, которые текст называет «под этим сообщением», — ровно строка меню.
        const under = /Кнопки под этим сообщением — кабинет в чате: ([^.]+)\./.exec(text)?.[1];
        expect(under?.split(', ').map((s) => s.replace(/[«»]/g, ''))).toEqual(menuOf(sells ? SELLER : TEAM).map((b) => b.text));
      }
    });
  }

  it('приветствие Telegram гиду не обещает кнопок: под ним их нет', () => {
    const text = buildWelcomeText({ telegramId: TG_CHAT, name: 'Гид', role: 'guide', isNewUser: true }, { tours: 1 });
    expect(namesIn(text)).toEqual([]);
    expect(text).not.toMatch(/кнопк/i);
    expect(text).toMatch(/\/hub\/guide/);
  });
});

// ── Экран «Брони»: Telegram-ветка без полей ПД ──────────────────────────────

describe('экран «Брони»: Telegram-ветка без полей ПД', () => {
  it('withoutPd отдаёт бронь без имени, телефона, почты и пожеланий', () => {
    const clean = withoutPd(OWN_BOOKINGS[0]!);
    expect(Object.keys(clean).filter((k) => /^tourist_|special_requests/.test(k))).toEqual([]);
    for (const v of PD) expect(JSON.stringify(clean)).not.toContain(v);
  });

  it('запрет: Telegram-ветка (withoutPd, guideBookingsTelegramText) не читает tourist_* и special_requests', () => {
    const src = readFileSync(join(process.cwd(), 'lib/guides/chat-screens.ts'), 'utf8');
    for (const head of ['export function withoutPd', 'export function guideBookingsTelegramText']) {
      const from = src.indexOf(head);
      expect(from, head).toBeGreaterThan(-1);
      const body = src.slice(from, src.indexOf('\n}\n', from));
      expect(body, head).not.toMatch(/tourist_(?:name|phone|email)|special_requests/);
    }
  });
});

// ── Правка своего тура фразой (30.10) ───────────────────────────────────────

describe('правка своего тура фразой: «было → станет», в тур пишет только кнопка', () => {
  for (const ch of CHANNELS) {
    it(`${ch}: «Горелый: цена 16000» — предпросмотр с «Сохранить» и «Отмена»; помощник фразу не получает, тур не тронут`, async () => {
      const s = one(await DRIVERS[ch].say('Горелый: цена 16000'), `правка тура (${ch})`);
      expect(s.text).toMatch(/^<b>Восхождение на Горелый<\/b> — Цена/);
      const words = s.text.replace(/\u00a0/g, ' ');
      expect(words).toContain('Было: 15 000 ₽ за человека');
      expect(words).toContain('Станет: <b>16 000 ₽ за человека</b>');
      expect(buttonNamed(s, 'Сохранить').payload).toMatch(/^cb:e:s:[0-9a-f-]{36}$/);
      expect(buttonNamed(s, 'Отмена').payload).toMatch(/^cb:e:x:[0-9a-f-]{36}$/);
      expect(m.processPartner).not.toHaveBeenCalled();
      expect(db.writes.filter((w) => /UPDATE operator_tours/.test(w))).toEqual([]);
      expect(db.writes.filter((w) => /INSERT INTO tour_chat_edits/.test(w))).toHaveLength(1);
      expectPdBoundaries();
    });
  }
});
