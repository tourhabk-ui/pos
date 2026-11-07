/**
 * Подтверждение брони за оператора из MAX администратора — фаза 2в. Слово
 * владельца 07.11: «да» на «бронь ждёт ответа оператора, вы ему позвонили и
 * жмёте «Оператор подтвердил». Турист получит обычное подтверждение. Риск
 * больше: когда оплату снова включат, после подтверждения турист сможет
 * платить».
 *
 * ── Поток ──────────────────────────────────────────────────────────────────
 *
 *   1. «Брони» (lib/max/admin-read) — список с контактами только в личный MAX,
 *      следом без ПД кнопки «Бронь 1…6» (`ad:b:<id>`).
 *   2. Карточка брони без ПД: тур, день, люди, оператор, статус, сколько ждёт.
 *      У брони, которая ждёт оператора, — «Оператор подтвердил» (`ad:c:<id>`,
 *      подписана, как все кнопки-записи).
 *   3. Вопрос «Подтвердить бронь за оператора …?» — «Да, подтвердить» /
 *      «Не надо». До «Да» бронь не меняется, вопрос живёт 15 минут, новый
 *      вопрос в чате снимает прежний.
 *   4. «Да» — захват строки одним UPDATE, как у отметки заявки, права
 *      администратора — на этом нажатии. Затем та же дверь, что у кабинета
 *      оператора и его чата: `changeOwnerBookingStatus` — владение по туру
 *      оператора на момент вопроса, переход только new → confirmed (уже
 *      подтверждена — «уже», отменена — отказ), письмо, push и Telegram
 *      туристу, в ленте клиента исполнитель — admin. Исход письма —
 *      администратору словами.
 *   5. Сменилось — оператору в его MAX или Telegram: «Администратор Ведара
 *      подтвердил за вас бронь …», без ПД туриста. Исход — в журнал
 *      (`outcome.notified`) и администратору: не дошло — «сообщите сами».
 *
 * ── Деньги (CLAUDE.md §7, скилл money-path) ───────────────────────────────
 *
 * Платится бронь, подтверждённая оператором. Администратор подтверждает за
 * оператора только с его слов — вопрос говорит это до «Да». Оплату здесь не
 * трогает ничто: ни `paid_at`, ни `tour_payments`, ни комиссия. Пока приём
 * оплаты выключен (`platformAcceptsPayments`), туристу уходит «оплата —
 * напрямую оператору»; включат — письмо той же двери поведёт к оплате, и
 * вопрос называет это до «Да».
 *
 * ПД: карточка, вопрос, итог, журнал и сообщение оператору — без имени,
 * телефона и почты туриста. Контакты есть только в списке «Брони», который
 * уходит через sendPdAlert.
 *
 * Сторож: tests/integration/max-login-confirm.pg.test.ts — путь целиком на
 * схеме прода и настоящем обработчике бота.
 */

import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { changeOwnerBookingStatus, type OwnerStatusResult } from '@/lib/bookings/owner-status';
import { platformAcceptsPayments } from '@/lib/payments/accepting';
import { reachForPartner } from '@/lib/partners/reach';
import { ownerBookingsUrl } from '@/lib/partners/cabinet-links';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { dayLong } from '@/lib/operators/chat-dates/texts';
import {
  ADMIN_ACTION_TEXT, ADMIN_ACTION_TTL_MIN, type AdminActionReply, type BlockedWords,
  adminActionReply as reply, adminAnswerPayload, adminBookingConfirmPayload, blockedText, readState,
} from '@/lib/max/admin-actions';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

/** Отказ — в лог: имя проверки и SQLSTATE. Текст ошибки не пишется — в нём бывают значения строки. */
function logFail(check: string, err: unknown): void {
  console.error(`[max/admin-bookings] ${check} — отказ, SQLSTATE ${sqlstate(err)}`);
}

/** Статус брони словами администратора: о чужой брони, а не «ваш ответ». */
const STATUS_WORD: Readonly<Record<string, string>> = {
  new: 'ждёт подтверждения оператора',
  pending_payment: 'ждёт оплаты',
  confirmed: 'подтверждена',
  cancelled: 'отменена',
  completed: 'завершена',
  no_show: 'турист не пришёл',
};
const statusWord = (s: string): string => escapeHtml(STATUS_WORD[s] ?? s);

