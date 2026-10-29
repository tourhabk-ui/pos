/**
 * Экраны кабинета в чате — тексты и кнопки, без базы и сети. Данные
 * приносит сервис (lib/chat-cabinet/service) теми же функциями, что кабинет
 * на сайте, Кузьмич и MCP партнёра: loadInbox, listTasks, listContacts,
 * getContactCard. Своего отбора здесь нет.
 *
 * Канал решает, что на экране:
 *  - MAX — имя клиента, телефон (кнопкой «Скопировать»), заголовки задач и
 *    лента клиента: ПД партнёру — только в MAX (решение владельца 23.08);
 *  - Telegram — без имён, телефонов и заголовков задач: «Входящие» и
 *    карточки предметов (тур, дата, люди, кнопки ответа), счёт задач и
 *    клиентов и ссылка в кабинет. Так же устроены напоминания о задачах:
 *    «заголовки задач и имена клиентов в Telegram не пересылаются».
 *    Экран с `pd: true` вызывающий в Telegram не отдаёт ни при какой правке
 *    этого модуля (второй замок — в сервисе).
 *
 * Внизу каждого экрана — строка кабинета: «Входящие», «Задачи», «Клиенты»,
 * «Ещё». Её кнопки (`cb:`) правят это же сообщение, а не шлют новое: кабинет
 * листается, а не засыпает чат.
 *
 * Всё, что ввели люди (тур, заметка, имя, тег), экранируется: HTML разбирает
 * мессенджер.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { ROLE_HUB } from '@/lib/auth/role-routes';
import { INBOX_KIND_LABELS, inboxActionFor, type InboxKind } from '@/lib/crm/inbox-kinds';
import type { Inbox, InboxItem } from '@/lib/crm/inbox';
import type { TaskItem } from '@/lib/crm/tasks';
import type { ContactCard, ContactListItem } from '@/lib/crm/contact-queries';
import { contactLabel } from '@/lib/crm/tools';
import { inboxItemField, inboxItemLine, waitingAge } from '@/lib/roles/inbox-text';
import { bookingAnswerButtons, leadAnswerButtons } from '@/lib/bookings/chat-owner-press';
import { chatAnswerButtons } from '@/lib/requests/chat-answer';
import { isChatTargetId, ownerReplyButton } from '@/lib/requests/request-chat';
import { kamchatkaDate, ruShort, shiftDate } from '@/lib/analytics/kamchatka-day';
import { cabinetPayload, type RemindWhen, type TouchOutcome } from '@/lib/chat-cabinet/payload';

export type CabinetChannel = 'max' | 'telegram';

/** Роль кабинета в чате — та же, что у строки меню (lib/roles/role-menu). */
export type CabinetRole = 'operator' | 'transfer' | 'stay' | 'guide';

export type CabinetButton =
  | { text: string; payload: string; intent?: 'positive' | 'negative' }
  | { text: string; url: string }
  /** Скопировать в буфер — только MAX (кнопка `clipboard`). */
  | { text: string; copy: string };

export interface CabinetScreen {
  text: string;
  rows: CabinetButton[][];
  /** В тексте или кнопках имя или телефон клиента: экран только для MAX. */
  pd: boolean;
}

/** Что карточке чата включено — решает сервис по карточке партнёра. */
export interface CabinetPartner {
  partnerId: string;
  role: CabinetRole;
  /** «Подтвердить» / «Отклонить» под бронью (lib/bookings/chat-owner-press). */
  bookingActions: boolean;
  /** «Связался» / «Договорились» / «Отказ» под заявкой — гид со своими турами. */
  leadActions: boolean;
  /** «Принять» / «Нет мест» / «Уточнить» / «Свяжусь сам» под заявкой — туроператор. */
  operatorAnswers: boolean;
  /** Продаёт свои туры: «Мои туры» и «Обновить места» в «Ещё». */
  sellsTours: boolean;
  /** Сводка запросов мест включена (пилот). */
  summary: boolean;
}

