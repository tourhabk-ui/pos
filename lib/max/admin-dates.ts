/**
 * Даты за оператора из MAX администратора — фаза 2б. Слово владельца 07.11:
 * «да» на «оператор говорит вам «12.11 есть 6 мест», вы открываете дату в
 * MAX, оператору приходит сообщение, что дату открыли вы».
 *
 * ── Поток ──────────────────────────────────────────────────────────────────
 *
 *   1. Фраза администратора в личном MAX — та же грамматика, что у
 *      оператора (lib/operators/chat-dates/parse): «открой 12 и 14 ноября на
 *      Горелый, 6 мест». Туры — всех туроператоров и гидов со своими турами;
 *      тур называется словами из его названия. Своего разбора здесь нет.
 *   2. Подошёл один тур — сразу вопрос. Несколько (одно название у разных
 *      операторов) — кнопки с туром и оператором: вопрос ждёт выбора
 *      (status 'draft', кандидаты — в params, миграция 1401).
 *   3. Вопрос — превью по каждой дате тем же правилом, что у записи
 *      (`previewTourDates`), и «Да, открыть» / «Не надо». До «Да» ничего не
 *      меняется, вопрос живёт 15 минут, новый вопрос в чате снимает прежний.
 *   4. «Да» — одна транзакция: строка вопроса ЭТОГО администратора и ЭТОГО
 *      чата под FOR UPDATE, запись той же функцией, что у кабинета и чата
 *      оператора (`openTourDatesTx` в режиме чата: закрытое оператором и вне
 *      сезона не открывается, открытые даты не трогаются, мест не меньше
 *      записанных, цена не меняется, тур — под блокировкой гейта брони), итог —
 *      в ту же строку. Отказ базы — откат целиком: вопрос жив, ничего не записано.
 *   5. Открыто хоть что-то — оператору в его MAX или Telegram: «Администратор
 *      Ведара открыл даты на ваш тур …». Исход доставки — в журнал
 *      (`outcome.notified`) и администратору словами: не дошло — «сообщите сами».
 *
 * ── Чего здесь нет ────────────────────────────────────────────────────────
 *
 * Закрыть дату за оператора нельзя: закрытие — решение оператора, и закрытое
 * им («Шторм») открыть снова может только он (решение 22.10). Модели нет:
 * непонятая фраза — отказ разбора с образцом. ПД туриста нет ни в вопросе, ни
 * в журнале, ни в сообщении оператору: тур, оператор, даты, число мест.
 *
 * Права — как у отметки заявки (lib/max/admin-actions): заверенный апдейт,
 * личный диалог, роль администратора на каждом нажатии; чужой вопрос — «не
 * найден». Кнопки-записи подписаны (lib/chat-cabinet/signed-payload).
 *
 * Сторож: tests/integration/max-login-confirm.pg.test.ts — путь целиком на
 * схеме прода и настоящем обработчике бота.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';
import { WRITTEN_RESULTS, openTourDatesTx } from '@/lib/tours/availability-open';
import { type ChatTour, type DatesProposal, chatDatesIntent, parseDatesPhrase } from '@/lib/operators/chat-dates/parse';
import { chatOpenInput, previewDates, readAutoConfirm } from '@/lib/operators/chat-dates/proposals';
import {
  FLOW_TEXT, type StoredOutcome, askText, chooseTourText, datesList, perDateLines, proposalFits, proposalText,
  readStoredOutcome, refusalText, seatsWord, tourButtonText,
} from '@/lib/operators/chat-dates/texts';
import { reachForPartner } from '@/lib/partners/reach';
import { ownerCalendarUrl } from '@/lib/partners/cabinet-links';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import {
  ADMIN_ACTION_TEXT, ADMIN_ACTION_TTL_MIN, type AdminActionReply, type BlockedWords, type StateRow,
  adminActionReply as reply, adminAnswerPayload, adminTourPayload, blockedText, readState,
} from '@/lib/max/admin-actions';

/** Сколько туров читает разбор: больше — названо в логе, а не обрезано молча. */
const TOURS_LIMIT = 500;

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

/** Отказ — в лог: имя проверки и SQLSTATE. Текст ошибки не пишется. */
function logFail(check: string, err: unknown): void {
  console.error(`[max/admin-dates] ${check} — отказ, SQLSTATE ${sqlstate(err)}`);
}

