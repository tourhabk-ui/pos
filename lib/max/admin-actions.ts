/**
 * Действия администратора из MAX с кнопкой подтверждения — фаза 2 (фаза 1 —
 * чтение, lib/max/admin-read). Владелец 23.10: «действия с кнопкой —
 * следующим шагом»; 07.11 — «Just do it» по схеме карточек подтверждения
 * OpenMausBot: действие предлагает бот, решает человек, просроченный вопрос
 * ничего не делает и сам новым вопросом не становится, каждое решение — в
 * журнале.
 *
 * Первое действие — отметка заявки: «Связался», «Договорились», «Отказ».
 * Второе (2б, слово владельца 07.11 «да») — даты за оператора фразой, как у
 * оператора: lib/max/admin-dates. Третье (2в, 07.11 «да») — подтверждение
 * брони за оператора, сказавшего «да» по телефону: lib/max/admin-bookings.
 * Четвёртое (2г) — пост в канал: «пост» и текст, превью и «Да»:
 * lib/max/admin-post.
 * Вопросы всех родов живут в одной таблице, и живым в чате остаётся
 * последний, какого бы рода он ни был; «Да» и «Не надо» — одни кнопки,
 * исполняет их правило своего рода.
 *
 * ── Шаги ────────────────────────────────────────────────────────────────────
 *
 *   1. Список «Заявки» (lib/max/admin-read) несёт кнопки «Заявка 1…N» —
 *      `ad:o:<uuid>`: карточка заявки без ПД и кнопки отметок.
 *   2. `ad:<k|v|l>:<uuid>` — заявка читается заново, заводится строка
 *      admin_chat_actions (миграция 1400, 15 минут) и задаётся вопрос без ПД:
 *      «Отметить заявку «Тур», 2 чел, от 28.10: «Связался»?» — [Да] [Не надо].
 *      Прежний живой вопрос этого чата снимается: живым остаётся последний.
 *   3. `ad:y:<uuid>` — строка захватывается одним UPDATE … WHERE
 *      status = 'ready' AND expires_at > NOW() и администратором ЭТОГО
 *      нажатия: второе нажатие строку уже не захватит, чужая строка не
 *      исполнится. Затем то же правило, что у кабинета оператора и гида, —
 *      `changeLeadStatus` (lib/leads/owner-lead-status) со скоупом
 *      администратора и событием в ленте клиента. Итог — в outcome; повтор
 *      отвечает прежним итогом. `ad:n:<uuid>` — «Не надо», ничего не меняется.
 *
 * ── Кто вправе (каждая проверка — свой исход, «не смог проверить» ≠ «нельзя») ─
 *
 *   - вызывающий пускает только заверенный апдейт (`verifiedOrigin`) и берёт
 *     чат из сообщения с кнопкой;
 *   - личный диалог: в группе кнопку нажал бы любой участник;
 *   - нажавший — человек MAX, привязанный ссылкой из админки, и его аккаунт
 *     СЕЙЧАС владеет ролью администратора (`findMaxAdmin`, на каждом нажатии,
 *     а не однажды при вопросе): снятая роль гасит и живой вопрос;
 *   - кнопки-записи (`ad:k|v|l`, `ad:y|n`) подписаны и живут 3 дня, как все
 *     кнопки-записи чатов (lib/chat-cabinet/signed-payload): собранная руками
 *     или старая кнопка отвергается до разбора. 15 минут вопроса держит база,
 *     подпись — вторая линия. «Заявка N» (`ad:o`) — чтение и не подписана.
 *
 * ПД: ни карточка, ни вопрос, ни итог не называют имени, телефона и почты
 * туриста — только тему заявки (через `redactPII`: поле приходит из формы),
 * число людей, день заявки и адресата. Контакты есть только в самом списке
 * «Заявки», который уходит через sendPdAlert. Отказ базы — имя проверки и
 * SQLSTATE в лог.
 */

import { pool } from '@/lib/db-pool';
import type { PoolClient } from 'pg';
import { findMaxAdmin } from '@/lib/max/admin-link';
import { changeLeadStatus, type LeadChangeResult } from '@/lib/leads/owner-lead-status';
import { LEAD_STATUS_WORDS, OWNER_LEAD_ACTION_LABEL, leadAlreadyText } from '@/lib/leads/owner-lead-words';
import { redactPII } from '@/lib/security/pii-redact';
import { kamchatkaDate, ruShort } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';
import { adminMenu } from '@/lib/roles/role-menu';
import { menuRows, type MenuButton } from '@/lib/roles/chat-menu';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';

