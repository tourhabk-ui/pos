/**
 * Бронь своего тура кнопкой в чате кабинета (MAX, Telegram): подтвердить,
 * отклонить с причиной, «тур прошёл», «турист не пришёл» — в два шага, как в
 * разделе «Свои туры» на сайте (план «гид в чате», шаг 6).
 *
 * Чат — ещё одна дверь в то же правило: статус меняет только
 * `changeOwnerBookingStatus` (lib/bookings/owner-status) — владение по туру,
 * разрешённый переход, места и сумма возврата при отмене, лента клиента,
 * письмо, push и Telegram туриста. Второй копии этого кода здесь нет.
 *
 * ── Шаги ────────────────────────────────────────────────────────────────────
 *
 *   1. `bk:<c|x|d|n>:<id>` — проверки ниже, бронь читается под владельцем,
 *      переход сверяется с ALLOWED_TRANSITIONS, заводится строка
 *      partner_chat_actions (миграция 1341) и задаётся вопрос без ПД:
 *      «Подтвердить бронь №… («Тур», 05.11, 2 чел)?» — [Да] [Не надо].
 *      «Отклонить» сначала просит причину: следующее сообщение этого личного
 *      чата в течение 15 минут (`captureOwnerReason`), «отмена» гасит.
 *   2. `oc:y:<uuid>` — строка захватывается одним UPDATE ... WHERE
 *      status = 'ready' AND expires_at > NOW() и партнёром ЭТОГО чата,
 *      прочитанным заново: второе нажатие строку уже не захватит, а чат,
 *      перепривязанный к другой карточке, чужую строку не исполнит. Затем
 *      правило смены статуса, итог — в outcome. Повтор отвечает прежним итогом.
 *
 * ── Кто вправе (каждая проверка — свой исход, «не смог проверить» ≠ «нельзя») ─
 *
 *   - вызывающий пускает только заверенный апдейт: MAX — `verifiedOrigin`,
 *     Telegram — секрет вебхука; чат — только из сообщения с кнопкой;
 *   - личный диалог: в группе кнопку нажал бы любой участник;
 *   - карточка чата (`findPartnerByChat`, три исхода) — гид со своими турами
 *     (`chatActionsEnabledFor`): туроператору кнопки не включены (вопрос
 *     владельца 3 плана мини-приложения);
 *   - у карточки есть аккаунт (`partners.user_id`): это `actorUserId` правила;
 *   - нажал человек, подключивший этот чат ссылкой из кабинета
 *     (`partners.max_owner_user_id` / `telegram_owner_user_id`, 1336). Старая
 *     привязка без записи — кнопок брони нет, пока чат не переподключат
 *     (план мини-приложения, §6.5 «Происхождение привязки»);
 *   - владение бронью — в SQL по `operator_tours.operator_id` карточки гида:
 *     гид команды оператора чужих броней не трогает.
 *
 * ПД: ни вопрос, ни итог не называют имени, телефона и почты туриста —
 * только номер, тур, дату и число людей. Причина отклонения — текст гида для
 * туриста; в лог не пишется. Отказ базы — имя проверки и SQLSTATE в лог.
 */
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { findPartnerByChat, type PartnerChatContext } from '@/lib/kuzmich/operator-chat';
import { changeOwnerBookingStatus, type OwnerStatusResult } from '@/lib/bookings/owner-status';
import { OWNER_BOOKING_STATUS_LABEL, alreadyInStatusText } from '@/lib/bookings/owner-status-words';
import {
  BOOKING_ACTION_STATUS, answerPressPayload, chatActionsEnabledFor, parseOwnerPress, type BookingChatAction,
} from '@/lib/bookings/chat-owner-press';
import { ALLOWED_TRANSITIONS, type BookingStatus } from '@/types/booking.types';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import { partnerMenu, roleMenuAsk } from '@/lib/roles/role-menu';
import { ruShort } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';
import { getPublicBaseUrl } from '@/lib/config';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';

export type OwnerChatChannel = 'max' | 'telegram';

/** Ответ в чат: текст и строки кнопок (строка меню кабинета — последней). */
export interface OwnerReply {
  text: string;
  buttons: MenuButton[][];
}