export const INBOX_PAGE_SIZE = 6;
export const TASKS_PAGE_SIZE = 5;
export const CLIENTS_PAGE_SIZE = 6;
/** Сколько событий ленты и обращений показывает карточка клиента. */
export const CARD_EVENTS = 5;
export const CARD_SOURCES = 3;
/** Запрос поиска длиннее — обрезается: имя и хвост номера короче. */
export const SEARCH_QUERY_MAX = 60;

const BUTTON_TEXT_MAX = 40;

function clip(s: string, max = BUTTON_TEXT_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function siteUrl(base: string, role: CabinetRole, section: 'inbox' | 'tasks' | 'clients' | null = null): string {
  const hub = ROLE_HUB[role] ?? '/hub';
  return `${base.replace(/\/$/, '')}${hub}${section ? `/${section}` : ''}`;
}

/** Строка кабинета: правит это же сообщение. */
export function cabinetNavRow(): CabinetButton[] {
  return [
    { text: 'Входящие', payload: cabinetPayload.inbox() },
    { text: 'Задачи', payload: cabinetPayload.tasks() },
    { text: 'Клиенты', payload: cabinetPayload.clients() },
    { text: 'Ещё', payload: cabinetPayload.more() },
  ];
}

function screen(lines: Array<string | null | undefined>, rows: CabinetButton[][], pd = false): CabinetScreen {
  return {
    text: lines.filter((l): l is string => typeof l === 'string').join('\n'),
    rows: [...rows.filter((r) => r.length > 0), cabinetNavRow()],
    pd,
  };
}

function pages(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

function pageRow(page: number, total: number, size: number, to: (p: number) => string): CabinetButton[] {
  const row: CabinetButton[] = [];
  if (page > 0) row.push({ text: '‹ Назад', payload: to(page - 1) });
  if ((page + 1) * size < total) row.push({ text: 'Дальше ›', payload: to(page + 1) });
  return row;
}

function noticeLine(notice: string | null | undefined): string | null {
  return notice ? `<i>${notice}</i>` : null;
}

// ── Время по Камчатке ───────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const KAMCHATKA_OFFSET_MS = 12 * HOUR_MS;

function kamchatkaClock(at: Date): string {
  return new Date(at.getTime() + KAMCHATKA_OFFSET_MS).toISOString().slice(11, 16);
}

/** «сегодня 15:00», «завтра 10:00», «02.11 10:00» — по Камчатке. */
export function dueWords(dueIso: string, nowMs: number): string {
  const due = new Date(dueIso);
  const day = kamchatkaDate(due);
  const today = kamchatkaDate(new Date(nowMs));
  const when = day === today ? 'сегодня' : day === shiftDate(today, 1) ? 'завтра' : ruShort(day);
  return `${when} ${kamchatkaClock(due)}`;
}

/** ДД.ММ, если в поле ISO-дата; иначе null (свободный текст в кнопку не идёт). */
function isoShort(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? ruShort(v.slice(0, 10)) : null;
}

// ── Входящие ────────────────────────────────────────────────────────────────

export function inboxScreen(inbox: Inbox, page: number, opts: { notice?: string | null } = {}): CabinetScreen {
  const total = inbox.items.length;
  const last = pages(total, INBOX_PAGE_SIZE) - 1;
  const p = Math.min(Math.max(page, 0), last);
  const shown = inbox.items.slice(p * INBOX_PAGE_SIZE, (p + 1) * INBOX_PAGE_SIZE);
  const lines: Array<string | null> = ['<b>Входящие</b>', noticeLine(opts.notice)];
  if (inbox.failed.length > 0) {
    lines.push(`Не прочиталось: ${inbox.failed.map((k) => INBOX_KIND_LABELS[k]).join(', ')}. Это не «таких нет».`);
    lines.push(`Среди прочитанного ждут ответа: ${total}.`);
  } else {
    lines.push(total === 0 ? 'Ждут ответа: нет.' : `Ждут ответа: ${total}.`);
  }
  shown.forEach((item, i) => lines.push(`${p * INBOX_PAGE_SIZE + i + 1}. ${inboxItemLine(item)}`));
  if (last > 0) lines.push(`Страница ${p + 1} из ${last + 1}.`);
  if (inbox.chat.state === 'ok' && inbox.chat.unread > 0) {
    lines.push(`Непрочитанных сообщений в чате кабинета: ${inbox.chat.unread}.`);
  } else if (inbox.chat.state === 'failed') {
    lines.push('Непрочитанные сообщения чата не посчитались.');
  }
  for (const note of inbox.not_here) lines.push(escapeHtml(note));
  if (shown.length > 0) lines.push('Номер ниже открывает карточку с кнопками ответа. Имени и телефона в этом списке нет.');
  const items: CabinetButton[][] = shown.map((item, i) => {
    const date = isoShort(item.date);
    return [{
      text: clip(`${p * INBOX_PAGE_SIZE + i + 1}. ${INBOX_KIND_LABELS[item.kind]}${date ? ` · ${date}` : ''}`),
      payload: cabinetPayload.item(item.kind, item.id),
    }];
  });
  return screen(lines, [...items, pageRow(p, total, INBOX_PAGE_SIZE, cabinetPayload.inbox)]);
}

/** Звонок и напоминание о клиенте — две строки кнопок. Имени в них нет. */
function contactActionRows(contactId: string): CabinetButton[][] {
  const touch = (o: TouchOutcome, text: string): CabinetButton => ({ text, payload: cabinetPayload.touch(o, contactId) });
  const remind = (w: RemindWhen, text: string): CabinetButton => ({ text, payload: cabinetPayload.remind(w, contactId) });
  return [
    [touch('reached', 'Дозвонился'), touch('missed', 'Не дозвонился'), touch('agreed', 'Договорились')],
    [remind('hour', 'Через час'), remind('tomorrow', 'Завтра 10:00'), remind('days3', 'Через 3 дня')],
  ];
}

const CONTACT_ACTIONS_LINE = 'Звонок отметьте кнопкой — он ляжет в ленту клиента. «Через час», «Завтра 10:00», «Через 3 дня» заводят задачу связаться с клиентом.';

export function itemCardScreen(args: {
  item: InboxItem;
  partner: CabinetPartner;
  channel: CabinetChannel;
  base: string;
  notice?: string | null;
}): CabinetScreen {
  const { item, partner, channel } = args;
  const lines: Array<string | null> = [`<b>${INBOX_KIND_LABELS[item.kind]}</b>`, noticeLine(args.notice)];
  if (item.title) lines.push(`«${escapeHtml(inboxItemField(item, item.title))}»`);
  const facts: string[] = [];
  if (item.date) facts.push(escapeHtml(inboxItemField(item, item.date)));
  if (item.people !== null) facts.push(`${item.people} чел`);
  if (facts.length) lines.push(facts.join(' · '));
  lines.push(`Ждёт ответа: ${waitingAge(item.waiting_minutes)}.`);
  const showName = channel === 'max' && item.contact_id !== null;
  if (showName) lines.push(`Клиент: ${escapeHtml(contactLabel(item.contact_name))}`);

  const rows: CabinetButton[][] = [];
  const action = inboxActionFor(partner.role, item.kind);
  if (item.kind === 'operator_booking' && partner.bookingActions) {
    rows.push(bookingAnswerButtons(item.id));
    lines.push('«Подтвердить» и «Отклонить»: бот спросит, и бронь меняется только после «Да». Отклонение — с причиной, её получит турист.');
  } else if (item.kind === 'lead' && partner.leadActions) {
    rows.push(leadAnswerButtons(item.id, null));
    lines.push('Отметка заявки — после «Да»; туристу ничего не уходит.');
  } else if (item.kind === 'lead' && partner.operatorAnswers) {
    const answers = chatAnswerButtons(null, 'lead', item.id);
    rows.push(answers.slice(0, 2), answers.slice(2));
    lines.push('Ответ записывается сразу; бронь им не подтверждается.');
  } else {
    lines.push(`Где ответить: ${escapeHtml(action.hint)}.`);
  }
  // Переписка с клиентом по заявке — только MAX (1349, 1350).
  if (channel === 'max' && item.kind === 'stay_request' && isChatTargetId(item.id)) {
    rows.push([ownerReplyButton({ kind: 'stay', id: item.id })]);
  }
  if (channel === 'max' && item.kind === 'lead' && isChatTargetId(item.id)) {
    rows.push([ownerReplyButton({ kind: 'lead', id: item.id })]);
  }
  if (item.contact_id) {
    rows.push(...contactActionRows(item.contact_id));
    lines.push(CONTACT_ACTIONS_LINE);
    if (channel === 'max') rows.push([{ text: clip(`Клиент: ${contactLabel(item.contact_name)}`), payload: cabinetPayload.client(item.contact_id) }]);
  }
  const href = action.href ? `${args.base.replace(/\/$/, '')}${action.href}` : siteUrl(args.base, partner.role, 'inbox');
  rows.push([{ text: 'Открыть в кабинете', url: href }]);
  rows.push([{ text: '‹ Входящие', payload: cabinetPayload.inbox() }]);
  return screen(lines, rows, showName);
}

export const ITEM_GONE = 'Этого во «Входящих» уже нет: на него ответили, или срок ответа прошёл.';

export function itemGoneScreen(inbox: Inbox): CabinetScreen {
  return inboxScreen(inbox, 0, { notice: ITEM_GONE });
}

// ── Задачи ──────────────────────────────────────────────────────────────────

function tomorrowStartMs(nowMs: number): number {
  const today = kamchatkaDate(new Date(nowMs));
  const [y, m, d] = shiftDate(today, 1).split('-').map(Number);
  return Date.UTC(y, m - 1, d) - KAMCHATKA_OFFSET_MS;
}

/** «На завтра» — только просроченной и сегодняшней: будущую задачу кнопка не придвигает. */
export function canMoveToTomorrow(task: Pick<TaskItem, 'due_at'>, nowMs: number): boolean {
  return Date.parse(task.due_at) < tomorrowStartMs(nowMs);
}

/** 10:00 по Камчатке через `days` суток от сегодняшней камчатской даты. */
export function kamchatkaMorning(nowMs: number, days: number): Date {
  const [y, m, d] = shiftDate(kamchatkaDate(new Date(nowMs)), days).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 10) - KAMCHATKA_OFFSET_MS);
}