const BOOKING_TEXT = {
  unread: 'Бронь не прочиталась: база не ответила. Ничего не изменено — попробуйте ещё раз.',
  notFound: 'Брони больше нет — ничего не изменено.',
  noOperator: 'У тура этой брони не записан оператор — подтвердить за него нельзя. Ничего не изменено.',
  cancelled: 'Хорошо, бронь без изменений.',
} as const;

/** Исход сообщения оператору. */
type Notified = 'max' | 'telegram' | 'none' | 'unknown' | 'failed';

const NOTIFIED_TEXT: Record<Notified, string> = {
  max: 'Оператору сообщил в MAX, что бронь подтвердили вы.',
  telegram: 'Оператору сообщил в Telegram, что бронь подтвердили вы.',
  none: 'У оператора не подключён ни MAX, ни Telegram — сообщите ему сами, что бронь подтвердили вы.',
  unknown: 'Не смог прочитать, куда писать оператору, — сообщите ему сами, что бронь подтвердили вы.',
  failed: 'Сообщение оператору не ушло — сообщите ему сами, что бронь подтвердили вы.',
};

// ── Бронь ────────────────────────────────────────────────────────────────────

interface BookingFacts {
  id: string;
  status: string;
  title: string | null;
  day: string;
  people: number;
  operatorId: string | null;
  operatorName: string | null;
  ageH: number;
}

async function readBooking(id: string): Promise<BookingFacts | null | 'unavailable'> {
  try {
    const { rows } = await pool.query<{
      id: string; status: string; title: string | null; day: string; people: number;
      operator_id: string | null; operator_name: string | null; age_h: number;
    }>(
      `SELECT ob.id::text AS id, ob.booking_status AS status, ot.title,
              ob.booking_date::text AS day, ob.participants::int AS people,
              p.id::text AS operator_id, p.name AS operator_name,
              FLOOR(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - ob.created_at)) / 3600)::int AS age_h
         FROM operator_bookings ob
         LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
         LEFT JOIN partners p ON p.id = ot.operator_id
        WHERE ob.id = $1::bigint AND ob.deleted_at IS NULL`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, status: r.status, title: r.title, day: r.day, people: r.people,
      operatorId: r.operator_id, operatorName: r.operator_name, ageH: r.age_h,
    };
  } catch (err) {
    logFail('бронь для администратора', err);
    return 'unavailable';
  }
}

/** «№7001, «Тур», 12 ноября 2026, 2 чел» — без имени, телефона и почты туриста. */
function bookingLine(id: string, title: string | null, day: string, people: number): string {
  return `№${escapeHtml(id)}, «${escapeHtml(title ?? 'тур удалён')}», ${dayLong(day)}, ${people} чел`;
}

/** Карточка брони без ПД по нажатию «Бронь N». */
export async function bookingCardReply(bookingId: string): Promise<AdminActionReply> {
  const b = await readBooking(bookingId);
  if (b === 'unavailable') return reply(BOOKING_TEXT.unread);
  if (!b) return reply(BOOKING_TEXT.notFound);
  const op = b.operatorName ? `оператор «${escapeHtml(b.operatorName)}»` : 'оператор не записан';
  const waits = b.status === 'new' ? `, ждёт ${b.ageH} ч` : '';
  const head = `Бронь ${bookingLine(b.id, b.title, b.day, b.people)}, ${op}. Сейчас: «${statusWord(b.status)}»${waits}.`;
  if (b.status !== 'new' || !b.operatorId) {
    return reply(`${head}\n\nПодтверждать нечего — ничего не изменено.`);
  }
  return reply(
    `${head}\n\nОператор сказал вам «да»? Нажмите «Оператор подтвердил» — перед записью спрошу ещё раз. `
      + 'Контакты туриста — в списке «Брони».',
    [[{ text: 'Оператор подтвердил', payload: adminBookingConfirmPayload(b.id), intent: 'positive' }]],
  );
}

// ── Вопрос ───────────────────────────────────────────────────────────────────