/** Сколько живут вопрос «Да / Не надо» и ожидание причины, минут. */
export const OWNER_ACTION_TTL_MIN = 15;
/** Захваченное «Да» без итога дольше этого — процесс оборвался, исход неизвестен. */
const RUNNING_STALE_SEC = 120;
/** Причина отклонения — как у двери сайта (`cancellation_reason`, ≤ 255). */
export const OWNER_REASON_MAX = 255;

const OWNER_COLUMN: Record<OwnerChatChannel, string> = {
  max: 'max_owner_user_id',
  telegram: 'telegram_owner_user_id',
};

function ownUrl(): string {
  return `${getPublicBaseUrl()}${GUIDE_OWN_PATH}`;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}
/** Отказ — в лог: имя проверки и SQLSTATE. Текст ошибки не пишется — в нём бывают значения строки. */
function logFail(check: string, err: unknown): void {
  console.error(`[chat-owner-action] ${check} — отказ, SQLSTATE ${sqlstate(err)}`);
}

export const OWNER_ACTION_TEXT = {
  notDialog: 'Кнопки брони работают в личном диалоге с ботом. Здесь ничего не изменено.',
  unchecked: 'Не удалось проверить, чей это чат, — ничего не изменено. Попробуйте ещё раз или откройте раздел «Свои туры».',
  notThis: 'Эта кнопка — кабинет гида со своими турами. В этом чате её не выполняю.',
  operatorNotYet: 'Кнопки брони в чате пока включены только гиду со своими турами. Бронь подтверждается в кабинете, раздел «Брони».',
  noAccount: 'У карточки нет аккаунта на сайте — менять бронь из чата некому. Напишите менеджеру Ведара.',
  noBindOwner: 'Кнопки брони нажимает тот, кто подключил этот чат ссылкой из кабинета, а этот чат подключён раньше, '
    + 'чем платформа стала это записывать. Откройте ссылку подключения из кабинета ещё раз и нажмите «Старт». '
    + 'Ничего не изменено.',
  notOwner: 'Кнопки брони нажимает тот, кто подключил этот чат ссылкой из кабинета. Ничего не изменено.',
  unknownButton: 'Кнопка не распознана — ничего не изменено.',
  notSaved: 'Не удалось записать вопрос — бронь не изменена. Нажмите кнопку ещё раз.',
  notFoundAction: 'Эта кнопка не из этого чата или устарела — ничего не изменено.',
} as const;

const QUESTION_VERB: Record<BookingChatAction, string> = {
  confirm: 'Подтвердить',
  cancel: 'Отклонить',
  complete: 'Отметить, что тур прошёл:',
  no_show: 'Отметить, что турист не пришёл:',
};

const YES_LABEL: Record<BookingChatAction, string> = {
  confirm: 'Да, подтвердить',
  cancel: 'Да, отклонить',
  complete: 'Да, тур прошёл',
  no_show: 'Да, не пришёл',
};

interface BookingFacts {
  id: string;
  status: string;
  date: string;
  participants: number;
  title: string;
}

function factsLine(b: BookingFacts): string {
  return `№${escapeHtml(b.id)} («${escapeHtml(b.title)}», ${ruShort(b.date.slice(0, 10))}, ${b.participants} чел)`;
}

function statusWord(status: string): string {
  return OWNER_BOOKING_STATUS_LABEL[status] ?? status;
}

// ── Проверки права ───────────────────────────────────────────────────────────

type Gate =
  | { ok: true; partner: PartnerChatContext & { userId: string }; menu: MenuButton[] }
  | { ok: false; reply: OwnerReply };

function withMenu(text: string, menu: MenuButton[], rows: MenuButton[][] = []): OwnerReply {
  return { text, buttons: menu.length ? appendMenu(rows, menu) : rows };
}

/** Кто нажал записан при привязке: id человека строкой, null — не записан. */
async function readBindOwner(channel: OwnerChatChannel, partnerId: string): Promise<string | null | 'unavailable'> {
  try {
    const { rows } = await pool.query<{ owner: string | null }>(
      `SELECT ${OWNER_COLUMN[channel]}::text AS owner FROM partners WHERE id = $1::uuid`,
      [partnerId],
    );
    return rows[0]?.owner ?? null;
  } catch (err) {
    logFail('кто подключил чат', err);
    return 'unavailable';
  }
}