function taskCounts(tasks: readonly TaskItem[], nowMs: number): { overdue: number; today: number } {
  const tomorrow = tomorrowStartMs(nowMs);
  let overdue = 0;
  let today = 0;
  for (const t of tasks) {
    const due = Date.parse(t.due_at);
    if (due < nowMs) overdue += 1;
    else if (due < tomorrow) today += 1;
  }
  return { overdue, today };
}

export function tasksScreen(args: {
  tasks: readonly TaskItem[];
  page: number;
  channel: CabinetChannel;
  role: CabinetRole;
  base: string;
  nowMs: number;
  notice?: string | null;
}): CabinetScreen {
  const { tasks, channel, nowMs } = args;
  const total = tasks.length;
  const c = taskCounts(tasks, nowMs);
  const lines: Array<string | null> = ['<b>Задачи</b>', noticeLine(args.notice)];
  lines.push(total === 0
    ? 'Открытых задач нет.'
    : `Открытых: ${total} · просрочено: ${c.overdue} · на сегодня: ${c.today}.`);
  const link: CabinetButton[] = [{ text: 'Задачи в кабинете', url: siteUrl(args.base, args.role, 'tasks') }];
  if (channel === 'telegram') {
    if (total > 0) {
      lines.push(`Ближайший срок: ${dueWords(tasks[0]!.due_at, nowMs)}.`);
      lines.push('Заголовки задач и имена клиентов в Telegram не показываю — они в MAX и в кабинете.');
    }
    return screen(lines, [link]);
  }
  const last = pages(total, TASKS_PAGE_SIZE) - 1;
  const p = Math.min(Math.max(args.page, 0), last);
  const shown = tasks.slice(p * TASKS_PAGE_SIZE, (p + 1) * TASKS_PAGE_SIZE);
  const rows: CabinetButton[][] = [];
  shown.forEach((t, i) => {
    const n = p * TASKS_PAGE_SIZE + i + 1;
    const overdue = Date.parse(t.due_at) < nowMs ? ', просрочена' : '';
    const who = t.contact ? ` · ${escapeHtml(contactLabel(t.contact.display_name))}` : '';
    lines.push(`${n}. ${escapeHtml(t.title)} — ${dueWords(t.due_at, nowMs)}${overdue}${who}`);
    const row: CabinetButton[] = [{ text: `${n} · Готово`, payload: cabinetPayload.taskDone(t.id), intent: 'positive' }];
    if (canMoveToTomorrow(t, nowMs)) row.push({ text: `${n} · На завтра`, payload: cabinetPayload.taskTomorrow(t.id) });
    rows.push(row);
  });
  if (last > 0) lines.push(`Страница ${p + 1} из ${last + 1}.`);
  if (shown.length > 0) lines.push('«Готово» отмечает задачу, «На завтра» переносит её на завтра, 10:00.');
  rows.push(pageRow(p, total, TASKS_PAGE_SIZE, cabinetPayload.tasks), link);
  return screen(lines, rows, shown.length > 0);
}