/** Что лежит в params вопроса (1402): кто оператор и что за бронь — для итога и журнала. */
interface BookingParams {
  operator: string;
  operatorName: string | null;
  title: string | null;
  day: string;
  people: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function readParams(v: unknown): BookingParams | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.operator !== 'string' || !UUID.test(o.operator)) return null;
  if (typeof o.day !== 'string' || !ISO.test(o.day) || typeof o.people !== 'number') return null;
  return {
    operator: o.operator,
    operatorName: typeof o.operatorName === 'string' ? o.operatorName : null,
    title: typeof o.title === 'string' ? o.title : null,
    day: o.day,
    people: o.people,
  };
}

/** Новый вопрос одной транзакцией: прежний живой вопрос чата снимается, новый вставляется. */
async function insertQuestion(adminUserId: string, chatId: number, bookingId: string, params: BookingParams): Promise<string | null> {
  const client = await pool.connect().catch((err: unknown) => {
    logFail('соединение для вопроса о брони', err);
    return null;
  });
  if (!client) return null;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE admin_chat_actions SET status = 'superseded'
        WHERE admin_user_id = $1::uuid AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
      [adminUserId, String(chatId)],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO admin_chat_actions
         (admin_user_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at, params)
       VALUES ($1::uuid, 'max', $2::bigint, 'booking', $3, 'confirm', 'ready',
               NOW() + make_interval(mins => $4::int), $5::jsonb)
       RETURNING id::text AS id`,
      [adminUserId, String(chatId), bookingId, ADMIN_ACTION_TTL_MIN, JSON.stringify(params)],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('новый вопрос о брони', err);
    await client.query('ROLLBACK').catch((e: unknown) => logFail('откат вопроса о брони', e));
    return null;
  } finally {
    client.release();
  }
}

/** Нажатие «Оператор подтвердил»: вопрос «Подтвердить бронь за оператора …?». */
export async function askBookingConfirm(adminUserId: string, chatId: number, bookingId: string): Promise<AdminActionReply> {
  const b = await readBooking(bookingId);
  if (b === 'unavailable') return reply(BOOKING_TEXT.unread);
  if (!b) return reply(BOOKING_TEXT.notFound);
  if (b.status !== 'new') return reply(`Бронь уже «${statusWord(b.status)}» — подтверждать нечего, ничего не изменено.`);
  if (!b.operatorId) return reply(BOOKING_TEXT.noOperator);
  const id = await insertQuestion(adminUserId, chatId, b.id, {
    operator: b.operatorId, operatorName: b.operatorName, title: b.title, day: b.day, people: b.people,
  });
  if (!id) return reply(ADMIN_ACTION_TEXT.notSaved);
  const who = b.operatorName ? ` «${escapeHtml(b.operatorName)}»` : '';
  const pay = platformAcceptsPayments()
    ? 'в письме — ссылка на оплату через Ведар'
    : 'оплата — напрямую оператору, Ведар её сейчас не принимает';
  return reply(
    `Подтвердить бронь за оператора${who}: ${bookingLine(b.id, b.title, b.day, b.people)}?\n\n`
      + 'Подтверждайте, только если оператор сказал вам «да». Туристу уйдёт подтверждение — письмо, push и Telegram, '
      + `что у него подключено; ${pay}. Оператору сообщу, что бронь подтвердили вы.\n`
      + `До «Да» ничего не меняется. Вопрос живёт ${ADMIN_ACTION_TTL_MIN} минут.`,
    [[
      { text: 'Да, подтвердить', payload: adminAnswerPayload(true, id), intent: 'positive' },
      { text: 'Не надо', payload: adminAnswerPayload(false, id) },
    ]],
  );
}

// ── «Да» / «Не надо» ─────────────────────────────────────────────────────────

/** Итог в строке вопроса — им же отвечает повтор. */
type StoredOutcome =
  | { kind: 'booking_done'; changed: true; tourist: 'sent' | 'retrying' | 'no_email' | 'none' }
  | { kind: 'booking_done'; changed: false }
  | { kind: 'booking_refused'; reason: 'not_found' | 'error' }
  | { kind: 'booking_refused'; reason: 'bad_transition'; from: string };

function readStored(v: unknown): StoredOutcome | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'booking_done' && o.changed === true) {
    const t = o.tourist;
    return { kind: 'booking_done', changed: true, tourist: t === 'sent' || t === 'retrying' || t === 'no_email' ? t : 'none' };
  }
  if (o.kind === 'booking_done' && o.changed === false) return { kind: 'booking_done', changed: false };
  if (o.kind === 'booking_refused' && (o.reason === 'not_found' || o.reason === 'error')) {
    return { kind: 'booking_refused', reason: o.reason };
  }
  if (o.kind === 'booking_refused' && o.reason === 'bad_transition' && typeof o.from === 'string') {
    return { kind: 'booking_refused', reason: 'bad_transition', from: o.from };
  }
  return null;
}

function notifiedOf(v: unknown): Notified | null {
  const n = v && typeof v === 'object' ? (v as Record<string, unknown>).notified : null;
  return n === 'max' || n === 'telegram' || n === 'none' || n === 'unknown' || n === 'failed' ? n : null;
}

const TOURIST_TEXT: Record<'sent' | 'retrying' | 'no_email' | 'none', string> = {
  sent: 'Письмо туристу ушло.',
  retrying: 'Письмо туристу пока не ушло — отправка повторится сама.',
  no_email: 'Почты туриста в брони нет — письма не было; push и Telegram — если турист их подключил.',
  none: 'Об уведомлении туриста дверь ничего не сказала — проверьте бронь в админке.',
};

function outcomeText(o: StoredOutcome, params: BookingParams | null, notified: Notified | null, bookingId: string): string {
  const line = params ? bookingLine(bookingId, params.title, params.day, params.people) : `№${escapeHtml(bookingId)}`;
  if (o.kind === 'booking_refused') {
    if (o.reason === 'not_found') return 'Брони нет или тур сменил оператора — ничего не изменено. Откройте бронь из списка «Брони» ещё раз.';
    if (o.reason === 'bad_transition') return `Бронь уже «${statusWord(o.from)}» — подтвердить её нельзя. Ничего не изменено.`;
    return 'Не удалось записать подтверждение: не знаю, подтвердилась ли бронь. Проверьте её в админке, раздел «Брони».';
  }
  if (!o.changed) return `Бронь ${line} уже подтверждена — ничего не изменено, туристу повторно ничего не отправлено.`;
  const who = params?.operatorName ? ` за оператора «${escapeHtml(params.operatorName)}»` : ' за оператора';
  const lines = [`Бронь подтверждена${who}: ${line}.`, TOURIST_TEXT[o.tourist]];
  if (notified) lines.push(NOTIFIED_TEXT[notified]);
  return lines.join('\n');
}

const BOOKING_BLOCKED: BlockedWords = {
  again: 'откройте бронь из списка «Брони» ещё раз',
  outcome: (v) => {
    const o = readStored(v);
    if (!o) return null;
    const rec = v as Record<string, unknown>;
    const params = readParams(rec.params);
    const id = typeof rec.booking === 'string' ? rec.booking : '?';
    return outcomeText(o, params, notifiedOf(v), id);
  },
  checkWhere: 'в админке, раздел «Брони»',
};

function storedFrom(result: OwnerStatusResult): StoredOutcome {
  if (result.kind === 'not_found') return { kind: 'booking_refused', reason: 'not_found' };
  if (result.kind === 'bad_transition') return { kind: 'booking_refused', reason: 'bad_transition', from: result.from };
  if (!result.changed) return { kind: 'booking_done', changed: false };
  return { kind: 'booking_done', changed: true, tourist: result.touristNotice ?? 'none' };
}

/** Сообщение оператору — без ПД туриста: номер брони, тур, день, люди и кто подтвердил. */
function operatorNoticeText(bookingId: string, p: BookingParams): string {
  return `Администратор Ведара подтвердил за вас бронь ${bookingLine(bookingId, p.title, p.day, p.people)}. `
    + 'Если это ошибка — напишите менеджеру Ведара.';
}

async function notifyOperator(bookingId: string, p: BookingParams): Promise<Notified> {
  const reach = await reachForPartner(p.operator);
  // reachForPartner уже записал SQLSTATE: «не знаю адреса» — не «адреса нет».
  if (!reach) return 'unknown';
  if (!reach.reachable) {
    console.error('[max/admin-bookings] у оператора нет ни MAX, ни Telegram — о подтверждении брони ему не сообщено');
    return 'none';
  }
  const text = operatorNoticeText(bookingId, p);
  const res = await sendPdAlert({
    text,
    stub: text,
    buttons: [{ text: 'Бронь', url: ownerBookingsUrl(reach.category ?? null, bookingId) }],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max') return 'max';
  if (res.channel === 'telegram-stub') return 'telegram';
  console.error('[max/admin-bookings] сообщение оператору о подтверждении брони не доставлено:', res.reason);
  return 'failed';
}

/** Итог в ту же строку: ровно одна захваченная строка, иначе — в лог. */
async function finish(actionId: string, status: 'done' | 'refused', outcome: Record<string, unknown>): Promise<void> {
  try {
    const upd = await pool.query(
      `UPDATE admin_chat_actions SET status = $2, outcome = $3::jsonb
        WHERE id = $1::uuid AND status = 'running'`,
      [actionId, status, JSON.stringify(outcome)],
    );
    if (upd.rowCount !== 1) console.error(`[max/admin-bookings] итог записан в ${upd.rowCount ?? 0} строк вместо одной`);
  } catch (err) {
    logFail('итог вопроса о брони', err);
  }
}

async function recordNotified(actionId: string, notified: Notified): Promise<void> {
  try {
    await pool.query(
      `UPDATE admin_chat_actions SET outcome = outcome || jsonb_build_object('notified', $2::text)
        WHERE id = $1::uuid AND status = 'done'`,
      [actionId, notified],
    );
  } catch (err) {
    logFail('отметка о сообщении оператору', err);
  }
}

/** «Да» / «Не надо» под вопросом о брони. Права администратора проверил вход (lib/max/admin-actions). */
export async function answerBooking(adminUserId: string, chatId: number, actionId: string, yes: boolean): Promise<AdminActionReply> {
  if (!yes) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE admin_chat_actions SET status = 'cancelled'
          WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
            AND subject_kind = 'booking' AND status = 'ready'`,
        [actionId, adminUserId, String(chatId)],
      );
      if (rowCount === 1) return reply(BOOKING_TEXT.cancelled);
    } catch (err) {
      logFail('«Не надо» под бронью', err);
      return reply(ADMIN_ACTION_TEXT.unchecked);
    }
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, BOOKING_BLOCKED));
  }

  // Захват: одна строка, этого чата и ЭТОГО администратора, готовая и не истёкшая.
  let claimed: { subject_id: string; params: unknown } | undefined;
  try {
    const { rows } = await pool.query<{ subject_id: string; params: unknown }>(
      `UPDATE admin_chat_actions SET status = 'running', used_at = NOW()
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
          AND subject_kind = 'booking' AND status = 'ready' AND expires_at > NOW()
        RETURNING subject_id, params`,
      [actionId, adminUserId, String(chatId)],
    );
    claimed = rows[0];
  } catch (err) {
    logFail('захват «Да» под бронью', err);
    return reply(ADMIN_ACTION_TEXT.unchecked);
  }
  if (!claimed) {
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, BOOKING_BLOCKED));
  }

  const bookingId = claimed.subject_id;
  const params = readParams(claimed.params);
  let stored: StoredOutcome;
  if (!params) {
    console.error('[max/admin-bookings] вопрос о брони без оператора — не исполнен');
    stored = { kind: 'booking_refused', reason: 'error' };
  } else {
    try {
      // Та же дверь, что у кабинета оператора: владелец — оператор тура на
      // момент вопроса. Тур сменил оператора — «не найдено», а не чужая запись.
      stored = storedFrom(await changeOwnerBookingStatus({
        ownerPartnerId: params.operator,
        actorUserId: adminUserId,
        actorKind: 'admin',
        bookingId,
        input: { booking_status: 'confirmed' },
        via: 'max',
      }));
    } catch (err) {
      logFail('подтверждение брони администратором', err);
      stored = { kind: 'booking_refused', reason: 'error' };
    }
  }
  await finish(actionId, stored.kind === 'booking_done' ? 'done' : 'refused', { ...stored, booking: bookingId, params });

  let notified: Notified | null = null;
  if (stored.kind === 'booking_done' && stored.changed && params) {
    notified = await notifyOperator(bookingId, params);
    await recordNotified(actionId, notified);
  }
  return reply(outcomeText(stored, params, notified, bookingId));
}