const GEN_MONTH = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Образец фразы на следующий месяц: его дни всегда впереди. */
function example(today: string): string {
  const m = GEN_MONTH[Number(today.slice(5, 7)) % 12]!;
  return `«открой 3 и 5 ${m} на Горелый, 6 мест»`;
}

const ADMIN_DATES_TEXT = {
  closeIntent: 'Закрыть дату за оператора из чата нельзя: закрытие — решение оператора, в его кабинете. Ничего не изменено.',
  toursUnread: 'Не смог прочитать туры — ничего не открыто, попробуйте через минуту.',
  noTours: 'Живых туров нет — открывать даты некуда. Ничего не открыто.',
  nameNeeded: (today: string) =>
    `Назовите тур словами из его названия, например ${example(today)}. Ничего не открыто.`,
  seatsNeeded: (today: string) =>
    `Сколько мест на каждый выезд? Напишите фразу целиком с местами, например ${example(today)}. Ничего не открыто.`,
  hidden: (titles: string[]) => (titles.length === 1
    ? `Тур «${escapeHtml(titles[0]!)}» скрыт — туристы его не видят, и даты ему не открываются. Ничего не открыто.`
    : `Туры ${titles.map((t) => `«${escapeHtml(t)}»`).join(', ')} скрыты — туристы их не видят, и даты им не открываются. `
      + 'Ничего не открыто.'),
  tourGone: 'Тура больше нет или он сменил оператора — ничего не открыто.',
  cancelled: 'Хорошо, даты не открываю.',
  dbFailed: 'Ничего не открыто: база не ответила. Вопрос жив — нажмите «Да» ещё раз через минуту.',
  retireFailed: 'Прежний вопрос снять не смог — его кнопку «Да» не нажимайте.',
  paramsBroken: 'Вопрос не прочитался — ничего не открыто. Напишите фразу ещё раз.',
} as const;

/** Исход сообщения оператору. */
type Notified = 'max' | 'telegram' | 'none' | 'unknown' | 'failed';

const NOTIFIED_TEXT: Record<Notified, string> = {
  max: 'Оператору сообщил в MAX, что даты открыли вы.',
  telegram: 'Оператору сообщил в Telegram, что даты открыли вы.',
  none: 'У оператора не подключён ни MAX, ни Telegram — сообщите ему сами, что даты открыли вы.',
  unknown: 'Не смог прочитать, куда писать оператору, — сообщите ему сами, что даты открыли вы.',
  failed: 'Сообщение оператору не ушло — сообщите ему сами, что даты открыли вы.',
};

// ── Туры ─────────────────────────────────────────────────────────────────────

interface AdminTour {
  id: string;
  title: string;
  active: boolean;
  operatorId: string;
  operatorName: string;
}

/**
 * Туры всех, кто продаёт свои туры: туроператоры и гиды с авторскими турами
 * (их туры — в operator_tours с operator_id карточки гида). Не удалённые;
 * скрытые читаются со своим флагом: фраза, назвавшая скрытый тур, получает
 * «тур скрыт», а не «не нашёл». null — не прочитались.
 */
async function readAdminTours(): Promise<AdminTour[] | null> {
  try {
    const { rows } = await pool.query<{ id: string; title: string; active: boolean; operator_id: string; operator_name: string }>(
      `SELECT t.id::text AS id, t.title, COALESCE(t.is_active, FALSE) AS active,
              p.id::text AS operator_id, p.name AS operator_name
         FROM operator_tours t
         JOIN partners p ON p.id = t.operator_id
        WHERE t.deleted_at IS NULL AND p.category IN ('operator', 'guide')
        ORDER BY t.title, t.id
        LIMIT $1::int`,
      [TOURS_LIMIT],
    );
    if (rows.length >= TOURS_LIMIT) {
      console.error(`[max/admin-dates] туров ${TOURS_LIMIT} и больше — разбор видит первые ${TOURS_LIMIT} по названию`);
    }
    return rows.map((r) => ({
      id: r.id, title: r.title, active: r.active === true, operatorId: r.operator_id, operatorName: r.operator_name,
    }));
  } catch (err) {
    logFail('туры для администратора', err);
    return null;
  }
}