// ── Клиенты ─────────────────────────────────────────────────────────────────

export const TELEGRAM_NO_NAMES = 'Имена и телефоны клиентов в Telegram не показываю — карточки клиентов в MAX и в кабинете.';

export function clientsScreen(args: {
  items: readonly ContactListItem[];
  total: number;
  page: number;
  channel: CabinetChannel;
  role: CabinetRole;
  base: string;
  notice?: string | null;
}): CabinetScreen {
  const link: CabinetButton[] = [{ text: 'Клиенты в кабинете', url: siteUrl(args.base, args.role, 'clients') }];
  const lines: Array<string | null> = ['<b>Клиенты</b>', noticeLine(args.notice)];
  lines.push(args.total === 0 ? 'Клиентов в CRM пока нет.' : `Всего: ${args.total}. Свежие сверху.`);
  if (args.channel === 'telegram') {
    if (args.total > 0) lines.push(TELEGRAM_NO_NAMES);
    return screen(lines, [link]);
  }
  const last = pages(args.total, CLIENTS_PAGE_SIZE) - 1;
  const p = Math.min(Math.max(args.page, 0), last);
  const rows: CabinetButton[][] = args.items.map((c) => [{
    text: clip(`${contactLabel(c.display_name)} · ${ruShort(kamchatkaDate(new Date(c.last_activity_at)))}`),
    payload: cabinetPayload.client(c.id),
  }]);
  if (last > 0) lines.push(`Страница ${p + 1} из ${last + 1}.`);
  if (args.items.length > 0) lines.push('Имя ниже открывает карточку: телефон, обращения, лента и кнопки звонка.');
  rows.push([{ text: 'Найти клиента', payload: cabinetPayload.search() }]);
  rows.push(pageRow(p, args.total, CLIENTS_PAGE_SIZE, cabinetPayload.clients), link);
  return screen(lines, rows, args.items.length > 0);
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  new: 'новая', pending: 'ждёт ответа', requested: 'ждёт ответа', confirmed: 'подтверждена',
  cancelled: 'отменена', completed: 'состоялась', no_show: 'не пришёл',
  contacted: 'связались', qualified: 'договорились', converted: 'бронь', lost: 'отказ',
};