/** Сколько живёт вопрос «Да / Не надо», минут. Префикс кнопок `ad:` — в реестре lib/max/verified-press. */
export const ADMIN_ACTION_TTL_MIN = 15;
/** Захваченное «Да» без итога дольше этого — процесс оборвался, исход неизвестен. */
const RUNNING_STALE_SEC = 120;
/** Сколько заявок списка получают кнопку «Заявка N». */
export const ADMIN_LEAD_BUTTONS = 6;

export type AdminLeadAction = 'contacted' | 'converted' | 'lost';
export const ADMIN_LEAD_ACTIONS: readonly AdminLeadAction[] = ['contacted', 'converted', 'lost'];

const ACTION_CODE: Record<AdminLeadAction, string> = { contacted: 'k', converted: 'v', lost: 'l' };
const CODE_ACTION: Record<string, AdminLeadAction> = { k: 'contacted', v: 'converted', l: 'lost' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AdminPress =
  | { kind: 'open_lead'; leadId: string }
  | { kind: 'lead'; action: AdminLeadAction; leadId: string }
  | { kind: 'answer'; actionId: string; yes: boolean }
  /** Выбор тура под вопросом о датах (lib/max/admin-dates): индекс кандидата. */
  | { kind: 'tour_choice'; actionId: string; index: number }
  /** «Бронь N» под списком «Брони» и «Оператор подтвердил» (lib/max/admin-bookings). */
  | { kind: 'open_booking'; bookingId: string }
  | { kind: 'booking_confirm'; bookingId: string };

/** Разбор кнопки `ad:`. null — не наша форма: ничего не выполняется. */
export function parseAdminPress(payload: string): AdminPress | null {
  const t = /^ad:t:(.+):([0-7])$/.exec(payload);
  if (t) return UUID.test(t[1]) ? { kind: 'tour_choice', actionId: t[1], index: Number(t[2]) } : null;
  const b = /^ad:([bc]):([1-9][0-9]{0,18})$/.exec(payload);
  if (b) return b[1] === 'b' ? { kind: 'open_booking', bookingId: b[2] } : { kind: 'booking_confirm', bookingId: b[2] };
  const m = /^ad:([okvlyn]):(.+)$/.exec(payload);
  if (!m || !UUID.test(m[2])) return null;
  const [, code, id] = m;
  if (code === 'o') return { kind: 'open_lead', leadId: id };
  if (code === 'y' || code === 'n') return { kind: 'answer', actionId: id, yes: code === 'y' };
  return { kind: 'lead', action: CODE_ACTION[code], leadId: id };
}

/** «Заявка N» — чтение: карточку без ПД открывает и старая кнопка, права проверяются на нажатии. */
export const adminOpenLeadPayload = (leadId: string): string => `ad:o:${leadId}`;
/** Отметка и ответ — записи: подпись и срок 3 дня (lib/chat-cabinet/signed-payload), 56 байт с хвостом. */
export const adminLeadPayload = (action: AdminLeadAction, leadId: string): string =>
  signPayload(`ad:${ACTION_CODE[action]}:${leadId}`);
export const adminAnswerPayload = (yes: boolean, actionId: string): string =>
  signPayload(`ad:${yes ? 'y' : 'n'}:${actionId}`);
/** Выбор тура кандидатом `index` (0…7) — тоже запись: вопрос становится готовым. 58 байт с хвостом. */
export const adminTourPayload = (actionId: string, index: number): string =>
  signPayload(`ad:t:${actionId}:${index}`);
/** «Бронь N» — чтение: карточка брони без ПД. */
export const adminOpenBookingPayload = (bookingId: string): string => `ad:b:${bookingId}`;
/** «Оператор подтвердил» — запись: заводит вопрос «Да / Не надо», подписана. */
export const adminBookingConfirmPayload = (bookingId: string): string => signPayload(`ad:c:${bookingId}`);

/** Кнопки «Бронь 1…N» под списком «Брони»: открыть карточку брони. */
export function adminBookingOpenButtons(bookingIds: readonly string[]): MenuButton[][] {
  const row = bookingIds.slice(0, ADMIN_LEAD_BUTTONS).map((id, i) => ({ text: `Бронь ${i + 1}`, payload: adminOpenBookingPayload(id) }));
  return row.length ? [row] : [];
}

/** Кнопки «Заявка 1…N» под списком «Заявки»: открыть карточку заявки. */
export function adminLeadOpenButtons(leadIds: readonly string[]): MenuButton[][] {
  const row = leadIds.slice(0, ADMIN_LEAD_BUTTONS).map((id, i) => ({ text: `Заявка ${i + 1}`, payload: adminOpenLeadPayload(id) }));
  return row.length ? [row] : [];
}

/** Ответ в чат: текст и строки кнопок (строка меню администратора — последней). */
export interface AdminActionReply {
  text: string;
  buttons: MenuButton[][];
}

function reply(text: string, rows: MenuButton[][] = []): AdminActionReply {
  return { text, buttons: [...rows, ...menuRows(adminMenu())] };
}
/** Тот же ответ для вопросов о датах (lib/max/admin-dates): строка меню — последней. */
export const adminActionReply = reply;

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

/** Отказ — в лог: имя проверки и SQLSTATE. Текст ошибки не пишется — в нём бывают значения строки. */
function logFail(check: string, err: unknown): void {
  console.error(`[max/admin-actions] ${check} — отказ, SQLSTATE ${sqlstate(err)}`);
}

export const ADMIN_ACTION_TEXT = {
  unknownButton: 'Эта кнопка не распознана — ничего не изменено.',
  notDialog: 'Кнопки администратора работают в личном диалоге с ботом. Здесь ничего не изменено.',
  unchecked: 'Не удалось проверить права администратора — ничего не изменено. Попробуйте ещё раз чуть позже.',
  notAdmin: 'Эти кнопки — у администратора Ведара, подключённого из админки. Ничего не изменено.',
  leadUnread: 'Заявка не прочиталась: база не ответила. Ничего не изменено — попробуйте ещё раз.',
  leadNotFound: 'Заявки больше нет — ничего не изменено.',
  notSaved: 'Вопрос не записался — ничего не изменено. Попробуйте ещё раз.',
  notFoundAction: 'Этот вопрос не найден — ничего не изменено.',
} as const;

// ── Заявка ───────────────────────────────────────────────────────────────────

interface LeadFacts {
  id: string;
  status: string;
  title: string;
  people: number | null;
  day: string;
  addressee: string | null;
}

async function readLead(leadId: string): Promise<LeadFacts | null | 'unavailable'> {
  try {
    const { rows } = await pool.query<{
      id: string; status: string; title: string; people: number | null; created_at: Date | string; addressee: string | null;
    }>(
      `SELECT l.id::text AS id, l.status, COALESCE(NULLIF(btrim(l.route_title), ''), 'Подбор тура') AS title,
              l.group_size::int AS people, l.created_at, COALESCE(p.company_name, p.name) AS addressee
         FROM leads l
         LEFT JOIN partners p ON p.id = l.operator_id
        WHERE l.id = $1::uuid`,
      [leadId],
    );
    const r = rows[0];
    if (!r) return null;
    const created = r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    return {
      id: r.id, status: r.status, title: r.title, people: r.people, day: kamchatkaDate(created), addressee: r.addressee,
    };
  } catch (err) {
    logFail('заявка для администратора', err);
    return 'unavailable';
  }
}

/** «Тур», 2 чел, от 28.10 — без имени, телефона и свободного текста туриста. */
function leadFactsLine(l: LeadFacts): string {
  const bits = [`«${escapeHtml(redactPII(l.title))}»`];
  if (l.people !== null && l.people > 0) bits.push(`${l.people} чел`);
  bits.push(`от ${ruShort(l.day)}`);
  return bits.join(', ');
}

function statusWord(status: string): string {
  return escapeHtml(LEAD_STATUS_WORDS[status] ?? status);
}

function leadCard(l: LeadFacts): AdminActionReply {
  const to = l.addressee ? `оператору ${escapeHtml(l.addressee)}` : 'без адресата';
  const text = `Заявка ${leadFactsLine(l)}, ${to}. Сейчас: «${statusWord(l.status)}».\n\n`
    + 'Что отметить? Перед записью спрошу подтверждение. Туристу ничего не уйдёт.';
  const row = ADMIN_LEAD_ACTIONS.filter((a) => a !== l.status)
    .map((a) => ({ text: OWNER_LEAD_ACTION_LABEL[a], payload: adminLeadPayload(a, l.id) }));
  return reply(text, row.length ? [row] : []);
}

const YES_LABEL: Record<AdminLeadAction, string> = {
  contacted: 'Да, связался',
  converted: 'Да, договорились',
  lost: 'Да, отказ',
};

async function openAction(args: {
  adminUserId: string;
  chatId: number;
  leadId: string;
  action: AdminLeadAction;
}): Promise<string | null> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Живым остаётся последний вопрос этого чата: «Да» под старым не исполнится.
    await client.query(
      `UPDATE admin_chat_actions SET status = 'superseded'
        WHERE admin_user_id = $1::uuid AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
      [args.adminUserId, String(args.chatId)],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO admin_chat_actions (admin_user_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at)
       VALUES ($1::uuid, 'max', $2::bigint, 'lead', $3, $4, 'ready', NOW() + make_interval(mins => $5::int))
       RETURNING id::text AS id`,
      [args.adminUserId, String(args.chatId), args.leadId, args.action, ADMIN_ACTION_TTL_MIN],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('новый вопрос администратора', err);
    await client?.query('ROLLBACK').catch((e: unknown) => logFail('откат нового вопроса', e));
    return null;
  } finally {
    client?.release();
  }
}