const chatTourOf = (t: AdminTour): ChatTour => ({ id: t.id, title: t.title, active: t.active });

// ── Строка вопроса ───────────────────────────────────────────────────────────

/** Что открыть — в params строки вопроса (1401). Читается с проверкой формы. */
interface DatesParams {
  dates: string[];
  seats: number;
  rule: string | null;
  weekdayWords: boolean;
  priceMentioned: boolean;
  /** Готовый вопрос: оператор тура и вывески — для итога и журнала. */
  operator?: string;
  operatorName?: string;
  tourTitle?: string;
  /** Черновик: кандидаты выбора тура. */
  candidates?: Array<{ tour: string; operator: string; title: string; operatorName: string }>;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BIGINT = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readParams(v: unknown): DatesParams | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const dates = o.dates;
  if (!Array.isArray(dates) || dates.length === 0 || !dates.every((d) => typeof d === 'string' && ISO.test(d))) return null;
  if (typeof o.seats !== 'number' || !Number.isInteger(o.seats) || o.seats < 1) return null;
  const out: DatesParams = {
    dates: dates as string[],
    seats: o.seats,
    rule: typeof o.rule === 'string' ? o.rule : null,
    weekdayWords: o.weekdayWords === true,
    priceMentioned: o.priceMentioned === true,
  };
  if (typeof o.operator === 'string' && UUID.test(o.operator)) out.operator = o.operator;
  if (typeof o.operatorName === 'string') out.operatorName = o.operatorName;
  if (typeof o.tourTitle === 'string') out.tourTitle = o.tourTitle;
  if (Array.isArray(o.candidates)) {
    const c = o.candidates.filter((x): x is { tour: string; operator: string; title: string; operatorName: string } => {
      if (!x || typeof x !== 'object') return false;
      const r = x as Record<string, unknown>;
      return typeof r.tour === 'string' && BIGINT.test(r.tour) && typeof r.operator === 'string' && UUID.test(r.operator)
        && typeof r.title === 'string' && typeof r.operatorName === 'string';
    });
    out.candidates = c;
  }
  return out;
}

/** Живой вопрос чата снимается: ответ на новую фразу без нового вопроса — тоже поправка. */
async function retireLive(adminUserId: string, chatId: number): Promise<number | null> {
  try {
    const r = await pool.query(
      `UPDATE admin_chat_actions SET status = 'superseded'
        WHERE admin_user_id = $1::uuid AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
      [adminUserId, String(chatId)],
    );
    return r.rowCount ?? 0;
  } catch (err) {
    logFail('снятие прежнего вопроса', err);
    return null;
  }
}

async function answerRetiring(adminUserId: string, chatId: number, text: string): Promise<AdminActionReply> {
  const n = await retireLive(adminUserId, chatId);
  return reply(n === null ? `${text}\n${ADMIN_DATES_TEXT.retireFailed}` : text);
}

/** Новый вопрос одной транзакцией: прежний живой вопрос чата снимается, новый вставляется. */
async function insertQuestion(a: {
  adminUserId: string;
  chatId: number;
  status: 'draft' | 'ready';
  tourId: string | null;
  params: DatesParams;
}): Promise<string | null> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `UPDATE admin_chat_actions SET status = 'superseded'
        WHERE admin_user_id = $1::uuid AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
      [a.adminUserId, String(a.chatId)],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO admin_chat_actions
         (admin_user_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at, params)
       VALUES ($1::uuid, 'max', $2::bigint, 'tour', $3, 'open_dates', $4,
               NOW() + make_interval(mins => $5::int), $6::jsonb)
       RETURNING id::text AS id`,
      [a.adminUserId, String(a.chatId), a.tourId, a.status, ADMIN_ACTION_TTL_MIN, JSON.stringify(a.params)],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('новый вопрос о датах', err);
    await client?.query('ROLLBACK').catch((e: unknown) => logFail('откат нового вопроса о датах', e));
    return null;
  } finally {
    client?.release();
  }
}

/** Черновик → готовый вопрос с выбранным туром. `blocked` — уже не черновик или истёк. */
async function readyDraft(
  adminUserId: string, chatId: number, draftId: string, tourId: string, params: DatesParams,
): Promise<'ok' | 'blocked' | 'failed'> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE admin_chat_actions
          SET status = 'ready', subject_id = $4, params = $5::jsonb,
              expires_at = NOW() + make_interval(mins => $6::int)
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
          AND subject_kind = 'tour' AND status = 'draft' AND expires_at > NOW()`,
      [draftId, adminUserId, String(chatId), tourId, JSON.stringify(params), ADMIN_ACTION_TTL_MIN],
    );
    return rowCount === 1 ? 'ok' : 'blocked';
  } catch (err) {
    logFail('выбор тура под вопросом', err);
    return 'failed';
  }
}