export function clientCardScreen(args: {
  card: ContactCard;
  openTasks: number;
  role: CabinetRole;
  base: string;
  notice?: string | null;
}): CabinetScreen {
  const c = args.card;
  const lines: Array<string | null> = [`<b>${escapeHtml(c.display_name?.trim() || 'Клиент без имени')}</b>`, noticeLine(args.notice)];
  if (c.phone) lines.push(`Телефон: ${escapeHtml(c.phone)}`);
  if (c.email) lines.push(`Почта: ${escapeHtml(c.email)}`);
  if (c.tags.length) lines.push(`Метки: ${c.tags.map((t) => escapeHtml(t)).join(', ')}`);
  lines.push(`Последнее касание: ${ruShort(kamchatkaDate(new Date(c.last_activity_at)))}.`);
  const sources = c.sources.slice(0, CARD_SOURCES);
  if (sources.length) {
    lines.push('', '<b>Обращения</b>');
    for (const s of sources) {
      const bits = [s.title ? `«${escapeHtml(s.title)}»` : 'без названия'];
      const from = isoShort(s.date_from);
      if (from) bits.push(from);
      if (s.status) bits.push(escapeHtml(STATUS_WORDS[s.status] ?? s.status));
      lines.push(`• ${bits.join(' · ')}`);
    }
    if (c.sources.length > sources.length) lines.push(`…и ещё ${c.sources.length - sources.length}`);
  }
  const events = c.events.slice(0, CARD_EVENTS);
  if (events.length) {
    lines.push('', '<b>Лента</b>');
    for (const e of events) lines.push(`• ${ruShort(kamchatkaDate(new Date(e.occurred_at)))} ${escapeHtml(e.title)}`);
  }
  lines.push('', args.openTasks > 0 ? `Открытых задач по клиенту: ${args.openTasks}.` : 'Открытых задач по клиенту нет.');
  lines.push(CONTACT_ACTIONS_LINE);
  const rows: CabinetButton[][] = [];
  if (c.phone) rows.push([{ text: 'Скопировать телефон', copy: c.phone }]);
  rows.push(...contactActionRows(c.id));
  rows.push([{ text: 'Клиенты в кабинете', url: siteUrl(args.base, args.role, 'clients') }]);
  rows.push([{ text: '‹ Клиенты', payload: cabinetPayload.clients() }]);
  return screen(lines, rows, true);
}