async function askLead(adminUserId: string, chatId: number, action: AdminLeadAction, leadId: string): Promise<AdminActionReply> {
  const l = await readLead(leadId);
  if (l === 'unavailable') return reply(ADMIN_ACTION_TEXT.leadUnread);
  if (!l) return reply(ADMIN_ACTION_TEXT.leadNotFound);
  // Тот же статус — «уже», вопроса нет (перехода «нельзя» у заявки нет, как на сайте).
  if (l.status === action) return reply(leadAlreadyText(action));
  const id = await openAction({ adminUserId, chatId, leadId: l.id, action });
  if (!id) return reply(ADMIN_ACTION_TEXT.notSaved);
  const text = `Отметить заявку ${leadFactsLine(l)}: «${OWNER_LEAD_ACTION_LABEL[action]}»? Сейчас: «${statusWord(l.status)}». `
    + `Туристу ничего не уйдёт — отметка для ленты клиента и сторожа заявок. Вопрос живёт ${ADMIN_ACTION_TTL_MIN} минут.`;
  return reply(text, [[
    { text: YES_LABEL[action], payload: adminAnswerPayload(true, id), intent: action === 'lost' ? 'negative' : 'positive' },
    { text: 'Не надо', payload: adminAnswerPayload(false, id) },
  ]]);
}