// ── Итог ─────────────────────────────────────────────────────────────────────

function notifiedOf(v: unknown): Notified | null {
  const n = v && typeof v === 'object' ? (v as Record<string, unknown>).notified : null;
  return n === 'max' || n === 'telegram' || n === 'none' || n === 'unknown' || n === 'failed' ? n : null;
}

/** Итог «Да» словами: исход по каждой дате и что с сообщением оператору. */
function datesOutcomeText(o: StoredOutcome, operatorName: string | null, notified: Notified | null): string {
  if (o.kind === 'refused') return o.reason === 'tour_inactive' ? ADMIN_DATES_TEXT.hidden([o.title]) : ADMIN_DATES_TEXT.tourGone;
  const who = operatorName ? ` за оператора «${escapeHtml(operatorName)}»` : '';
  const head = o.written > 0
    ? `Готово: даты открыты${who}, «${escapeHtml(o.tourTitle)}», ${seatsWord(o.seats)} на выезд.`
    : `Ничего не открыто: «${escapeHtml(o.tourTitle)}», ${seatsWord(o.seats)} на выезд.`;
  const lines = [head, ...perDateLines(o.perDate, o.seats, 'done', 'admin')];
  if (o.written > 0 && notified) lines.push(NOTIFIED_TEXT[notified]);
  return lines.join('\n');
}

const DATES_BLOCKED: BlockedWords = {
  again: 'напишите фразу ещё раз',
  outcome: (v) => {
    const o = readStoredOutcome(v);
    if (!o) return null;
    const name = v && typeof v === 'object' ? (v as Record<string, unknown>).operatorName : null;
    return datesOutcomeText(o, typeof name === 'string' ? name : null, notifiedOf(v));
  },
  checkWhere: 'в ответе на «даты»',
};

/** Сообщение оператору — без ПД: тур, даты, места и кто открыл. */
function operatorNoticeText(tourTitle: string, dates: string[], seats: number): string {
  return `Администратор Ведара открыл даты на ваш тур «${escapeHtml(tourTitle)}»: ${datesList(dates)} — по ${seatsWord(seats)}. `
    + 'Если это ошибка — закройте дату в календаре кабинета или напишите менеджеру Ведара.';
}