export const CLIENT_NOT_FOUND = 'Такого клиента в вашей CRM нет — ничего не открыл.';

// ── Поиск ───────────────────────────────────────────────────────────────────

export const SEARCH_WAIT_MIN = 10;

export function searchPromptScreen(): CabinetScreen {
  return screen(
    [
      '<b>Найти клиента</b>',
      `Напишите одним сообщением имя, фамилию или последние 4 цифры телефона. Жду ${SEARCH_WAIT_MIN} минут.`,
      'Текст поиска никуда, кроме вашей CRM, не уходит.',
    ],
    [[{ text: 'Не надо', payload: cabinetPayload.searchCancel() }]],
  );
}

export function searchResultsScreen(args: {
  query: string;
  items: readonly ContactListItem[];
  total: number;
}): CabinetScreen {
  const q = escapeHtml(args.query);
  const lines: Array<string | null> = [`<b>Клиенты: «${q}»</b>`];
  if (args.total === 0) {
    lines.push('Никого не нашёл. Попробуйте часть имени или 4 последние цифры телефона.');
  } else {
    lines.push(args.total > args.items.length
      ? `Найдено: ${args.total}, показываю первых ${args.items.length}. Уточните запрос, если нужного нет.`
      : `Найдено: ${args.total}.`);
  }
  const rows: CabinetButton[][] = args.items.map((c) => [{
    text: clip(`${contactLabel(c.display_name)} · ${ruShort(kamchatkaDate(new Date(c.last_activity_at)))}`),
    payload: cabinetPayload.client(c.id),
  }]);
  rows.push([{ text: 'Искать ещё', payload: cabinetPayload.search() }, { text: '‹ Клиенты', payload: cabinetPayload.clients() }]);
  return screen(lines, rows, args.items.length > 0);
}

export const SEARCH_TELEGRAM = 'Поиск клиентов — в MAX и в кабинете: в Telegram имена клиентов не показываю.';

// ── Звонок и напоминание ────────────────────────────────────────────────────

export const TOUCH_TITLE: Readonly<Record<TouchOutcome, string>> = {
  reached: 'Звонок: дозвонился',
  missed: 'Звонок: не дозвонился',
  agreed: 'Договорились',
};

export const REMIND_TITLE = 'Связаться с клиентом';

export const REMIND_WORDS: Readonly<Record<RemindWhen, string>> = {
  hour: 'через час',
  tomorrow: 'на завтра, 10:00',
  days3: 'через 3 дня, 10:00',
};

