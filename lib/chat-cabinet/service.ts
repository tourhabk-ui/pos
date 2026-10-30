/**
 * Кабинет в чате: кто вправе, что читать, что писать (решение владельца
 * 30.10, «всё сразу + Telegram»). Экраны — lib/chat-cabinet/screens, форма
 * кнопок — lib/chat-cabinet/payload, вебхуки MAX и Telegram только
 * доставляют ответ (править это же сообщение или прислать новое).
 *
 * Четвёртая поверхность CRM, а не копия: читает и пишет теми же функциями,
 * что кабинет на сайте, Кузьмич и MCP партнёра (сторож crm-three-surfaces):
 * loadInbox, listTasks, completeTask, updateTask, createTask, listContacts,
 * getContactCard, addContactTouch. Бронь и заявка кнопкой — прежние модули
 * (lib/bookings/chat-owner-action, lib/requests/chat-answer): здесь только
 * кнопки, которые к ним ведут.
 *
 * Кто вправе:
 *  - личный диалог: в группе кнопку нажал бы любой участник, а на экранах
 *    MAX — имена и телефоны клиентов;
 *  - карточка — по чату сообщения с кнопкой (`findPartnerByChat`, три
 *    исхода): чат не подключён — «не подключён», база не ответила — «не
 *    смог проверить», а не «ничего нет» (§4.0). Заверенность апдейта
 *    проверяет вебхук до вызова (MAX — `verifiedOrigin`, Telegram — секрет
 *    вебхука);
 *  - запись (звонок, задача, отметка) — карточке этого чата: владение задачей
 *    и клиентом — условие в SQL самих функций CRM, чужое отвечает «не
 *    найдено». Пишет аккаунт карточки (`partners.user_id`), как отметка
 *    задачи кнопкой под напоминанием (lib/crm/chat-task-action).
 *
 * Повтор нажатия (MAX и Telegram повторяют апдейты) записи не удваивает:
 * отметка задачи повторно отвечает «уже закрыта», звонок с тем же итогом за
 * две минуты и напоминание на тот же срок второй раз не пишутся.
 *
 * ПД: экран с `pd: true` (имя или телефон клиента) в Telegram не отдаётся ни
 * при какой правке screens — второй замок здесь (`lockForChannel`). Текст
 * поиска клиента никуда, кроме CRM этого партнёра, не уходит: ни в модель,
 * ни в лог.
 */

import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { findPartnerByChat, type PartnerChatContext } from '@/lib/kuzmich/operator-chat';
import { menuRoleOf, roleMenuAsk } from '@/lib/roles/role-menu';
import { loadInbox, type Inbox } from '@/lib/crm/inbox';
import { completeTask, createTask, listTasks, updateTask } from '@/lib/crm/tasks';
import { getContactCard, listContacts } from '@/lib/crm/contact-queries';
import { addContactTouch } from '@/lib/crm/events';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { summaryEnabledFor } from '@/lib/seat-requests/summary';
import { bookingChatActionsEnabledFor, leadChatActionsEnabledFor } from '@/lib/bookings/chat-owner-press';
import { detectEmergency } from '@/lib/safety/sos-detector';
import { isWatchTrigger } from '@/lib/kuzmich/watch-flow';
import { escapeHtml } from '@/lib/text/escape-html';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { parseCabinetPress, type CabinetPress, type DigestMode, type RemindWhen, type TouchOutcome } from '@/lib/chat-cabinet/payload';
import { countCabinetUse, type CabinetUsageAction } from '@/lib/chat-cabinet/usage';
import { findMemberByChat } from '@/lib/operators/member-chat';
import {
  CABINET_TEXT, CLIENTS_PAGE_SIZE, CLIENT_NOT_FOUND, FLEET_TEXT, REMIND_TITLE, REMIND_WORDS, SEARCH_QUERY_MAX, SEARCH_TELEGRAM,
  SEARCH_WAIT_MIN, TELEGRAM_NO_NAMES, TOUCH_TITLE, canMoveToTomorrow, clientCardScreen, clientsScreen,
  busyScreen, carrierSummaryScreen, contactResultScreen, fleetScreen, inboxScreen, itemCardScreen, itemGoneScreen, kamchatkaMorning, moreScreen, noticeScreen,
  failedScreen, digestScreen, DIGEST_MEMBER, DIGEST_WORDS,
  searchPromptScreen, searchResultsScreen, tasksScreen,
  type CabinetChannel, type CabinetPartner, type CabinetScreen, type CabinetSeat,
} from '@/lib/chat-cabinet/screens';
import { listVehicles, updateVehicle } from '@/lib/transfers/service';
import { loadOwnDrafts, loadOwnPriceRows } from '@/lib/transfers/price-edit-store';
import { loadCarrierSummary } from '@/lib/transfers/carrier-summary-store';
import { loadOwnerBusy, setObjectBusy } from '@/lib/stay/busy-flow';
import { BUSY_TEXT, busySavedText } from '@/lib/stay/busy-dates';