async function notifyOperator(operatorId: string, o: Extract<StoredOutcome, { kind: 'done' }>): Promise<Notified> {
  const reach = await reachForPartner(operatorId);
  // reachForPartner уже записал SQLSTATE: «не знаю адреса» — не «адреса нет».
  if (!reach) return 'unknown';
  if (!reach.reachable) {
    console.error('[max/admin-dates] у оператора нет ни MAX, ни Telegram — о датах, открытых администратором, не сообщено');
    return 'none';
  }
  const written = o.perDate.filter((r) => WRITTEN_RESULTS.has(r.result)).map((r) => r.date);
  const text = operatorNoticeText(o.tourTitle, written, o.seats);
  const res = await sendPdAlert({
    text,
    stub: text,
    buttons: [{ text: 'Календарь', url: ownerCalendarUrl(reach.category ?? null) }],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max') return 'max';
  if (res.channel === 'telegram-stub') return 'telegram';
  console.error('[max/admin-dates] сообщение оператору о датах не доставлено:', res.reason);
  return 'failed';
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

// ── Вопрос ───────────────────────────────────────────────────────────────────

interface Flags {
  priceMentioned: boolean;
  weekdayWords: boolean;
  rule: string | null;
  pastDropped?: string[];
  pastNamed?: string[];
  today: string;
}

/** Превью и вопрос «Открыть за оператора?»: кнопки — только если есть что открыть или превью не прочиталось. */
async function askTour(a: {
  adminUserId: string;
  chatId: number;
  tour: AdminTour;
  params: DatesParams;
  flags: Flags;
  /** Вопрос из черновика выбора тура; null — новая фраза. */
  draftId: string | null;
}): Promise<AdminActionReply> {
  const { adminUserId, chatId, tour, params, flags } = a;
  const input = chatOpenInput(tour.operatorId, tour.id, params.dates, params.seats, flags.today);
  const [preview, autoConfirm] = await Promise.all([previewDates(input), readAutoConfirm(tour.operatorId)]);
  // Ответ без нового вопроса: на новую фразу он снимает прежний вопрос чата
  // (поправка словами), а под черновиком черновик остаётся — тур можно выбрать другой.
  const plain = (text: string): Promise<AdminActionReply> =>
    a.draftId ? Promise.resolve(reply(text)) : answerRetiring(adminUserId, chatId, text);
  if (preview && !preview.ok) {
    return plain(preview.reason === 'tour_inactive' ? ADMIN_DATES_TEXT.hidden([preview.title]) : ADMIN_DATES_TEXT.tourGone);
  }
  const tourTitle = preview?.tour.title ?? tour.title;
  const view = proposalText({
    tourTitle,
    seats: params.seats,
    dates: params.dates,
    perDate: preview?.perDate ?? null,
    facts: preview ? { maxParticipants: preview.tour.maxParticipants, isPublished: preview.tour.isPublished, days: preview.tour.days } : null,
    autoConfirm,
    seller: 'admin',
    operatorName: tour.operatorName,
    ttlMin: ADMIN_ACTION_TTL_MIN,
    priceMentioned: flags.priceMentioned,
    weekdayWords: flags.weekdayWords,
    rule: flags.rule,
    pastDropped: flags.pastDropped,
    pastNamed: flags.pastNamed,
    today: flags.today,
  });
  if (!view.canOpen) return plain(view.text);

  const ready: DatesParams = {
    dates: params.dates, seats: params.seats, rule: params.rule, weekdayWords: params.weekdayWords,
    priceMentioned: params.priceMentioned, operator: tour.operatorId, operatorName: tour.operatorName, tourTitle,
  };
  let id: string;
  if (a.draftId) {
    const r = await readyDraft(adminUserId, chatId, a.draftId, tour.id, ready);
    if (r === 'failed') return reply(ADMIN_ACTION_TEXT.notSaved);
    if (r === 'blocked') {
      const st = await readState(adminUserId, chatId, a.draftId);
      return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, DATES_BLOCKED));
    }
    id = a.draftId;
  } else {
    const created = await insertQuestion({ adminUserId, chatId, status: 'ready', tourId: tour.id, params: ready });
    if (!created) return reply(ADMIN_ACTION_TEXT.notSaved);
    id = created;
  }
  return reply(view.text, [[
    { text: 'Да, открыть', payload: adminAnswerPayload(true, id), intent: 'positive' },
    { text: 'Не надо', payload: adminAnswerPayload(false, id) },
  ]]);
}

async function onProposal(
  adminUserId: string, chatId: number, p: DatesProposal, tours: AdminTour[], nowMs: number,
): Promise<AdminActionReply> {
  const today = kamchatkaDate(new Date(nowMs));
  switch (p.tour.kind) {
    case 'unread': return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.toursUnread);
    case 'no_tours': return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.noTours);
    case 'name_needed': return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.nameNeeded(today));
    case 'hidden': return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.hidden(p.tour.titles));
    case 'choose':
    case 'one':
      break;
  }
  // Список дат под кнопкой не режется: не влезает — «разбейте».
  if (!proposalFits(p.dates, p.rule)) return answerRetiring(adminUserId, chatId, FLOW_TEXT.tooLong(p.dates.length));
  // Без черновика «ждём мест»: фраза приходит целиком, с местами.
  if (p.seats === null) return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.seatsNeeded(today));

  const flags: Flags = {
    priceMentioned: p.priceMentioned, weekdayWords: p.weekdayWords, rule: p.rule,
    pastDropped: p.pastDropped, pastNamed: p.pastNamed, today,
  };
  const base: DatesParams = {
    dates: p.dates, seats: p.seats, rule: p.rule, weekdayWords: p.weekdayWords, priceMentioned: p.priceMentioned,
  };
  if (p.tour.kind === 'choose') {
    const cands = p.tour.ids.map((id) => tours.find((t) => t.id === id)).filter((t): t is AdminTour => t !== undefined);
    if (cands.length === 0) return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.toursUnread);
    const id = await insertQuestion({
      adminUserId, chatId, status: 'draft', tourId: null,
      params: {
        ...base,
        candidates: cands.map((t) => ({ tour: t.id, operator: t.operatorId, title: t.title, operatorName: t.operatorName })),
      },
    });
    if (!id) return reply(ADMIN_ACTION_TEXT.notSaved);
    const labels = cands.map((t) => `${t.title} — ${t.operatorName}`);
    return reply(
      chooseTourText({ dates: p.dates, seats: p.seats, titles: labels, ...flags, hidden: p.tour.hidden }),
      [
        ...labels.map((label, i) => [{ text: tourButtonText(i, label), payload: adminTourPayload(id, i) }]),
        [{ text: 'Не надо', payload: adminAnswerPayload(false, id) }],
      ],
    );
  }
  const tourId = p.tour.id;
  const tour = tours.find((t) => t.id === tourId);
  if (!tour) return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.tourGone);
  return askTour({ adminUserId, chatId, tour, params: base, flags, draftId: null });
}