/** Итог нажатия по клиенту: что записано, и куда дальше. */
export function contactResultScreen(args: {
  text: string;
  contactId: string;
  name: string | null;
  channel: CabinetChannel;
  offerRemind: boolean;
}): CabinetScreen {
  const who = args.channel === 'max' && args.name !== null ? ` Клиент: ${escapeHtml(contactLabel(args.name))}.` : '';
  const rows: CabinetButton[][] = [];
  if (args.offerRemind) {
    rows.push([
      { text: 'Через час', payload: cabinetPayload.remind('hour', args.contactId) },
      { text: 'Завтра 10:00', payload: cabinetPayload.remind('tomorrow', args.contactId) },
      { text: 'Через 3 дня', payload: cabinetPayload.remind('days3', args.contactId) },
    ]);
  }
  if (args.channel === 'max') rows.push([{ text: 'Карточка клиента', payload: cabinetPayload.client(args.contactId) }]);
  rows.push([{ text: 'Задачи', payload: cabinetPayload.tasks() }, { text: '‹ Входящие', payload: cabinetPayload.inbox() }]);
  const lines = [`${args.text}${who}`];
  if (args.offerRemind) lines.push('Напомнить себе связаться ещё раз — кнопкой ниже.');
  return screen(lines, rows, who !== '');
}

// ── Ещё ─────────────────────────────────────────────────────────────────────

const ROLE_CODE: Readonly<Record<CabinetRole, string>> = { operator: 'op', transfer: 'tf', stay: 'st', guide: 'gd' };

export function moreScreen(partner: CabinetPartner, base: string): CabinetScreen {
  const code = ROLE_CODE[partner.role];
  const lines: string[] = ['<b>Ещё</b>'];
  const rows: CabinetButton[][] = [];
  if (partner.role === 'operator') {
    rows.push([{ text: 'Мои туры и цены', payload: 'opd:tours' }, { text: 'Обновить места', payload: 'opd:seats' }]);
    lines.push('Мои туры и цены — живые туры и цена из каталога. Обновить места — где отметить занятость.');
  } else if (partner.role === 'guide' && partner.sellsTours) {
    rows.push([{ text: 'Брони', payload: `rm:${code}:bk` }, { text: 'Мои туры', payload: `rm:${code}:tr` }]);
    lines.push('Брони — ждут ответа и ближайшие. Мои туры — на сайте или черновик и открытые даты.');
  }
  if (partner.summary) {
    rows.push([{ text: 'Сводка', payload: `rm:${code}:sm` }]);
    lines.push('Сводка — числа по запросам мест, без имён.');
  }
  const help: CabinetButton[] = [{ text: 'Помощь', payload: `rm:${code}:hp` }];
  if (partner.role === 'operator') help.push({ text: 'Написать в поддержку', payload: 'sup:new' });
  rows.push(help);
  lines.push('Помощь — что умеет кабинет в чате.');
  rows.push([{ text: 'Кабинет на сайте', url: siteUrl(base, partner.role) }]);
  lines.push('Оплата через платформу не принимается.');
  return screen(lines, rows);
}

// ── Отказы ──────────────────────────────────────────────────────────────────

export const CABINET_TEXT = {
  notDialog: 'Кабинет в чате открывается в личном диалоге с ботом. Здесь ничего не открыл и не записал.',
  unchecked: 'Не удалось проверить, чей это чат. Ничего не открыл и не записал — попробуйте ещё раз.',
  notBound: 'Этот чат не подключён к кабинету партнёра. Подключить — ссылкой из кабинета на сайте.',
  noCabinet: 'В этом чате кабинета нет: у этой карточки своё меню.',
  unknownButton: 'Кнопка кабинета не распознана — ничего не открыл и не записал.',
  dbFailed: 'База не ответила — ничего не изменено. Попробуйте ещё раз или откройте кабинет на сайте.',
  inboxFailed: 'Входящие не прочитались — карточку не открыл. Это не «ничего нет».',
  telegramPd: 'Этот экран с именами и телефонами клиентов — только в MAX. Здесь его не показываю.',
} as const;

/** Короткий ответ без экрана данных: текст и строка кабинета. */
export function noticeScreen(text: string, withNav = true): CabinetScreen {
  return { text, rows: withNav ? [cabinetNavRow()] : [], pd: false };
}