// ── «Да» / «Не надо» ─────────────────────────────────────────────────────────

/** Итог в строке вопроса — им же отвечает повтор. */
type StoredOutcome =
  | { kind: 'lead_done'; lead: string; status: string; changed: boolean }
  | { kind: 'lead_refused'; lead: string; reason: 'not_found' | 'error' };

function readStored(v: unknown): StoredOutcome | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'lead_done' && typeof o.lead === 'string' && typeof o.status === 'string') {
    return { kind: 'lead_done', lead: o.lead, status: o.status, changed: o.changed === true };
  }
  if (o.kind === 'lead_refused' && typeof o.lead === 'string' && (o.reason === 'not_found' || o.reason === 'error')) {
    return { kind: 'lead_refused', lead: o.lead, reason: o.reason };
  }
  return null;
}

export function adminOutcomeText(o: StoredOutcome): string {
  if (o.kind === 'lead_done') {
    if (!o.changed) return leadAlreadyText(o.status);
    return `Заявка отмечена: «${statusWord(o.status)}». Туристу ничего не отправлено.`;
  }
  if (o.reason === 'not_found') return ADMIN_ACTION_TEXT.leadNotFound;
  return 'Не удалось записать отметку: не знаю, изменилась ли заявка. Проверьте её в админке, раздел «Заявки».';
}

export interface StateRow {
  status: string;
  outcome: unknown;
  expired: boolean;
  stale: boolean;
}

/** Чем вопрос своего рода отличается в отказе: что сделать заново и как сказать прежний итог. */
export interface BlockedWords {
  /** «откройте заявку из списка «Заявки» ещё раз» / «напишите фразу ещё раз». */
  again: string;
  /** Итог исполненного вопроса словами; null — итог не прочитался. */
  outcome: (stored: unknown) => string | null;
  /** Где проверить, если итог не прочитался. */
  checkWhere: string;
}