// ── Входы ────────────────────────────────────────────────────────────────────

/**
 * Текст администратора. null — не фраза про даты: дальше команды
 * администратора («даты», «брони», …) и подсказка. Права проверил вызывающий
 * (роут MAX: заверенный апдейт, личный диалог, роль на этом сообщении).
 */
export async function handleAdminDatesText(opts: {
  adminUserId: string;
  chatId: number;
  text: string;
  nowMs?: number;
}): Promise<AdminActionReply | null> {
  const nowMs = opts.nowMs ?? Date.now();
  if (chatDatesIntent(opts.text, nowMs) !== 'dates') return null;
  const tours = await readAdminTours();
  const parsed = parseDatesPhrase(opts.text, nowMs, tours ? tours.map(chatTourOf) : null);
  if (parsed.kind === 'not_dates') return null;
  const today = kamchatkaDate(new Date(nowMs));
  const { adminUserId, chatId } = opts;
  switch (parsed.kind) {
    case 'close_intent': return answerRetiring(adminUserId, chatId, ADMIN_DATES_TEXT.closeIntent);
    case 'ask': return answerRetiring(adminUserId, chatId, askText(parsed, today, 'admin'));
    case 'refused': return answerRetiring(adminUserId, chatId, refusalText(parsed, today, 'admin'));
    case 'proposal': return onProposal(adminUserId, chatId, parsed, tours ?? [], nowMs);
  }
}

/** Нажатие «N. Тур — оператор» под вопросом: черновик становится вопросом о датах этого тура. */
export async function chooseAdminTour(
  adminUserId: string, chatId: number, actionId: string, index: number, nowMs: number = Date.now(),
): Promise<AdminActionReply> {
  let row: { status: string; params: unknown; expired: boolean } | undefined;
  try {
    const { rows } = await pool.query<{ status: string; params: unknown; expired: boolean }>(
      `SELECT status, params, expires_at <= NOW() AS expired
         FROM admin_chat_actions
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint AND subject_kind = 'tour'`,
      [actionId, adminUserId, String(chatId)],
    );
    row = rows[0];
  } catch (err) {
    logFail('черновик вопроса о датах', err);
    return reply(ADMIN_ACTION_TEXT.unchecked);
  }
  if (!row) return reply(ADMIN_ACTION_TEXT.notFoundAction);
  if (row.status !== 'draft' || row.expired) {
    const st: StateRow | undefined | 'unavailable' = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, DATES_BLOCKED));
  }
  const params = readParams(row.params);
  const cand = params?.candidates?.[index];
  if (!params || !cand) return reply(ADMIN_ACTION_TEXT.unknownButton);
  const today = kamchatkaDate(new Date(nowMs));
  return askTour({
    adminUserId, chatId,
    tour: { id: cand.tour, title: cand.title, active: true, operatorId: cand.operator, operatorName: cand.operatorName },
    params: {
      dates: params.dates, seats: params.seats, rule: params.rule, weekdayWords: params.weekdayWords,
      priceMentioned: params.priceMentioned,
    },
    flags: { priceMentioned: params.priceMentioned, weekdayWords: params.weekdayWords, rule: params.rule, today },
    draftId: actionId,
  });
}