interface Queryable {
  query: typeof pool.query;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function logFail(what: string, err: unknown): void {
  console.error(`[chat-cabinet] ${what} — отказ, SQLSTATE ${sqlstate(err)}`);
}

/**
 * Что карточке чата открыто в кабинете. null — кабинета в чате у неё нет.
 * Менеджер команды (`member`, чат из operator_members) видит то же, но без
 * кнопок ответа на бронь и заявку и без кнопок кабинета оператора: их вправе
 * нажимать только чат карточки (слово владельца 30.10).
 */
export function cabinetPartnerOf(p: PartnerChatContext, seat: CabinetSeat = 'owner'): CabinetPartner | null {
  const role = menuRoleOf(p);
  if (!role || p.crmCategory === null) return null;
  const owner = seat === 'owner';
  return {
    partnerId: p.partnerId,
    role,
    seat,
    bookingActions: owner && bookingChatActionsEnabledFor(p),
    leadActions: owner && leadChatActionsEnabledFor(p),
    operatorAnswers: owner && role === 'operator',
    sellsTours: sellsOwnTours(p),
    summary: owner && role === 'operator' && summaryEnabledFor(p.partnerId),
  };
}

type Ctx = { ctx: PartnerChatContext & { crmCategory: NonNullable<PartnerChatContext['crmCategory']> }; partner: CabinetPartner };
type Gate = ({ ok: true } & Ctx) | { ok: false; screen: CabinetScreen };

/**
 * Чей чат. Сначала чат карточки (владелец); не он — чат менеджера команды
 * (lib/operators/member-chat): до 30.10 кабинет отвечал менеджеру «чат не
 * подключён», хотя его чат записан. «Не смог проверить» любой из двух — не
 * «не подключён» (§4.0).
 */
async function gate(channel: CabinetChannel, chatId: number, privateChat: boolean): Promise<Gate> {
  if (!privateChat) {
    console.error(`[chat-cabinet] кнопка кабинета не из личного диалога (${channel}) — не выполнена`);
    return { ok: false, screen: noticeScreen(CABINET_TEXT.notDialog, false) };
  }
  const lookup = await findPartnerByChat(channel, chatId);
  if (lookup.outcome === 'unavailable') return { ok: false, screen: noticeScreen(CABINET_TEXT.unchecked, false) };
  if (lookup.outcome === 'found') return withPartner(lookup.partner);
  const member = await findMemberByChat(channel, chatId);
  if (member.outcome === 'unavailable') return { ok: false, screen: noticeScreen(CABINET_TEXT.unchecked, false) };
  if (member.outcome === 'ambiguous') return { ok: false, screen: noticeScreen(CABINET_TEXT.memberTwoTeams, false) };
  if (member.outcome === 'none') return { ok: false, screen: noticeScreen(CABINET_TEXT.notBound, false) };
  return withPartner(member.member.partner, 'member');
}

function withPartner(ctx: PartnerChatContext, seat: CabinetSeat = 'owner'): Gate {
  const partner = cabinetPartnerOf(ctx, seat);
  if (!partner || ctx.crmCategory === null) return { ok: false, screen: noticeScreen(CABINET_TEXT.noCabinet, false) };
  return { ok: true, ctx: { ...ctx, crmCategory: ctx.crmCategory }, partner };
}

function count(c: Ctx, channel: CabinetChannel, action: CabinetUsageAction, screen: CabinetScreen, nowMs: number): Promise<void> {
  return countCabinetUse({ partnerId: c.partner.partnerId, seat: c.partner.seat, channel, action, screen }, nowMs);
}

/** Второй замок: имя и телефон клиента — только в MAX. */
function lockForChannel(screen: CabinetScreen, channel: CabinetChannel): CabinetScreen {
  if (channel !== 'max' && screen.pd) {
    console.error('[chat-cabinet] экран с ПД собран для Telegram — не отдан');
    return noticeScreen(CABINET_TEXT.telegramPd);
  }
  return screen;
}

function base(): string {
  return getPublicBaseUrl();
}

// ── Чтения ──────────────────────────────────────────────────────────────────

async function readInbox(c: Ctx, nowMs: number): Promise<Inbox | null> {
  try {
    return await loadInbox(c.ctx.partnerId, c.ctx.crmCategory, c.ctx.userId, { nowMs });
  } catch (err) {
    logFail('входящие', err);
    return null;
  }
}

async function inboxView(c: Ctx, page: number, nowMs: number, notice?: string): Promise<CabinetScreen> {
  const inbox = await readInbox(c, nowMs);
  if (!inbox) return failedScreen(CABINET_TEXT.inboxFailed);
  return inboxScreen(inbox, page, { notice });
}

/**
 * Список не прочитался. После записи, которая прошла (`notice` — её итог),
 * «ничего не изменено» было бы неправдой: итог записи остаётся, отказ — списка.
 */
function listFailedScreen(notice?: string): CabinetScreen {
  return failedScreen(notice ? `${notice}\n${CABINET_TEXT.listFailed}` : CABINET_TEXT.dbFailed);
}

async function tasksView(c: Ctx, channel: CabinetChannel, page: number, nowMs: number, notice?: string): Promise<CabinetScreen> {
  try {
    const tasks = await listTasks(c.ctx.partnerId, { status: 'open' });
    return tasksScreen({ tasks, page, channel, role: c.partner.role, base: base(), nowMs, notice });
  } catch (err) {
    logFail('задачи', err);
    return listFailedScreen(notice);
  }
}

async function clientsView(c: Ctx, channel: CabinetChannel, page: number, notice?: string): Promise<CabinetScreen> {
  try {
    // В Telegram имён нет — нужен только счёт.
    const size = channel === 'max' ? CLIENTS_PAGE_SIZE : 0;
    let p = Math.max(0, page);
    let list = await listContacts(c.ctx.partnerId, { limit: size, offset: p * size });
    if (size > 0 && list.items.length === 0 && list.total > 0 && p > 0) {
      p = Math.ceil(list.total / size) - 1;
      list = await listContacts(c.ctx.partnerId, { limit: size, offset: p * size });
    }
    return clientsScreen({ items: list.items, total: list.total, page: p, channel, role: c.partner.role, base: base(), notice });
  } catch (err) {
    logFail('клиенты', err);
    return listFailedScreen(notice);
  }
}

async function clientView(c: Ctx, channel: CabinetChannel, contactId: string, notice?: string): Promise<CabinetScreen> {
  if (channel !== 'max') return clientsView(c, channel, 0, TELEGRAM_NO_NAMES);
  try {
    const card = await getContactCard(c.ctx.partnerId, contactId);
    if (!card) return clientsView(c, channel, 0, CLIENT_NOT_FOUND);
    const open = await listTasks(c.ctx.partnerId, { status: 'open', contactId });
    return clientCardScreen({ card, openTasks: open.length, role: c.partner.role, base: base(), notice });
  } catch (err) {
    logFail('карточка клиента', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
}

async function itemView(c: Ctx, channel: CabinetChannel, press: Extract<CabinetPress, { kind: 'item' }>, nowMs: number): Promise<CabinetScreen> {
  const inbox = await readInbox(c, nowMs);
  if (!inbox) return failedScreen(CABINET_TEXT.inboxFailed);
  const item = inbox.items.find((i) => i.kind === press.item && i.id.toLowerCase() === press.id);
  if (item) return itemCardScreen({ item, partner: c.partner, channel, base: base() });
  // Вид не прочитался — «не знаю», а не «уже ответили» (§4.0).
  if (inbox.failed.includes(press.item)) return { ...inboxScreen(inbox, 0, { notice: CABINET_TEXT.inboxFailed }), failed: true };
  return itemGoneScreen(inbox);
}

/** Экран раздела без нажатия: кнопка строки меню (`rm:`), команда или слово. */
export type CabinetSection = 'inbox' | 'tasks' | 'clients' | 'more' | 'busy';

async function sectionView(c: Ctx, channel: CabinetChannel, section: CabinetSection, nowMs: number): Promise<CabinetScreen> {
  if (section === 'inbox') return inboxView(c, 0, nowMs);
  if (section === 'tasks') return tasksView(c, channel, 0, nowMs);
  if (section === 'clients') return clientsView(c, channel, 0);
  if (section === 'busy') return busyView(c, nowMs);
  return moreView(c);
}

/**
 * Раздел кабинета для карточки, которую вызывающий уже прочитал по чату
 * (текст «Входящие», команда /requests, кнопка строки меню). Личный диалог —
 * забота вызывающего: в группе он сюда не идёт. `seat` — чей чат: карточки
 * или менеджера команды (его карточку вызывающий взял из lib/operators/member-chat).
 */
export async function cabinetSectionFor(
  partner: PartnerChatContext,
  channel: CabinetChannel,
  section: CabinetSection,
  nowMs: number = Date.now(),
  seat: CabinetSeat = 'owner',
): Promise<CabinetScreen> {
  const g = withPartner(partner, seat);
  if (!g.ok) return g.screen;
  const out = lockForChannel(await sectionView(g, channel, section, nowMs), channel);
  await count(g, channel, `open_${section}`, out, nowMs);
  return out;
}

/**
 * Раздел кабинета по тексту менеджера команды в его чате: слово меню
 * («Входящие», «Задачи», «Клиенты», «Помощь») или команда. Строки меню роли у
 * менеджера нет, и всё прочее — «Мои туры и цены», «Обновить места», /start,
 * /help — открывает его «Ещё»: там сказано, что из этого у владельца. null —
 * текст не про кабинет, и чат его не перехватывает.
 */
export function memberCabinetSectionOf(text: string): CabinetSection | null {
  const head = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (head === '/requests') return 'inbox';
  if (head === '/tasks') return 'tasks';
  if (head === '/clients') return 'clients';
  if (head === '/start' || head === '/help') return 'more';
  if (head.startsWith('/')) return null;
  const asked = roleMenuAsk(text);
  if (asked === 'inbox' || asked === 'tasks' || asked === 'clients') return asked;
  if (asked === 'help' || asked === 'tours' || asked === 'seats') return 'more';
  return null;
}

// ── Ежедневная сводка: когда приходит (1354) ───────────────────────────────

export const DIGEST_MODE_SQL = `SELECT digest FROM chat_cabinet_settings WHERE partner_id = $1::uuid`;

export const DIGEST_SET_SQL = `
  INSERT INTO chat_cabinet_settings (partner_id, digest, updated_at, updated_by)
  VALUES ($1::uuid, $2, NOW(), $3::uuid)
  ON CONFLICT (partner_id) DO UPDATE
     SET digest = EXCLUDED.digest, updated_at = NOW(), updated_by = EXCLUDED.updated_by`;

function isDigestMode(v: unknown): v is DigestMode {
  return v === 'morning' || v === 'day' || v === 'evening' || v === 'off';
}

/** Когда приходит сводка карточки. Строки нет — утром; не прочиталось — null (§4.0). */
async function readDigestMode(partnerId: string): Promise<DigestMode | null> {
  try {
    const { rows: [row] } = await pool.query<{ digest: string }>(DIGEST_MODE_SQL, [partnerId]);
    if (!row) return 'morning';
    return isDigestMode(row.digest) ? row.digest : null;
  } catch (err) {
    logFail('время сводки', err);
    return null;
  }
}

async function moreView(c: Ctx): Promise<CabinetScreen> {
  if (c.partner.seat === 'member') return moreScreen(c.partner, base());
  return moreScreen(c.partner, base(), await readDigestMode(c.partner.partnerId));
}

async function digestView(c: Ctx): Promise<CabinetScreen> {
  if (c.partner.seat === 'member') return noticeScreen(DIGEST_MEMBER);
  const mode = await readDigestMode(c.partner.partnerId);
  return mode === null ? failedScreen(CABINET_TEXT.dbFailed) : digestScreen(mode);
}

/**
 * Сегодняшняя строка сводки после смены времени (ревью 30.10): `empty` —
 * прогон утра решил «ждать нечего», сообщения не было, и строка снимается,
 * чтобы новое окно сегодня посмотрело заново (второй сводки так не бывает —
 * первой не было). Ушедшая или уходящая — остаётся, и экран говорит
 * «по новому времени — с завтра».
 */
export const DIGEST_TODAY_AFTER_SET_SQL = `
  WITH cleared AS (
    DELETE FROM crm_chat_digests
     WHERE partner_id = $1::uuid AND digest_date = $2::date AND channel = 'empty'
  )
  SELECT channel FROM crm_chat_digests
   WHERE partner_id = $1::uuid AND digest_date = $2::date AND channel <> 'empty'`;

async function setDigest(c: Ctx, mode: DigestMode, nowMs: number): Promise<CabinetScreen> {
  if (c.partner.seat === 'member') return noticeScreen(DIGEST_MEMBER);
  let sentToday = false;
  try {
    await pool.query(DIGEST_SET_SQL, [c.partner.partnerId, mode, c.ctx.userId]);
  } catch (err) {
    logFail('время сводки — запись', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
  try {
    const { rows } = await pool.query<{ channel: string }>(DIGEST_TODAY_AFTER_SET_SQL, [c.partner.partnerId, kamchatkaDate(new Date(nowMs))]);
    sentToday = rows.some((r) => r.channel === 'max' || r.channel === 'telegram' || r.channel === 'sending');
  } catch (err) {
    // Время записано; не прочиталось только «была ли сегодня» — так и сказано.
    logFail('сводка сегодня — после смены времени', err);
    return digestScreen(mode, 'Время записано. Была ли сегодня сводка, не прочиталось: если уже была, по новому времени придёт с завтра.');
  }
  if (mode === 'off') return digestScreen(mode, 'Сводка выключена. Включить — здесь же.');
  return digestScreen(mode, sentToday
    ? `Готово: сводка будет приходить ${DIGEST_WORDS[mode].long}. Сегодняшняя уже была — по новому времени с завтра.`
    : `Готово: сводка будет приходить ${DIGEST_WORDS[mode].long}, когда что-то ждёт.`);
}

/** Раздел кабинета по чату: проверка права здесь же. */
export async function openCabinet(input: {
  channel: CabinetChannel;
  chatId: number;
  privateChat: boolean;
  section: CabinetSection;
  nowMs?: number;
}): Promise<CabinetScreen> {
  const g = await gate(input.channel, input.chatId, input.privateChat);
  if (!g.ok) return g.screen;
  const nowMs = input.nowMs ?? Date.now();
  const out = lockForChannel(await sectionView(g, input.channel, input.section, nowMs), input.channel);
  await count(g, input.channel, `open_${input.section}`, out, nowMs);
  return out;
}

// ── Записи ──────────────────────────────────────────────────────────────────

const TASK_GONE = 'Задача уже закрыта или не найдена среди ваших — ничего не изменено.';

async function taskDone(c: Ctx, channel: CabinetChannel, taskId: string, nowMs: number): Promise<CabinetScreen> {
  let notice: string;
  try {
    const r = await completeTask(c.ctx.partnerId, taskId, c.ctx.userId, pool, 'partner_user');
    notice = r.outcome === 'done'
      ? (channel === 'max' ? `Готово: «${escapeHtml(r.task.title)}».` : 'Задача отмечена выполненной.')
      : TASK_GONE;
  } catch (err) {
    logFail('отметка задачи', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
  return tasksView(c, channel, 0, nowMs, notice);
}

async function taskTomorrow(c: Ctx, channel: CabinetChannel, taskId: string, nowMs: number): Promise<CabinetScreen> {
  let notice: string;
  try {
    const open = await listTasks(c.ctx.partnerId, { status: 'open' });
    const task = open.find((t) => t.id === taskId);
    if (!task) {
      notice = TASK_GONE;
    } else if (!canMoveToTomorrow(task, nowMs)) {
      notice = 'Срок этой задачи уже не сегодня — переносить не нужно. Ничего не изменено.';
    } else {
      const moved = await updateTask(c.ctx.partnerId, taskId, { dueAt: kamchatkaMorning(nowMs, 1) });
      notice = !moved
        ? TASK_GONE
        : channel === 'max'
          ? `Перенёс «${escapeHtml(moved.title)}» на завтра, 10:00.`
          : 'Задача перенесена на завтра, 10:00.';
    }
  } catch (err) {
    logFail('перенос задачи', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
  return tasksView(c, channel, 0, nowMs, notice);
}

const TOUCH_KIND: Readonly<Record<TouchOutcome, 'call' | 'note'>> = { reached: 'call', missed: 'call', agreed: 'note' };

/** Клиент этой карточки и был ли такой же звонок за две минуты — одной строкой. */
export const TOUCH_GUARD_SQL = `
  SELECT c.display_name,
         EXISTS (
           SELECT 1 FROM crm_events e
            WHERE e.partner_id = c.partner_id AND e.contact_id = c.id
              AND e.kind = $3 AND e.title = $4 AND e.actor_kind = 'partner_user'
              AND e.created_at > NOW() - INTERVAL '2 minutes'
         ) AS repeated
    FROM crm_contacts c
   WHERE c.id = $2::uuid AND c.partner_id = $1::uuid`;

async function touch(c: Ctx, channel: CabinetChannel, outcome: TouchOutcome, contactId: string, db: Queryable): Promise<CabinetScreen> {
  const title = TOUCH_TITLE[outcome];
  const kind = TOUCH_KIND[outcome];
  try {
    const { rows: [row] } = await db.query<{ display_name: string | null; repeated: boolean }>(
      TOUCH_GUARD_SQL, [c.ctx.partnerId, contactId, kind, title],
    );
    if (!row) return noticeScreen(CLIENT_NOT_FOUND);
    const offerRemind = outcome !== 'agreed';
    if (row.repeated) {
      return contactResultScreen({
        text: `«${title}» уже записан только что — второй раз не пишу.`, contactId, name: row.display_name, channel, offerRemind,
      });
    }
    const r = await addContactTouch(c.ctx.partnerId, contactId, {
      kind, title, actorKind: 'partner_user', actorUserId: c.ctx.userId,
    }, db);
    if (r.outcome === 'not_found') return noticeScreen(CLIENT_NOT_FOUND);
    return contactResultScreen({
      text: `Записал в ленту клиента: «${title}».`, contactId, name: row.display_name, channel, offerRemind,
    });
  } catch (err) {
    logFail('звонок клиенту', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
}

/** Клиент этой карточки и есть ли уже открытая такая задача на этот срок (±5 минут). */
export const REMIND_GUARD_SQL = `
  SELECT c.display_name,
         EXISTS (
           SELECT 1 FROM crm_tasks t
            WHERE t.partner_id = c.partner_id AND t.contact_id = c.id AND t.title = $3 AND t.done_at IS NULL
              AND t.due_at BETWEEN $4::timestamptz - INTERVAL '5 minutes' AND $4::timestamptz + INTERVAL '5 minutes'
         ) AS repeated
    FROM crm_contacts c
   WHERE c.id = $2::uuid AND c.partner_id = $1::uuid`;

export function remindAt(when: RemindWhen, nowMs: number): Date {
  if (when === 'hour') return new Date(nowMs + 3_600_000);
  return kamchatkaMorning(nowMs, when === 'tomorrow' ? 1 : 3);
}

async function remind(c: Ctx, channel: CabinetChannel, when: RemindWhen, contactId: string, nowMs: number, db: Queryable): Promise<CabinetScreen> {
  const dueAt = remindAt(when, nowMs);
  try {
    const { rows: [row] } = await db.query<{ display_name: string | null; repeated: boolean }>(
      REMIND_GUARD_SQL, [c.ctx.partnerId, contactId, REMIND_TITLE, dueAt.toISOString()],
    );
    if (!row) return noticeScreen(CLIENT_NOT_FOUND);
    if (row.repeated) {
      return contactResultScreen({
        text: `Задача «${REMIND_TITLE}» ${REMIND_WORDS[when]} уже есть — вторую не завожу.`,
        contactId, name: row.display_name, channel, offerRemind: false,
      });
    }
    const r = await createTask(c.ctx.partnerId, {
      title: REMIND_TITLE, dueAt, contactId, createdBy: c.ctx.userId, origin: 'manual',
    }, db);
    if (r.outcome === 'contact_not_found') return noticeScreen(CLIENT_NOT_FOUND);
    return contactResultScreen({
      text: `Завёл задачу «${REMIND_TITLE}» ${REMIND_WORDS[when]}. Напомню в этот чат, когда подойдёт срок.`,
      contactId, name: row.display_name, channel, offerRemind: false,
    });
  } catch (err) {
    logFail('напоминание о клиенте', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
}

// ── Машины и прайс перевозчика (#2862 этап C) ──────────────────────────────

/** Парк и прайс — тремя чтениями; каждое может не пройти отдельно (null). */
async function fleetView(c: Ctx, notice?: string): Promise<CabinetScreen> {
  if (c.partner.role !== 'transfer') return noticeScreen(FLEET_TEXT.notCarrier);
  const [vehicles, prices, drafts] = await Promise.all([
    listVehicles(c.ctx.partnerId).catch((err: unknown) => { logFail('парк', err); return null; }),
    loadOwnPriceRows(c.ctx.partnerId),
    loadOwnDrafts(c.ctx.partnerId),
  ]);
  return fleetScreen({
    vehicles,
    prices: prices.outcome === 'ok' ? prices.rows : null,
    drafts: drafts.outcome === 'ok' ? drafts.drafts : null,
    base: base(),
    notice,
  });
}

async function vehicleActive(c: Ctx, press: Extract<CabinetPress, { kind: 'vehicle_active' }>): Promise<CabinetScreen> {
  if (c.partner.role !== 'transfer') return noticeScreen(FLEET_TEXT.notCarrier);
  const r = await updateVehicle({ partnerId: c.ctx.partnerId, vehicleId: press.vehicleId, patch: { isActive: press.active } });
  if (!r.ok) {
    if (r.code === 'db_error') return noticeScreen(CABINET_TEXT.dbFailed);
    return fleetView(c, 'Эта машина не найдена среди ваших — ничего не изменено.');
  }
  const title = escapeHtml(r.value.title);
  return fleetView(c, press.active ? `«${title}» снова на линии.` : `«${title}» снята с линии: на витрине её нет.`);
}

// ── Занято (хозяин жилья, 30.10) ────────────────────────────────────────────

async function busyView(c: Ctx, nowMs: number, notice?: string): Promise<CabinetScreen> {
  if (c.partner.role !== 'stay') return noticeScreen(BUSY_TEXT.notStay);
  const objects = await loadOwnerBusy(c.ctx.partnerId, kamchatkaDate(new Date(nowMs)));
  const out = busyScreen({ objects, base: base(), notice });
  return objects === null ? { ...out, failed: true } : out;
}

async function busyRelease(c: Ctx, press: Extract<CabinetPress, { kind: 'busy_release' }>, channel: CabinetChannel, nowMs: number): Promise<CabinetScreen> {
  if (c.partner.role !== 'stay') return noticeScreen(BUSY_TEXT.notStay);
  const r = await setObjectBusy({
    partnerId: c.ctx.partnerId, accommodationId: press.accommodationId, from: press.from, to: press.to, action: 'release', via: channel,
  });
  if (r.outcome === 'db_error') return busyView(c, nowMs, BUSY_TEXT.saveFailed);
  if (r.outcome === 'not_yours') return busyView(c, nowMs, BUSY_TEXT.notYours);
  return busyView(c, nowMs, busySavedText({ name: r.name, from: press.from, to: press.to, action: 'release' }));
}

/** Сводка перевозчика (#2862 этап D): блоки читаются отдельно, не прочитавшийся назван. */
async function carrierSummaryView(c: Ctx): Promise<CabinetScreen> {
  if (c.partner.role !== 'transfer') return noticeScreen(FLEET_TEXT.notCarrier);
  return carrierSummaryScreen(await loadCarrierSummary(c.ctx.partnerId), base());
}

// ── Поиск клиента (только MAX) ──────────────────────────────────────────────

/**
 * Кнопка «Найти клиента»: следующее сообщение — запрос. Последняя кнопка
 * главная: ожидание причины отказа брони и сообщения по заявке в этом чате
 * гаснут (иначе имя для поиска ушло бы туристу причиной отказа или клиенту
 * сообщением).
 */
async function armSearch(c: Ctx, chatId: number): Promise<CabinetScreen> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE chat_cabinet_waits SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting'`,
      [String(chatId)],
    );
    await client.query(
      `UPDATE partner_chat_actions SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'awaiting_reason'`,
      [String(chatId)],
    );
    await client.query(
      `UPDATE request_chat_waits SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting'`,
      [String(chatId)],
    );
    // Время — часы базы, как у ожиданий, с которыми поиск сравнивается
    // (partner_chat_actions, request_chat_waits): часы приложения могут уйти.
    // Два одновременных нажатия (MAX повторил апдейт): второе упирается в
    // ожидание первого и ничего не вставляет — поиск и так ждёт, это не отказ.
    await client.query(
      `INSERT INTO chat_cabinet_waits (channel, chat_id, partner_id, purpose, expires_at)
       VALUES ('max', $1::bigint, $2::uuid, 'client_search', NOW() + make_interval(mins => $3::int))
       ON CONFLICT (channel, chat_id) WHERE status = 'waiting' DO NOTHING`,
      [String(chatId), c.ctx.partnerId, SEARCH_WAIT_MIN],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((e: unknown) => logFail('откат ожидания поиска', e));
    logFail('ожидание поиска', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  } finally {
    client.release();
  }
  return searchPromptScreen();
}

async function cancelSearch(c: Ctx, chatId: number): Promise<CabinetScreen> {
  let notice: string;
  try {
    const r = await pool.query(
      `UPDATE chat_cabinet_waits SET status = 'cancelled'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting'`,
      [String(chatId)],
    );
    notice = (r.rowCount ?? 0) > 0 ? 'Поиск отменён.' : 'Поиск уже не ждал сообщения.';
  } catch (err) {
    logFail('отмена поиска', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
  return clientsView(c, 'max', 0, notice);
}

/**
 * Другая кнопка кабинета в этом чате снимает поиск (подсказка поиска говорит
 * это словами): экран поиска уже правкой заменён, и следующее сообщение —
 * не запрос. Отказ не останавливает нажатие: ожидание всё равно уступит
 * кнопке, которая ждёт текст (`newer`), и истечёт через 10 минут.
 */
export async function dropCabinetSearch(chatId: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE chat_cabinet_waits SET status = 'superseded'
        WHERE channel = 'max' AND chat_id = $1::bigint AND status = 'waiting'`,
      [String(chatId)],
    );
  } catch (err) {
    logFail('снятие поиска другой кнопкой', err);
  }
}

/**
 * Ждёт ли чат запрос поиска. `newer` — после кнопки поиска в этом чате нажали
 * кнопку, которая тоже ждёт текст («Отклонить» под бронью, «Ответить
 * клиенту»): последняя кнопка главная, и поиск уступает — даже если её
 * ожидание уже исполнено.
 */
export const SEARCH_WAIT_SQL = `
  SELECT w.id::text AS id, w.partner_id::text AS partner_id,
         (EXISTS (SELECT 1 FROM partner_chat_actions a
                   WHERE a.channel = 'max' AND a.chat_id = w.chat_id AND a.created_at > w.created_at)
          OR EXISTS (SELECT 1 FROM request_chat_waits r
                      WHERE r.channel = 'max' AND r.chat_id = w.chat_id AND r.created_at > w.created_at)) AS newer
    FROM chat_cabinet_waits w
   WHERE w.channel = 'max' AND w.chat_id = $1::bigint AND w.status = 'waiting' AND w.expires_at > NOW()`;

const CANCEL_WORDS = /^(?:отмена|отмени(?:те)?|стоп|не надо|не нужно|отбой)$/u;

function normWords(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

/**
 * Сообщение личного диалога MAX после «Найти клиента» — запрос поиска.
 * null — чат поиск не ждёт (или это команда, слово меню, беда, контроль
 * выхода, или позже нажата другая кнопка): сообщение идёт дальше своим путём.
 * Беда и контроль выхода гасят ожидание: «помогите» — не имя клиента.
 */
export async function captureCabinetSearch(input: {
  chatId: number;
  partner: PartnerChatContext;
  text: string;
  /** Чей чат: карточки или менеджера команды. */
  seat?: CabinetSeat;
  nowMs?: number;
}): Promise<CabinetScreen | null> {
  const text = input.text.trim();
  if (!text || text.startsWith('/') || roleMenuAsk(text) !== null) return null;
  let wait: { id: string; partner_id: string; newer: boolean } | undefined;
  try {
    ({ rows: [wait] } = await pool.query<{ id: string; partner_id: string; newer: boolean }>(
      SEARCH_WAIT_SQL, [String(input.chatId)],
    ));
  } catch (err) {
    logFail('ждёт ли чат поиск', err);
    // «Не смог проверить» — не «не ждёт» (§4.0): сообщение могло быть
    // запросом, а подсказка поиска обещала, что он уходит только в CRM.
    // Беда и контроль выхода — своим путём при любом отказе.
    if (detectEmergency(text).detected || isWatchTrigger(text)) return null;
    return failedScreen(CABINET_TEXT.searchUnchecked);
  }
  if (!wait) return null;
  const g = withPartner(input.partner, input.seat ?? 'owner');
  // Чужое ожидание, беда, контроль выхода — сообщение идёт своим путём.
  const passOn = !g.ok || wait.partner_id !== input.partner.partnerId
    || detectEmergency(text).detected || isWatchTrigger(text);
  const cancel = !passOn && !wait.newer && CANCEL_WORDS.test(normWords(text));
  if (passOn || wait.newer || cancel) {
    try {
      await pool.query(
        `UPDATE chat_cabinet_waits SET status = $2 WHERE id = $1::uuid AND status = 'waiting'`,
        [wait.id, cancel ? 'cancelled' : 'superseded'],
      );
    } catch (err) {
      logFail('снятие ожидания поиска', err);
    }
    if (passOn || !g.ok) return null;
    if (cancel) return clientsView(g, 'max', 0, 'Поиск отменён.');
    // Позже нажата кнопка брони или заявки, её ожидание уже исполнено. Это
    // сообщение могло быть запросом поиска (подсказка поиска стоит выше), и
    // помощнику оно не отдаётся: подсказка обещала, что текст поиска уходит
    // только в CRM. Один ответ, и чат снова как обычно.
    return noticeScreen(CABINET_TEXT.searchYielded);
  }
  if (!g.ok) return null;
  try {
    const used = await pool.query(
      `UPDATE chat_cabinet_waits SET status = 'used', used_at = NOW() WHERE id = $1::uuid AND status = 'waiting'`,
      [wait.id],
    );
    // Второе сообщение того же мгновения уже забрало ожидание — это сообщение не запрос.
    if ((used.rowCount ?? 0) === 0) return null;
  } catch (err) {
    logFail('ожидание поиска', err);
    return failedScreen(CABINET_TEXT.dbFailed);
  }
  const query = text.slice(0, SEARCH_QUERY_MAX);
  let out: CabinetScreen;
  try {
    const list = await listContacts(g.ctx.partnerId, { q: query, limit: CLIENTS_PAGE_SIZE, offset: 0 });
    out = searchResultsScreen({ query, items: list.items, total: list.total });
  } catch (err) {
    logFail('поиск клиента', err);
    out = failedScreen(CABINET_TEXT.dbFailed);
  }
  await count(g, 'max', 'search_query', out, input.nowMs ?? Date.now());
  return out;
}

/**
 * Ждёт ли этот чат MAX запрос поиска — для чата, который ещё и чат
 * администратора (lib/roles/admin-partner-chat): запрос «Бронникова» иначе
 * забрала бы консоль по слову «брон». База не ответила — false, консоль
 * работает как раньше (так же устроено ожидание причины отказа брони).
 */
export async function awaitsCabinetSearch(chatId: number): Promise<boolean> {
  return (await cabinetSearchWaiting(chatId)) === true;
}

/**
 * Ждёт ли чат MAX запрос поиска — три исхода: да, нет, null — база не
 * ответила (§4.0). Вход менеджера (lib/chat-cabinet/member-entry) на null
 * сообщение дальше не отдаёт, если это чат менеджера: оно могло быть запросом.
 */
export async function cabinetSearchWaiting(chatId: number): Promise<boolean | null> {
  try {
    const { rows } = await pool.query<{ newer: boolean }>(SEARCH_WAIT_SQL, [String(chatId)]);
    return rows.length > 0;
  } catch (err) {
    logFail('ждёт ли чат поиск', err);
    return null;
  }
}

// ── Нажатие ─────────────────────────────────────────────────────────────────

/**
 * Нажатие кнопки кабинета (`cb:`). Ответ — экран, которым вызывающий правит
 * сообщение с кнопкой (не вышло — шлёт новым). Вызывающий уже проверил
 * заверенность апдейта и взял чат из сообщения с кнопкой.
 */
export async function handleCabinetPress(input: {
  channel: CabinetChannel;
  chatId: number;
  privateChat: boolean;
  payload: string;
  nowMs?: number;
}, deps: { db?: Queryable } = {}): Promise<CabinetScreen> {
  const press = parseCabinetPress(input.payload);
  if (!press) return noticeScreen(CABINET_TEXT.unknownButton, false);
  const g = await gate(input.channel, input.chatId, input.privateChat);
  if (!g.ok) return g.screen;
  const nowMs = input.nowMs ?? Date.now();
  const db = deps.db ?? pool;
  const ch = input.channel;
  // Другая кнопка кабинета снимает поиск: «Задачи» после «Найти клиента»
  // правкой убрали подсказку, и следующее сообщение — уже не запрос.
  if (ch === 'max' && press.kind !== 'search' && press.kind !== 'search_cancel') await dropCabinetSearch(input.chatId);
  let out: CabinetScreen;
  switch (press.kind) {
    case 'more': out = await moreView(g); break;
    case 'digest': out = await digestView(g); break;
    case 'digest_set': out = await setDigest(g, press.mode, nowMs); break;
    case 'inbox': out = await inboxView(g, press.page, nowMs); break;
    case 'item': out = await itemView(g, ch, press, nowMs); break;
    case 'tasks': out = await tasksView(g, ch, press.page, nowMs); break;
    case 'task_done': out = await taskDone(g, ch, press.taskId, nowMs); break;
    case 'task_tomorrow': out = await taskTomorrow(g, ch, press.taskId, nowMs); break;
    case 'clients': out = await clientsView(g, ch, press.page); break;
    case 'client': out = await clientView(g, ch, press.contactId); break;
    case 'search': out = ch === 'max' ? await armSearch(g, input.chatId) : await clientsView(g, ch, 0, SEARCH_TELEGRAM); break;
    case 'search_cancel': out = ch === 'max' ? await cancelSearch(g, input.chatId) : await clientsView(g, ch, 0); break;
    case 'touch': out = await touch(g, ch, press.outcome, press.contactId, db); break;
    case 'remind': out = await remind(g, ch, press.when, press.contactId, nowMs, db); break;
    case 'fleet': out = await fleetView(g); break;
    case 'vehicle_active': out = await vehicleActive(g, press); break;
    case 'carrier_summary': out = await carrierSummaryView(g); break;
    case 'busy': out = await busyView(g, nowMs); break;
    case 'busy_release': out = await busyRelease(g, press, ch, nowMs); break;
    // «Мои туры» гида (30.10): даты, правка текста и цены — lib/guides/tour-edit.
    // Роль, кабинет карточки и владение туром проверяет поток.
    case 'my_tours':
    case 'tour':
    case 'tour_dates':
    case 'date_open':
    case 'date_close':
    case 'tour_hint':
    case 'edit_save':
    case 'edit_cancel':
    case 'edit_tour': {
      const { guideTourPress } = await import('@/lib/guides/tour-edit/flow');
      out = await guideTourPress(press, {
        partner: g.ctx, owner: g.partner.seat === 'owner', channel: ch, chatId: input.chatId, nowMs,
      });
      break;
    }
  }
  const shown = lockForChannel(out, ch);
  await count(g, ch, press.kind, shown, nowMs);
  return shown;
}