const LEAD_BLOCKED: BlockedWords = {
  again: 'откройте заявку из списка «Заявки» ещё раз',
  outcome: (v) => {
    const stored = readStored(v);
    return stored ? adminOutcomeText(stored) : null;
  },
  checkWhere: 'в админке, раздел «Заявки»',
};

/** Строку не захватить: почему — словами (повтор, отмена, замена, срок, чужая). */
export function blockedText(r: StateRow | undefined, words: BlockedWords = LEAD_BLOCKED): string {
  if (!r) return ADMIN_ACTION_TEXT.notFoundAction;
  if (r.status === 'done' || r.status === 'refused') {
    const told = words.outcome(r.outcome);
    return told ? `Уже нажато раньше. ${told}` : `Уже нажато раньше — итог ${words.checkWhere}.`;
  }
  if (r.status === 'running') {
    return r.stale
      ? `Нажатие принято, но итог не записан — проверьте ${words.checkWhere}.`
      : 'Уже выполняю это действие — ответ придёт следом.';
  }
  if (r.status === 'cancelled') return 'Это действие отменено — ничего не изменено.';
  if (r.status === 'superseded') return 'Этот вопрос заменён следующим — ничего не изменено.';
  if (r.status === 'draft' && !r.expired) return 'Сначала выберите тур кнопкой под вопросом — ничего не изменено.';
  if (r.status === 'ready' && !r.expired) return 'Уже ждёт ответа: нажмите «Да» или «Не надо» под вопросом.';
  return `Вопрос устарел (${ADMIN_ACTION_TTL_MIN} минут) — ${words.again}. Ничего не изменено.`;
}

export async function readState(adminUserId: string, chatId: number, actionId: string): Promise<StateRow | undefined | 'unavailable'> {
  try {
    const { rows } = await pool.query<StateRow>(
      `SELECT status, outcome, expires_at <= NOW() AS expired,
              (used_at IS NOT NULL AND used_at < NOW() - make_interval(secs => $4::int)) AS stale
         FROM admin_chat_actions
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint`,
      [actionId, adminUserId, String(chatId), RUNNING_STALE_SEC],
    );
    return rows[0];
  } catch (err) {
    logFail('состояние вопроса', err);
    return 'unavailable';
  }
}

async function finish(actionId: string, status: 'done' | 'refused', outcome: StoredOutcome): Promise<void> {
  try {
    const upd = await pool.query(
      `UPDATE admin_chat_actions SET status = $2, outcome = $3::jsonb
        WHERE id = $1::uuid AND status = 'running'`,
      [actionId, status, JSON.stringify(outcome)],
    );
    if (upd.rowCount !== 1) console.error(`[max/admin-actions] итог записан в ${upd.rowCount ?? 0} строк вместо одной`);
  } catch (err) {
    logFail('итог вопроса', err);
  }
}

function storedFromLead(leadId: string, result: LeadChangeResult): StoredOutcome {
  if (result.kind === 'not_found') return { kind: 'lead_refused', lead: leadId, reason: 'not_found' };
  return { kind: 'lead_done', lead: leadId, status: result.lead.status, changed: result.changed };
}

/** Род вопроса этого администратора в этом чате: заявка, даты, бронь, пост; null — такого вопроса нет. */
async function actionKind(
  adminUserId: string, chatId: number, actionId: string,
): Promise<'lead' | 'tour' | 'booking' | 'post' | null | 'unavailable'> {
  try {
    const { rows } = await pool.query<{ subject_kind: string }>(
      `SELECT subject_kind FROM admin_chat_actions
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint`,
      [actionId, adminUserId, String(chatId)],
    );
    const kind = rows[0]?.subject_kind;
    return kind === 'lead' || kind === 'tour' || kind === 'booking' || kind === 'post' ? kind : null;
  } catch (err) {
    logFail('род вопроса', err);
    return 'unavailable';
  }
}