/**
 * «Да» / «Не надо» под вопросом о датах. «Да» — одна транзакция: захват
 * строки, запись дат, итог (шапка, п. 4). Сообщение оператору — после
 * фиксации: открытые даты уже правда, и о них говорится только правда.
 */
export async function answerDates(
  adminUserId: string, chatId: number, actionId: string, yes: boolean, nowMs: number = Date.now(),
): Promise<AdminActionReply> {
  if (!yes) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE admin_chat_actions SET status = 'cancelled'
          WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
            AND subject_kind = 'tour' AND status IN ('draft', 'ready')`,
        [actionId, adminUserId, String(chatId)],
      );
      if (rowCount === 1) return reply(ADMIN_DATES_TEXT.cancelled);
    } catch (err) {
      logFail('«Не надо» под датами', err);
      return reply(ADMIN_ACTION_TEXT.unchecked);
    }
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, DATES_BLOCKED));
  }

  const today = kamchatkaDate(new Date(nowMs));
  let client: PoolClient | null = null;
  let done: { stored: StoredOutcome; params: DatesParams } | null = null;
  let blocked: StateRow | undefined;
  let broken = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<{
      status: string; subject_id: string | null; params: unknown; outcome: unknown; expired: boolean;
    }>(
      `SELECT status, subject_id, params, outcome, expires_at <= NOW() AS expired
         FROM admin_chat_actions
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint AND subject_kind = 'tour'
        FOR UPDATE`,
      [actionId, adminUserId, String(chatId)],
    );
    const row = rows[0];
    const params = row ? readParams(row.params) : null;
    if (!row || row.status !== 'ready' || row.expired) {
      await client.query('ROLLBACK');
      blocked = row ? { status: row.status, outcome: row.outcome, expired: row.expired, stale: false } : undefined;
    } else if (!params || !params.operator || !row.subject_id) {
      await client.query('ROLLBACK');
      console.error('[max/admin-dates] готовый вопрос о датах без оператора или тура — не исполнен');
      broken = true;
    } else {
      const res = await openTourDatesTx(client, chatOpenInput(params.operator, row.subject_id, params.dates, params.seats, today));
      const stored: StoredOutcome = res.ok
        ? { kind: 'done', tourTitle: res.tour.title, seats: params.seats, written: res.written, perDate: res.perDate }
        : res.reason === 'tour_inactive'
          ? { kind: 'refused', reason: 'tour_inactive', title: res.title }
          : { kind: 'refused', reason: 'tour_not_found' };
      const upd = await client.query(
        `UPDATE admin_chat_actions SET status = $2, used_at = NOW(), outcome = $3::jsonb
          WHERE id = $1::uuid AND status = 'ready'`,
        [actionId, stored.kind === 'done' ? 'done' : 'refused', JSON.stringify({ ...stored, operatorName: params.operatorName ?? null })],
      );
      if (upd.rowCount !== 1) throw new Error(`итог вопроса о датах записан в ${upd.rowCount ?? 0} строк вместо одной`);
      await client.query('COMMIT');
      done = { stored, params };
    }
  } catch (err) {
    logFail('«Да» под датами', err);
    await client?.query('ROLLBACK').catch((e: unknown) => logFail('откат «Да» под датами', e));
    return reply(ADMIN_DATES_TEXT.dbFailed);
  } finally {
    client?.release();
  }

  if (broken) return reply(ADMIN_DATES_TEXT.paramsBroken);
  if (!done) return reply(blockedText(blocked, DATES_BLOCKED));
  const { stored, params } = done;
  let notified: Notified | null = null;
  if (stored.kind === 'done' && stored.written > 0 && params.operator) {
    notified = await notifyOperator(params.operator, stored);
    await recordNotified(actionId, notified);
  }
  return reply(datesOutcomeText(stored, params.operatorName ?? null, notified));
}