async function gate(input: {
  channel: OwnerChatChannel;
  chatId: number;
  privateChat: boolean;
  presserId: number | null;
}): Promise<Gate> {
  if (!input.privateChat) {
    console.error(`[chat-owner-action] нажатие не из личного диалога (${input.channel}) — не применено`);
    return { ok: false, reply: { text: OWNER_ACTION_TEXT.notDialog, buttons: [] } };
  }
  const lookup = await findPartnerByChat(input.channel, input.chatId);
  if (lookup.outcome === 'unavailable') return { ok: false, reply: { text: OWNER_ACTION_TEXT.unchecked, buttons: [] } };
  if (lookup.outcome === 'none') return { ok: false, reply: { text: OWNER_ACTION_TEXT.notThis, buttons: [] } };
  const partner = lookup.partner;
  const menu = partnerMenu(partner) ?? [];
  if (!chatActionsEnabledFor(partner)) {
    return {
      ok: false,
      reply: withMenu(partner.category === 'operator' ? OWNER_ACTION_TEXT.operatorNotYet : OWNER_ACTION_TEXT.notThis, menu),
    };
  }
  const userId = partner.userId;
  if (!userId) return { ok: false, reply: withMenu(OWNER_ACTION_TEXT.noAccount, menu) };
  const owner = await readBindOwner(input.channel, partner.partnerId);
  if (owner === 'unavailable') return { ok: false, reply: withMenu(OWNER_ACTION_TEXT.unchecked, menu) };
  if (owner === null) return { ok: false, reply: withMenu(OWNER_ACTION_TEXT.noBindOwner, menu) };
  if (input.presserId === null || owner !== String(input.presserId)) {
    console.error(`[chat-owner-action] нажал не тот, кто подключил чат (${input.channel}) — не применено`);
    return { ok: false, reply: withMenu(OWNER_ACTION_TEXT.notOwner, menu) };
  }
  return { ok: true, partner: { ...partner, userId }, menu };
}

// ── Бронь ────────────────────────────────────────────────────────────────────

async function readOwnBooking(partnerId: string, bookingId: string): Promise<BookingFacts | null | 'unavailable'> {
  try {
    const { rows } = await pool.query<{ id: string; status: string; date: string; participants: number | null; title: string }>(
      `SELECT b.id::text AS id, b.booking_status AS status, b.booking_date::text AS date,
              b.participants, t.title
         FROM operator_bookings b
         JOIN operator_tours t ON t.id = b.operator_tour_id
        WHERE b.id = $1::bigint AND t.operator_id = $2::uuid AND b.deleted_at IS NULL`,
      [bookingId, partnerId],
    );
    const r = rows[0];
    if (!r) return null;
    return { id: r.id, status: r.status, date: r.date, participants: Number(r.participants ?? 1), title: r.title };
  } catch (err) {
    logFail('бронь для вопроса', err);
    return 'unavailable';
  }
}