async function answer(adminUserId: string, chatId: number, actionId: string, yes: boolean): Promise<AdminActionReply> {
  // «Да» и «Не надо» — одни кнопки на оба рода; исполняет правило своего рода.
  const kind = await actionKind(adminUserId, chatId, actionId);
  if (kind === 'unavailable') return reply(ADMIN_ACTION_TEXT.unchecked);
  if (kind === null) return reply(ADMIN_ACTION_TEXT.notFoundAction);
  if (kind === 'tour') return (await import('@/lib/max/admin-dates')).answerDates(adminUserId, chatId, actionId, yes);
  if (kind === 'booking') return (await import('@/lib/max/admin-bookings')).answerBooking(adminUserId, chatId, actionId, yes);
  if (kind === 'post') return (await import('@/lib/max/admin-post')).answerPost(adminUserId, chatId, actionId, yes);
  if (!yes) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE admin_chat_actions SET status = 'cancelled'
          WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
            AND subject_kind = 'lead' AND status = 'ready'`,
        [actionId, adminUserId, String(chatId)],
      );
      if (rowCount === 1) return reply('Хорошо, заявка без изменений.');
    } catch (err) {
      logFail('«Не надо»', err);
      return reply(ADMIN_ACTION_TEXT.unchecked);
    }
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st));
  }

  // Захват: одна строка, этого чата и ЭТОГО администратора, готовая и не истёкшая.
  let claimed: { subject_id: string; action: string } | undefined;
  try {
    const { rows } = await pool.query<{ subject_id: string; action: string }>(
      `UPDATE admin_chat_actions SET status = 'running', used_at = NOW()
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
          AND subject_kind = 'lead' AND status = 'ready' AND expires_at > NOW()
        RETURNING subject_id, action`,
      [actionId, adminUserId, String(chatId)],
    );
    claimed = rows[0];
  } catch (err) {
    logFail('захват «Да»', err);
    return reply(ADMIN_ACTION_TEXT.unchecked);
  }
  if (!claimed) {
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st));
  }
  const action = (ADMIN_LEAD_ACTIONS as readonly string[]).includes(claimed.action)
    ? claimed.action as AdminLeadAction
    : null;
  let stored: StoredOutcome;
  if (!action) {
    stored = { kind: 'lead_refused', lead: claimed.subject_id, reason: 'error' };
  } else {
    try {
      stored = storedFromLead(claimed.subject_id, await changeLeadStatus({
        leadId: claimed.subject_id,
        status: action,
        actor: { kind: 'admin', userId: adminUserId },
        scope: { kind: 'admin' },
        via: 'max',
      }));
    } catch (err) {
      logFail('отметка заявки администратором', err);
      stored = { kind: 'lead_refused', lead: claimed.subject_id, reason: 'error' };
    }
  }
  await finish(actionId, stored.kind === 'lead_done' ? 'done' : 'refused', stored);
  return reply(adminOutcomeText(stored));
}

// ── Вход ─────────────────────────────────────────────────────────────────────

/**
 * Нажатие `ad:`. Вызывающий уже проверил заверенность апдейта и взял чат из
 * сообщения с кнопкой. Права администратора — здесь, на каждом нажатии.
 */
export async function handleAdminPress(input: {
  chatId: number;
  privateChat: boolean;
  presserId: number | null;
  payload: string;
}): Promise<AdminActionReply> {
  const press = parseAdminPress(input.payload);
  if (!press) return { text: ADMIN_ACTION_TEXT.unknownButton, buttons: [] };
  if (!input.privateChat) return { text: ADMIN_ACTION_TEXT.notDialog, buttons: [] };
  if (input.presserId === null) return { text: ADMIN_ACTION_TEXT.unchecked, buttons: [] };
  const admin = await findMaxAdmin(input.presserId);
  if (admin.outcome === 'unavailable') return { text: ADMIN_ACTION_TEXT.unchecked, buttons: [] };
  if (admin.outcome !== 'admin') return { text: ADMIN_ACTION_TEXT.notAdmin, buttons: [] };

  if (press.kind === 'open_lead') {
    const l = await readLead(press.leadId);
    if (l === 'unavailable') return reply(ADMIN_ACTION_TEXT.leadUnread);
    if (!l) return reply(ADMIN_ACTION_TEXT.leadNotFound);
    return leadCard(l);
  }
  if (press.kind === 'lead') return askLead(admin.userId, input.chatId, press.action, press.leadId);
  if (press.kind === 'tour_choice') {
    return (await import('@/lib/max/admin-dates')).chooseAdminTour(admin.userId, input.chatId, press.actionId, press.index);
  }
  if (press.kind === 'open_booking') return (await import('@/lib/max/admin-bookings')).bookingCardReply(press.bookingId);
  if (press.kind === 'booking_confirm') {
    return (await import('@/lib/max/admin-bookings')).askBookingConfirm(admin.userId, input.chatId, press.bookingId);
  }
  return answer(admin.userId, input.chatId, press.actionId, press.yes);
}