/** Новая строка действия; прежняя действующая в этом чате — `superseded`. */
async function openAction(args: {
  partnerId: string;
  channel: OwnerChatChannel;
  chatId: number;
  bookingId: string;
  action: BookingChatAction;
}): Promise<string | null> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `UPDATE partner_chat_actions SET status = 'superseded'
        WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('awaiting_reason', 'ready')`,
      [args.channel, String(args.chatId)],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO partner_chat_actions (partner_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at)
       VALUES ($1::uuid, $2, $3::bigint, 'booking', $4, $5, $6, NOW() + make_interval(mins => $7::int))
       RETURNING id::text AS id`,
      [
        args.partnerId, args.channel, String(args.chatId), args.bookingId, args.action,
        args.action === 'cancel' ? 'awaiting_reason' : 'ready', OWNER_ACTION_TTL_MIN,
      ],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('новое действие брони', err);
    await client?.query('ROLLBACK').catch((e: unknown) => logFail('откат нового действия', e));
    return null;
  } finally {
    client?.release();
  }
}

function questionButtons(action: BookingChatAction, actionId: string): MenuButton[][] {
  return [[
    { text: YES_LABEL[action], payload: answerPressPayload(true, actionId), intent: action === 'cancel' ? 'negative' : 'positive' },
    { text: 'Не надо', payload: answerPressPayload(false, actionId) },
  ]];
}

function questionText(action: BookingChatAction, b: BookingFacts | null, bookingId: string, reason: string | null): string {
  const what = b ? factsLine(b) : `№${escapeHtml(bookingId)}`;
  if (action === 'confirm') return `Подтвердить бронь ${what}? Туристу уйдёт письмо, что бронь подтверждена.`;
  if (action === 'cancel') {
    return `Отклонить бронь ${what}? Причина для туриста: «${escapeHtml(reason ?? '')}». Туристу уйдёт письмо с причиной.`;
  }
  return `${QUESTION_VERB[action]} бронь ${what}?`;
}

function askReasonText(b: BookingFacts): string {
  return `Отклонить бронь ${factsLine(b)}? Напишите одним сообщением причину — её получит турист в письме. `
    + `Передумали — нажмите «Не надо» или напишите «отмена». Жду ${OWNER_ACTION_TTL_MIN} минут.`;
}

async function askBooking(
  g: Extract<Gate, { ok: true }>,
  channel: OwnerChatChannel,
  chatId: number,
  action: BookingChatAction,
  bookingId: string,
): Promise<OwnerReply> {
  const b = await readOwnBooking(g.partner.partnerId, bookingId);
  if (b === 'unavailable') {
    return withMenu('Бронь не прочиталась — база не ответила. Ничего не изменено, попробуйте ещё раз.', g.menu);
  }
  if (!b) return withMenu(`Бронь №${escapeHtml(bookingId)} не найдена среди ваших туров — ничего не изменено.`, g.menu);
  const target = BOOKING_ACTION_STATUS[action];
  if (b.status === target) return withMenu(alreadyInStatusText(b.id, target), g.menu);
  const allowed = (ALLOWED_TRANSITIONS as Record<string, readonly BookingStatus[]>)[b.status] ?? [];
  if (!allowed.includes(target)) {
    return withMenu(`Бронь №${escapeHtml(b.id)} сейчас: «${escapeHtml(statusWord(b.status))}» — так её уже не перевести. Ничего не изменено.`, g.menu);
  }
  const id = await openAction({ partnerId: g.partner.partnerId, channel, chatId, bookingId: b.id, action });
  if (!id) return withMenu(OWNER_ACTION_TEXT.notSaved, g.menu);
  if (action === 'cancel') {
    return withMenu(askReasonText(b), g.menu, [[{ text: 'Не надо', payload: answerPressPayload(false, id) }]]);
  }
  return withMenu(questionText(action, b, b.id, null), g.menu, questionButtons(action, id));
}

// ── «Да» / «Не надо» ─────────────────────────────────────────────────────────

/** Итог в строке действия — им же отвечает повтор. */
type StoredOutcome =
  | { kind: 'done'; booking: string; status: string; changed: boolean; notice: string | null }
  | { kind: 'refused'; booking: string; reason: 'not_found' | 'bad_transition' | 'error' | 'unsupported'; from?: string };

function readStored(v: unknown): StoredOutcome | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'done' && typeof o.booking === 'string' && typeof o.status === 'string') {
    return {
      kind: 'done', booking: o.booking, status: o.status, changed: o.changed === true,
      notice: typeof o.notice === 'string' ? o.notice : null,
    };
  }
  if (o.kind === 'refused' && typeof o.booking === 'string'
    && (o.reason === 'not_found' || o.reason === 'bad_transition' || o.reason === 'error' || o.reason === 'unsupported')) {
    return { kind: 'refused', booking: o.booking, reason: o.reason, ...(typeof o.from === 'string' ? { from: o.from } : {}) };
  }
  return null;
}

const DONE_WORD: Record<string, string> = {
  confirmed: 'подтверждена',
  cancelled: 'отклонена',
  completed: 'отмечена: тур прошёл',
  no_show: 'отмечена: турист не пришёл',
};

/** Что стало с письмом туристу — словами, как в разделе «Свои туры». */
export function touristNoticeText(status: string, notice: string | null): string | null {
  if (status !== 'confirmed' && status !== 'cancelled') return null;
  if (notice === 'no_email') return 'У брони нет почты — письмо туристу не ушло, свяжитесь с ним сами.';
  if (notice === 'sent') return status === 'cancelled' ? 'Туристу ушло письмо с причиной.' : 'Туристу ушло письмо.';
  return 'Письмо туристу пока не ушло — платформа повторит отправку. Если не дойдёт, свяжитесь с туристом сами.';
}

export function outcomeText(o: StoredOutcome): string {
  const n = escapeHtml(o.booking);
  if (o.kind === 'done') {
    if (!o.changed) return alreadyInStatusText(o.booking, o.status);
    const head = `Бронь №${n} ${DONE_WORD[o.status] ?? `в статусе «${escapeHtml(o.status)}»`}.`;
    const mail = touristNoticeText(o.status, o.notice);
    return mail ? `${head} ${mail}` : head;
  }
  if (o.reason === 'not_found') return `Бронь №${n} не найдена среди ваших туров — ничего не изменено.`;
  if (o.reason === 'bad_transition') {
    return `Бронь №${n} сейчас: «${escapeHtml(statusWord(o.from ?? ''))}» — так её уже не перевести. Ничего не изменено.`;
  }
  if (o.reason === 'unsupported') return 'Эта кнопка в чате не поддерживается — ничего не изменено.';
  return `Не удалось довести до конца: не знаю, изменилась ли бронь №${n}. Проверьте её в разделе «Свои туры»: ${ownUrl()}`;
}

interface StateRow {
  status: string;
  subject_id: string;
  outcome: unknown;
  expired: boolean;
  stale: boolean;
}

const STATE_SQL = `SELECT status, subject_id, outcome, expires_at <= NOW() AS expired,
       (used_at IS NOT NULL AND used_at < NOW() - make_interval(secs => $5::int)) AS stale
  FROM partner_chat_actions
 WHERE id = $1::uuid AND channel = $2 AND chat_id = $3::bigint AND partner_id = $4::uuid`;

/** Строку не захватить: почему — словами (повтор, отмена, срок, чужая). */
function blockedText(r: StateRow | undefined): string {
  if (!r) return OWNER_ACTION_TEXT.notFoundAction;
  if (r.status === 'done' || r.status === 'refused') {
    const stored = readStored(r.outcome);
    return stored ? `Уже нажато раньше. ${outcomeText(stored)}` : `Уже нажато раньше — итог в разделе «Свои туры»: ${ownUrl()}`;
  }
  if (r.status === 'running') {
    return r.stale
      ? `Нажатие принято, но итог не записан — проверьте бронь №${escapeHtml(r.subject_id)} в разделе «Свои туры»: ${ownUrl()}`
      : 'Уже выполняю это действие — ответ придёт следом.';
  }
  if (r.status === 'cancelled') return `Это действие отменено — бронь №${escapeHtml(r.subject_id)} без изменений.`;
  if (r.status === 'superseded') return 'Это действие заменено следующей кнопкой — ничего не изменено.';
  if (r.status === 'awaiting_reason') {
    return r.expired
      ? 'Ожидание причины истекло — нажмите «Отклонить» под бронью ещё раз. Ничего не изменено.'
      : 'Сначала напишите причину отклонения одним сообщением — её получит турист.';
  }
  return `Вопрос устарел (${OWNER_ACTION_TTL_MIN} минут) — нажмите кнопку брони ещё раз. Ничего не изменено.`;
}

async function readState(channel: OwnerChatChannel, chatId: number, partnerId: string, actionId: string): Promise<StateRow | undefined | 'unavailable'> {
  try {
    const { rows } = await pool.query<StateRow>(STATE_SQL, [actionId, channel, String(chatId), partnerId, RUNNING_STALE_SEC]);
    return rows[0];
  } catch (err) {
    logFail('состояние действия', err);
    return 'unavailable';
  }
}

async function finish(actionId: string, status: 'done' | 'refused', outcome: StoredOutcome): Promise<void> {
  try {
    const upd = await pool.query(
      `UPDATE partner_chat_actions SET status = $2, outcome = $3::jsonb
        WHERE id = $1::uuid AND status = 'running'`,
      [actionId, status, JSON.stringify(outcome)],
    );
    if (upd.rowCount !== 1) console.error(`[chat-owner-action] итог действия записан в ${upd.rowCount ?? 0} строк вместо одной`);
  } catch (err) {
    logFail('итог действия', err);
  }
}

function storedFromResult(bookingId: string, result: OwnerStatusResult): StoredOutcome {
  if (result.kind === 'not_found') return { kind: 'refused', booking: bookingId, reason: 'not_found' };
  if (result.kind === 'bad_transition') return { kind: 'refused', booking: bookingId, reason: 'bad_transition', from: result.from };
  const status = typeof result.data.booking_status === 'string' ? result.data.booking_status : '';
  return { kind: 'done', booking: bookingId, status, changed: result.changed, notice: result.touristNotice };
}

async function answer(
  g: Extract<Gate, { ok: true }>,
  channel: OwnerChatChannel,
  chatId: number,
  actionId: string,
  yes: boolean,
): Promise<OwnerReply> {
  const partnerId = g.partner.partnerId;
  if (!yes) {
    try {
      const { rows } = await pool.query<{ subject_id: string }>(
        `UPDATE partner_chat_actions SET status = 'cancelled'
          WHERE id = $1::uuid AND channel = $2 AND chat_id = $3::bigint AND partner_id = $4::uuid
            AND status IN ('awaiting_reason', 'ready')
          RETURNING subject_id`,
        [actionId, channel, String(chatId), partnerId],
      );
      if (rows[0]) return withMenu(`Хорошо, бронь №${escapeHtml(rows[0].subject_id)} без изменений.`, g.menu);
    } catch (err) {
      logFail('«Не надо»', err);
      return withMenu(OWNER_ACTION_TEXT.unchecked, g.menu);
    }
    const st = await readState(channel, chatId, partnerId, actionId);
    return withMenu(st === 'unavailable' ? OWNER_ACTION_TEXT.unchecked : blockedText(st), g.menu);
  }

  // Захват: одна строка, этого чата и ЭТОЙ карточки (прочитанной заново), готовая и не истёкшая.
  let claimed: { subject_kind: string; subject_id: string; action: string; reason: string | null } | undefined;
  try {
    const { rows } = await pool.query<{ subject_kind: string; subject_id: string; action: string; reason: string | null }>(
      `UPDATE partner_chat_actions SET status = 'running', used_at = NOW()
        WHERE id = $1::uuid AND channel = $2 AND chat_id = $3::bigint AND partner_id = $4::uuid
          AND status = 'ready' AND expires_at > NOW()
        RETURNING subject_kind, subject_id, action, reason`,
      [actionId, channel, String(chatId), partnerId],
    );
    claimed = rows[0];
  } catch (err) {
    logFail('захват «Да»', err);
    return withMenu(OWNER_ACTION_TEXT.unchecked, g.menu);
  }
  if (!claimed) {
    const st = await readState(channel, chatId, partnerId, actionId);
    return withMenu(st === 'unavailable' ? OWNER_ACTION_TEXT.unchecked : blockedText(st), g.menu);
  }

  const action = claimed.action as BookingChatAction;
  const target = claimed.subject_kind === 'booking' ? BOOKING_ACTION_STATUS[action] : undefined;
  if (!target) {
    const stored: StoredOutcome = { kind: 'refused', booking: claimed.subject_id, reason: 'unsupported' };
    await finish(actionId, 'refused', stored);
    return withMenu(outcomeText(stored), g.menu);
  }

  let stored: StoredOutcome;
  try {
    const result = await changeOwnerBookingStatus({
      ownerPartnerId: partnerId,
      actorUserId: g.partner.userId,
      bookingId: claimed.subject_id,
      input: {
        booking_status: target,
        ...(claimed.reason ? { cancellation_reason: claimed.reason } : {}),
      },
      via: channel,
    });
    stored = storedFromResult(claimed.subject_id, result);
  } catch (err) {
    // Отказ мог случиться и после фиксации (чтения для push): «не знаю», а не «не изменено».
    logFail('смена статуса брони из чата', err);
    stored = { kind: 'refused', booking: claimed.subject_id, reason: 'error' };
  }
  await finish(actionId, stored.kind === 'done' ? 'done' : 'refused', stored);
  return withMenu(outcomeText(stored), g.menu);
}

// ── Входы ────────────────────────────────────────────────────────────────────

/**
 * Нажатие `bk:` / `oc:`. Вызывающий уже проверил заверенность апдейта и взял
 * чат из сообщения с кнопкой. Ответ — текст и строки кнопок для этого чата.
 */
export async function handleOwnerPress(input: {
  channel: OwnerChatChannel;
  chatId: number;
  privateChat: boolean;
  presserId: number | null;
  payload: string;
}): Promise<OwnerReply> {
  const press = parseOwnerPress(input.payload);
  if (!press) return { text: OWNER_ACTION_TEXT.unknownButton, buttons: [] };
  const g = await gate(input);
  if (!g.ok) return g.reply;
  if (press.kind === 'booking') return askBooking(g, input.channel, input.chatId, press.action, press.bookingId);
  return answer(g, input.channel, input.chatId, press.actionId, press.yes);
}

const CANCEL_WORDS = /^(?:отмена|отмени(?:те)?|стоп|не надо|не нужно|отбой|нет|передумал\p{L}*)$/u;

function normWords(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

/**
 * Следующее сообщение личного чата после «Отклонить» — причина. null — в этом
 * чате причину не ждут (или это команда, слово меню, или карточке кнопки брони
 * не включены): сообщение идёт дальше.
 * Партнёр — карточка этого чата, уже прочитанная вызывающим; строка чужой
 * карточки причиной не заполняется. Беду в тексте (блок 112) добавляет
 * вызывающий, как ко всякому ответу привязанного чата.
 */
export async function captureOwnerReason(input: {
  channel: OwnerChatChannel;
  chatId: number;
  partner: PartnerChatContext;
  text: string;
}): Promise<OwnerReply | null> {
  const text = input.text.trim();
  if (!text || text.startsWith('/') || roleMenuAsk(text) !== null) return null;
  // Строку ожидания заводит только тот, кому кнопки включены: остальным
  // партнёрам — ни лишнего запроса на каждое сообщение, ни перехвата.
  if (!chatActionsEnabledFor(input.partner)) return null;
  let row: { id: string; subject_id: string } | undefined;
  try {
    const { rows } = await pool.query<{ id: string; subject_id: string }>(
      `SELECT id::text AS id, subject_id FROM partner_chat_actions
        WHERE channel = $1 AND chat_id = $2::bigint AND partner_id = $3::uuid
          AND status = 'awaiting_reason' AND expires_at > NOW()`,
      [input.channel, String(input.chatId), input.partner.partnerId],
    );
    row = rows[0];
  } catch (err) {
    logFail('ждут ли причину', err);
    return null;
  }
  if (!row) return null;
  const menu = partnerMenu(input.partner) ?? [];

  if (CANCEL_WORDS.test(normWords(text))) {
    try {
      await pool.query(
        `UPDATE partner_chat_actions SET status = 'cancelled' WHERE id = $1::uuid AND status = 'awaiting_reason'`,
        [row.id],
      );
    } catch (err) {
      logFail('отмена ожидания причины', err);
      return withMenu(OWNER_ACTION_TEXT.unchecked, menu);
    }
    return withMenu(`Не отклоняю: бронь №${escapeHtml(row.subject_id)} без изменений.`, menu);
  }
  if (text.length > OWNER_REASON_MAX) {
    return withMenu(
      `Причина длиннее ${OWNER_REASON_MAX} знаков — сократите, её получит турист. Бронь №${escapeHtml(row.subject_id)} пока не отклонена.`,
      menu,
      [[{ text: 'Не надо', payload: answerPressPayload(false, row.id) }]],
    );
  }
  try {
    const upd = await pool.query(
      `UPDATE partner_chat_actions
          SET reason = $2, status = 'ready', expires_at = NOW() + make_interval(mins => $3::int)
        WHERE id = $1::uuid AND status = 'awaiting_reason' AND expires_at > NOW()`,
      [row.id, text, OWNER_ACTION_TTL_MIN],
    );
    if (upd.rowCount !== 1) {
      return withMenu('Ожидание причины истекло — нажмите «Отклонить» под бронью ещё раз. Ничего не изменено.', menu);
    }
  } catch (err) {
    logFail('причина отклонения', err);
    return withMenu('Причина не записалась — бронь не изменена. Нажмите «Отклонить» ещё раз.', menu);
  }
  const b = await readOwnBooking(input.partner.partnerId, row.subject_id);
  const facts = b === 'unavailable' ? null : b;
  return withMenu(questionText('cancel', facts, row.subject_id, text), menu, questionButtons('cancel', row.id));
}

/**
 * Ждёт ли этот чат причину отклонения. Консоль администратора в чате, который
 * ещё и кабинет гида (lib/roles/admin-partner-chat), отдаёт такой текст
 * кабинету. Не смогли проверить — false: консоль работает как раньше, в лог —
 * SQLSTATE.
 */
export async function awaitsOwnerReason(channel: OwnerChatChannel, chatId: number): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM partner_chat_actions
        WHERE channel = $1 AND chat_id = $2::bigint AND status = 'awaiting_reason' AND expires_at > NOW()
        LIMIT 1`,
      [channel, String(chatId)],
    );
    return rows.length > 0;
  } catch (err) {
    logFail('ждут ли причину (консоль)', err);
    return false;
  }
}
