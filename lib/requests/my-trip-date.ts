/**
 * lib/requests/my-trip-date.ts — «Изменить дату» под «Моей поездкой»
 * (#2970, шаг 3, слово владельца 11.11).
 *
 * Владелец: тур не открывать — «это можно просто свободную дату»; на
 * нажатие — «зависит от ответа»:
 *   - оператор ещё не ответил по заявке — дата в заявке меняется сразу, а
 *     оператору уходит «турист перенёс на ДД.ММ»;
 *   - оператор уже ответил — дату меняет он: ему уходит просьба перенести на
 *     выбранную свободную дату, заявка не трогается.
 *
 * Только заявка на тур на дату (лид `create_booking_request`, адресованный
 * оператору): у запроса мест (тур без расписания) свободных дат нет по
 * построению, у подбора и машины нет тура с календарём.
 *
 * Право — та же связь, что у «Написать оператору»: заявка привязана к ЭТОМУ
 * чату (`chat_request_links`, 1416) живым ключом НОВОЙ заявки (`opens_chat`).
 * Ключ повтора получил бы любой, кто знает чужой телефон, тур и дату, — он
 * видит статус, но дату не меняет.
 *
 * «Ответил» — тем же правилом, что «Входящие» оператора
 * (lib/crm/inbox-sql): статус заявки вышел из ожидания, ответ кнопкой
 * (`partner_incoming_answers`), сообщение адресата в переписке
 * (`request_messages`), бронь по заявке. Смена даты — один условный UPDATE с
 * теми же условиями: ответ, пришедший между чтением и записью, превращает
 * смену в просьбу, а не затирает его.
 *
 * Дата — только свободная по календарю тура на число людей заявки
 * (`loadFreeDates`, то же правило, что ближайшая свободная дата), и
 * проверяется ещё раз при нажатии. Не больше трёх смен и просьб за сутки:
 * перебор дат не превращается в поток сообщений оператору.
 *
 * ПД нет ни в ответе туристу, ни оператору: тур, даты, число людей.
 *
 * Ядро и двери (12.11): само правило — `changeLeadDateByClient`, одно на чат
 * «Моей поездки» и на инструмент change_request для ИИ-агента (lib/mcp/
 * change-request). Дверь проверяет право («чья заявка») и говорит исход
 * своими словами; правило «ответил — просьба, не ответил — сразу», лимит и
 * сообщение оператору у дверей общие.
 */
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { escapeHtml } from '@/lib/text/escape-html';
import { getPublicBaseUrl } from '@/lib/config';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { LEAD_WAITING_STATUSES } from '@/lib/leads/owner-lead-words';
import { loadFreeDates } from '@/lib/tours/nearest-free-date';
import { parseMyTripDate, myTripDatePickPayload, myTripDateMenuPayload, MY_TRIP_CLOSED_BOOKING } from '@/lib/requests/my-trip-ask';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import type { LinkChannel } from '@/lib/requests/chat-links';
import type { ChatReply } from '@/lib/requests/request-chat-service';
import { notifyRequestOperator, operatorTold, type OperatorNotice } from '@/lib/requests/notify-request-operator';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';
import { DATE_CHANGE_DAILY_LIMIT } from '@/lib/requests/date-change-limit';

export { isMyTripDatePayload, myTripDateMenuPayload, myTripDatePickPayload, parseMyTripDate } from '@/lib/requests/my-trip-ask';

/** Сколько свободных дат показываем кнопками. */
export const MY_TRIP_DATE_CHOICES = 6;
/** Смен даты и просьб о переносе по одной заявке за сутки — одно число на чат и на change_request. */
export const MY_TRIP_DATE_DAILY_LIMIT = DATE_CHANGE_DAILY_LIMIT;

const WAITING_SQL = `(${LEAD_WAITING_STATUSES.map((s) => `'${s}'`).join(', ')})`;

/**
 * Ответил ли оператор — одно выражение на чтение и на условие записи.
 *
 * «Нет мест» дату за оператором не закрепляет (план «после отказа», этап 2а,
 * 1422): он сказал, что на ЭТУ дату мест нет, — и человек вправе сам выбрать
 * свободную. До 1422 любой ответ кнопкой запирал смену даты, и после «Нет
 * мест» оставалась только просьба тому, кто уже отказал. Ответ кнопкой
 * считается только того, кто сейчас адресат: после передачи большой группы
 * ответ прежнего о заявке ничего не говорит.
 */
export const ANSWERED_SQL = `(
  l.status NOT IN ${WAITING_SQL}
  OR EXISTS (SELECT 1 FROM operator_bookings ob_a WHERE ob_a.lead_id = l.id AND ob_a.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM partner_incoming_answers pa_a
              WHERE pa_a.subject_kind = 'lead' AND pa_a.subject_id = l.id::text
                AND pa_a.partner_id = l.operator_id AND pa_a.answer <> 'no_seats')
  OR EXISTS (SELECT 1 FROM request_messages rm_a WHERE rm_a.lead_id = l.id AND rm_a.author = 'owner')
)`;

/** Даты, на которые адресат ответил «Нет мест» (1422): их не предлагаем и не ставим. */
const REFUSED_DATES_SQL = `ARRAY(
  SELECT pa_r.subject_date FROM partner_incoming_answers pa_r
   WHERE pa_r.subject_kind = 'lead' AND pa_r.subject_id = l.id::text
     AND pa_r.partner_id = l.operator_id AND pa_r.answer = 'no_seats'
     AND pa_r.subject_date IS NOT NULL
   ORDER BY pa_r.subject_date)`;

/**
 * Смен даты и просьб о переносе по заявке `l` за сутки — счёт для лимита.
 * Одно выражение на меню, выбор и кнопки дат в сообщении после ответа
 * оператора (answer-notice): иначе сообщение обещало бы «сразу встанет», а
 * нажатие отвечало «уже меняли».
 */
export const MY_TRIP_DATE_ACTIONS_SQL = `(SELECT count(*)::int FROM lead_activity_log g
           WHERE g.lead_id = l.id AND g.action IN ('date_changed', 'date_change_requested')
             AND g.created_at > NOW() - INTERVAL '24 hours')`;

/** Колонки заявки для смены даты — одни на каждую дверь; псевдоним лида — `l`. */
export const DATE_LEAD_COLUMNS_SQL = `
  l.id::text AS id, l.status, l.operator_id::text AS operator_id,
  l.source_data->>'date' AS date,
  CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END AS tour_id,
  CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,3}$' THEN (l.source_data->>'participants')::int END AS participants,
  ot.title AS tour_title,
  bk.booking_status, bk.booking_date::text AS booking_date,
  ${ANSWERED_SQL} AS answered,
  ${REFUSED_DATES_SQL} AS refused_dates,
  ${MY_TRIP_DATE_ACTIONS_SQL} AS date_actions`;

export const DATE_LEAD_JOINS_SQL = `
  LEFT JOIN operator_tours ot
         ON ot.id = CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END
  LEFT JOIN LATERAL (
    SELECT b.booking_status, b.booking_date FROM operator_bookings b
     WHERE b.lead_id = l.id AND b.deleted_at IS NULL
     ORDER BY b.created_at DESC
     LIMIT 1
  ) bk ON TRUE`;

/**
 * Заявка на тур, привязанная к этому чату ключом новой заявки. `$1` — канал,
 * `$2` — чат, `$3` — лид. Нет строки — заявка не этого чата (или ключ истёк,
 * или это не заявка на тур на дату).
 */
export const MY_TRIP_DATE_LEAD_SQL = `
  SELECT ${DATE_LEAD_COLUMNS_SQL}
    FROM leads l
    ${DATE_LEAD_JOINS_SQL}
   WHERE l.id = $3::uuid
     AND l.operator_id IS NOT NULL AND l.is_self = FALSE
     AND EXISTS (
       SELECT 1 FROM chat_request_links c
         JOIN agent_request_keys k ON k.id = c.key_id
        WHERE c.channel = $1 AND c.chat_id = $2
          AND k.lead_id = l.id AND k.expires_at > NOW()
          AND k.opens_chat AND k.tool_name = 'create_booking_request')`;

/**
 * Смена даты, пока оператор не ответил: дата в заявке (`source_data.date` —
 * её читают статус, обстановка и напоминание) и в строке для оператора
 * (`comment`, «…дата ГГГГ-ММ-ДД, участников N.»; по этой строке узнаётся и
 * повтор заявки) — и запись в журнал заявки, одним оператором. `$1` — лид,
 * `$2` — новая дата, `$3` — прежняя, `$4` — канал. Нет строки — оператор
 * уже ответил или дату сменили в другом окне.
 */
export const MY_TRIP_DATE_CHANGE_SQL = `
  WITH u AS (
    UPDATE leads l
       SET source_data = jsonb_set(l.source_data, '{date}', to_jsonb($2::text)),
           comment = regexp_replace(l.comment, 'дата [0-9]{4}-[0-9]{2}-[0-9]{2},', 'дата ' || $2::text || ',')
     WHERE l.id = $1::uuid
       AND l.source_data->>'date' = $3::text
       AND NOT ${ANSWERED_SQL}
    RETURNING l.id
  )
  INSERT INTO lead_activity_log (lead_id, actor, action, details)
  SELECT u.id, 'tourist', 'date_changed', jsonb_build_object('from', $3::text, 'to', $2::text, 'channel', $4::text)
    FROM u
  RETURNING id::text AS log_id`;

/** Чем кончилось сообщение оператору — в ту же запись журнала. */
export const MY_TRIP_DATE_DELIVERY_SQL = `
  UPDATE lead_activity_log SET details = details || jsonb_build_object('delivery', $2::text)
   WHERE id = $1::bigint`;

/**
 * Просьба оператору перенести — запись журнала ДО сообщения и только пока
 * лимит за сутки не исчерпан: условие стоит в самом запросе. Нет строки —
 * лимит выбрали между чтением и записью, сообщение оператору не уходит. До
 * 12.11 запись шла после отправки: вызовы, пришедшие разом, проходили проверку
 * лимита все и слали оператору по сообщению каждый — кнопке в чате это почти
 * не грозило, ИИ-агенту (change_request) грозит. Исход доставки дописывает
 * `MY_TRIP_DATE_DELIVERY_SQL`.
 */
export const MY_TRIP_DATE_REQUEST_LOG_SQL = `
  INSERT INTO lead_activity_log (lead_id, actor, action, details)
  SELECT l.id, 'tourist', 'date_change_requested',
         jsonb_build_object('from', $2::text, 'to', $3::text, 'channel', $4::text)
    FROM leads l
   WHERE l.id = $1::uuid
     AND ${MY_TRIP_DATE_ACTIONS_SQL} < ${MY_TRIP_DATE_DAILY_LIMIT}
  RETURNING id::text AS log_id`;

export interface DateLeadRow {
  id: string;
  status: string | null;
  operator_id: string;
  date: string | null;
  tour_id: string | number | null;
  participants: number | null;
  tour_title: string | null;
  booking_status: string | null;
  /** Дата брони по заявке: оператор мог завести бронь на другой день, чем просили. */
  booking_date: string | null;
  answered: boolean;
  /** Даты, на которые адресат ответил «Нет мест» (1422). */
  refused_dates: string[] | null;
  date_actions: number;
}

export type { OperatorNotice } from '@/lib/requests/notify-request-operator';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const TEXT = {
  unknownButton: 'Кнопка не распознана — ничего не изменено. Откройте «Моя поездка» заново.',
  notYours: 'Эта заявка не подключена к этому чату — дату здесь не меняю. Откройте «Моя поездка» и выберите заявку из списка.',
  unchecked: 'Не удалось проверить заявку — это сбой на нашей стороне. Ничего не изменено, повторите через минуту.',
  closed: 'Заявка закрыта — дату по ней не меняю. Новую поездку можно подобрать здесь же, в чате.',
  noData: 'В заявке не записаны тур или дата — сменить дату кнопкой нельзя. Напишите оператору: дату он поменяет сам.',
  datesFailed: 'Свободные даты тура сейчас не прочитались — это сбой, а не «дат нет». Ничего не изменено, повторите через минуту.',
  past: 'Поездка по заявке уже прошла — дату по ней не меняю. Новую поездку можно подобрать здесь же, в чате.',
  limit: `Дату по этой заявке за сутки уже меняли ${MY_TRIP_DATE_DAILY_LIMIT} раза — дальше договоритесь с оператором напрямую: он видит заявку и вашу последнюю дату.`,
} as const;

function ruDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}`;
}

const reply = (text: string, buttons: ChatReply['buttons'] = []): ChatReply => ({ text, buttons });

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[my-trip-date] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
    logText(err instanceof Error ? err.message : err, 160),
  );
}

async function readLead(channel: LinkChannel, chatId: string | number, leadId: string): Promise<DateLeadRow | null | 'failed'> {
  try {
    const { rows: [row] } = await pool.query<DateLeadRow>(MY_TRIP_DATE_LEAD_SQL, [channel, String(chatId), leadId]);
    return row ?? null;
  } catch (err) {
    logFail('заявка не прочиталась', err);
    return 'failed';
  }
}

/** `date` — действующая дата поездки; смена без оператора возможна только без брони, и тогда это дата заявки. */
type Usable = { lead: DateLeadRow; tourId: number; date: string; people: number; title: string };

/** Поля заявки, по которым решается, можно ли сменить дату нажатием. */
export type DateGate = Pick<DateLeadRow, 'status' | 'booking_status' | 'booking_date' | 'date' | 'tour_id' | 'date_actions'>;

/** Почему нажатие даты не пройдёт — или null. Одно правило на меню, выбор и кнопки в сообщении. */
type DateBlock = 'closed' | 'noData' | 'past';

function dateBlock(lead: DateGate, today: string): DateBlock | null {
  // Отказ, отмена клиентом (1427) и закрытая бронь — заявка закрыта: старая кнопка
  // «Изменить дату» под прежним сообщением просьбу оператору по ней не отправит.
  if (lead.status === 'lost' || lead.status === LEAD_CLIENT_CANCELLED
    || (lead.booking_status !== null && MY_TRIP_CLOSED_BOOKING.has(lead.booking_status))) return 'closed';
  const tourId = lead.tour_id === null ? NaN : Number(lead.tour_id);
  // Действующая дата: у брони — её день, без брони — та, что в заявке.
  const date = lead.booking_date ?? lead.date;
  if (!Number.isFinite(tourId) || !date || !ISO_DAY.test(date)) return 'noData';
  if (date < today) return 'past';
  return null;
}

/**
 * Пройдёт ли нажатие даты по этой заявке: не закрыта, поездка впереди, лимит
 * смен за сутки не исчерпан. Сообщение после ответа оператора (answer-notice)
 * даёт кнопки дат только при true — иначе обещание «сразу встанет в заявку»
 * нажатие не сдержало бы (ревью 2б: «Поездка по заявке уже прошла»).
 */
export function myTripDatePressable(lead: DateGate, today: string): boolean {
  return dateBlock(lead, today) === null && Number(lead.date_actions) < MY_TRIP_DATE_DAILY_LIMIT;
}

/**
 * Отказ словами или заявка, у которой можно сменить дату. Прошедшая поездка
 * (день по Камчатке раньше сегодняшнего) — отказ: кнопка меню не подписана и
 * не истекает, поэтому условие «поездка впереди» проверяется здесь, а не
 * только под списком (Bugbot к #3234: иначе прошедшую заявку молча
 * переносили и оператору уходил «перенос»).
 */
function usable(lead: DateLeadRow, today: string): Usable | DateBlock {
  const block = dateBlock(lead, today);
  if (block) return block;
  const date = (lead.booking_date ?? lead.date)!;
  return {
    lead,
    tourId: Number(lead.tour_id),
    date,
    people: lead.participants && lead.participants > 0 ? lead.participants : 1,
    title: lead.tour_title ?? 'тур заявки',
  };
}

const isBlock = (x: Usable | DateBlock): x is DateBlock => typeof x === 'string';

const refusedOf = (lead: DateLeadRow): string[] => (lead.refused_dates ?? []).filter((d) => ISO_DAY.test(d));

/** Что будет по нажатию — одной строкой над датами. */
function ruleLine(answered: boolean, refusedOn: string | null): string {
  if (answered) return 'Оператор уже ответил по заявке, поэтому дату меняет он: выберите дату — ему уйдёт ваша просьба перенести.';
  return refusedOn
    ? `Оператор ответил «Нет мест» на ${ruDate(refusedOn)} — выбранная дата сразу встанет в заявку, и оператор получит её с кнопками ответа.`
    : 'Оператор ещё не ответил — выбранная дата сразу встанет в заявку, а оператору уйдёт сообщение о переносе.';
}

/** «Изменить дату»: свободные даты тура кнопками. Только чтение. */
async function menu(channel: LinkChannel, chatId: string | number, leadId: string, today: string): Promise<ChatReply> {
  const lead = await readLead(channel, chatId, leadId);
  if (lead === 'failed') return reply(TEXT.unchecked);
  if (lead === null) return reply(TEXT.notYours);
  const u = usable(lead, today);
  if (isBlock(u)) return reply(TEXT[u]);
  if (u.lead.date_actions >= MY_TRIP_DATE_DAILY_LIMIT) return reply(TEXT.limit);
  const head = `Тур «${escapeHtml(u.title)}», в заявке ${ruDate(u.date)}, участников ${u.people}.`;
  // Даты, на которые оператор уже ответил «Нет мест», не предлагаются: по
  // календарю они могут быть свободны, но ответ оператора — правда о них.
  const refused = refusedOf(u.lead);
  const free = await loadFreeDates(u.tourId, u.people, MY_TRIP_DATE_CHOICES + 1 + refused.length);
  if (free.state === 'failed') return reply(TEXT.datesFailed);
  if (!free.hasCalendar) {
    return reply(`${head}\nРасписания у тура в системе нет — свободных дат показать не могу. Новую дату согласуйте с оператором: он подтверждает её сам.`);
  }
  const dates = free.dates.filter((d) => d.date !== u.date && !refused.includes(d.date)).slice(0, MY_TRIP_DATE_CHOICES);
  if (dates.length === 0) {
    return reply(`${head}\nДругих свободных дат на ${u.people} чел. в календаре тура на год вперёд нет. Можно спросить оператора — он видит заявку.`);
  }
  return reply(
    [head, `Свободные даты на ${u.people} чел.:`, ruleLine(u.lead.answered, refused.includes(u.date) ? u.date : null)].join('\n'),
    dates.map((d) => ({ text: `${shortDate(d.date)} · мест ${d.free}`, payload: signPayload(myTripDatePickPayload(leadId, d.date)) })),
  );
}

/** Откуда пришла смена даты — в журнал заявки: чат человека или ИИ-агент по ключу заявки. */
export type DateChannel = LinkChannel | 'mcp' | 'a2a';

const viaAgent = (channel: DateChannel): boolean => channel === 'mcp' || channel === 'a2a';

/** Оператору: перенос или просьбу передал не сам человек в чате, а его ИИ-агент. */
const AGENT_LINE = 'Передал ИИ-агент туриста по ключу заявки.';

/**
 * Сообщение оператору без ПД: тур, даты, люди, места на новую дату.
 * `refusedOn` — перенос после его «Нет мест» на прежнюю дату (1422): тогда
 * так и сказано, и ответить по новой дате он может кнопками под сообщением.
 * `agent` — действие передал ИИ-агент по ключу заявки: оператору это названо.
 */
export function operatorDateText(
  kind: 'changed' | 'request',
  u: { title: string; from: string; to: string; people: number; free: number; refusedOn?: string | null; agent?: boolean },
  /** Под сообщением есть кнопки ответа — только тогда текст зовёт к ним. */
  withButtons = true,
): string {
  const tour = `Тур «${escapeHtml(u.title)}», участников ${u.people}`;
  const seats = `По календарю на ${ruDate(u.to)} свободно мест: ${u.free}.`;
  const agent = u.agent ? [AGENT_LINE] : [];
  if (kind === 'changed' && u.refusedOn) {
    return [
      '<b>Турист перенёс заявку после вашего «Нет мест»</b>',
      `${tour}: на ${ruDate(u.refusedOn)} вы ответили «Нет мест», турист выбрал ${ruDate(u.to)} из свободных по календарю.`,
      seats,
      ...agent,
      withButtons ? 'Ответьте по новой дате кнопками ниже или в кабинете.' : 'Ответьте по новой дате в кабинете.',
    ].join('\n');
  }
  return kind === 'changed'
    ? [
      '<b>Турист перенёс заявку на другую дату</b>',
      `${tour}: было ${ruDate(u.from)}, стало ${ruDate(u.to)}.`,
      seats,
      ...agent,
      'Дату турист выбрал сам из свободных: пока вы не ответили, она меняется без вас. Ответ по заявке — как обычно.',
    ].join('\n')
    : [
      '<b>Турист просит перенести заявку</b>',
      `${tour}: сейчас ${ruDate(u.from)}, просит ${ruDate(u.to)}.`,
      seats,
      ...agent,
      'Вы уже ответили по заявке, поэтому дату в ней и в брони меняете вы. Туристу ответьте в переписке по заявке или звонком.',
    ].join('\n');
}

/** Оператору — лично, в его MAX или Telegram: общий путь с «Отменить заявку» (lib/requests/notify-request-operator). */
function notifyOperator(
  operatorId: string, leadId: string, text: (withButtons: boolean) => string, answer = false,
): Promise<OperatorNotice> {
  return notifyRequestOperator({ operatorId, leadId, text, answer, log: { tag: 'my-trip-date', about: 'о дате' } });
}

/** Чем кончилась попытка сменить дату — одно на каждую дверь; слова — у двери. */
export type DateOutcome =
  /** Заявка закрыта, в ней нет тура или даты, поездка прошла. */
  | { kind: 'closed' | 'noData' | 'past' }
  /** Эта дата уже стоит в заявке. */
  | { kind: 'same'; date: string }
  /** На эту дату адресат уже ответил «Нет мест». */
  | { kind: 'refusedDate'; date: string }
  /** Смен и просьб за сутки уже `MY_TRIP_DATE_DAILY_LIMIT`. */
  | { kind: 'limit' }
  /** На дату нет мест на число людей заявки; `hasCalendar` — есть ли у тура расписание вовсе. */
  | { kind: 'noSeats'; date: string; people: number; hasCalendar: boolean }
  /** Дата в заявке изменена; `told` — узнал ли оператор. */
  | { kind: 'changed'; title: string; from: string; date: string; told: OperatorNotice }
  /** Оператор уже ответил: ему ушла просьба (или не дошла — `told`); в заявке прежняя дата `current`. */
  | { kind: 'requested'; date: string; current: string; told: OperatorNotice }
  /** Дату только что сменили другим нажатием или вызовом. */
  | { kind: 'changedElsewhere' }
  /** Заявка перестала читаться этой дверью (ключ истёк, связь снята). */
  | { kind: 'gone' }
  /** Свободные даты не прочитались — сбой, не «дат нет». */
  | { kind: 'datesFailed' }
  /** Сбой базы: ничего не изменено. */
  | { kind: 'failed' };

/** Проверки пройдены: заявку можно менять на эту дату, мест хватает. */
type DateReady = { u: Usable; slot: { date: string; free: number } };

const isReady = (x: DateOutcome | DateReady): x is DateReady => 'slot' in x;

/**
 * Всё, что решается до записи: заявка открыта, дата другая и не отказанная,
 * лимит не выбран, места на дату есть СЕЙЧАС (между списком и нажатием их
 * могли разобрать). Одно на смену и на пробу — иначе проба обещала бы то, что
 * вызов не сделает.
 */
async function checkDateChange(lead: DateLeadRow, date: string, today: string): Promise<DateOutcome | DateReady> {
  const u = usable(lead, today);
  if (isBlock(u)) return { kind: u };
  if (date === u.date) return { kind: 'same', date };
  if (refusedOf(u.lead).includes(date)) return { kind: 'refusedDate', date };
  if (u.lead.date_actions >= MY_TRIP_DATE_DAILY_LIMIT) return { kind: 'limit' };
  const free = await loadFreeDates(u.tourId, u.people, 1, date);
  if (free.state === 'failed') return { kind: 'datesFailed' };
  const slot = free.dates[0];
  if (!slot) return { kind: 'noSeats', date, people: u.people, hasCalendar: free.hasCalendar };
  return { u, slot };
}

/** Что сделал бы вызов: сменил бы дату сразу или отправил просьбу оператору. Только чтение. */
export type DatePreview = DateOutcome | { kind: 'wouldChange' | 'wouldRequest'; date: string; current: string };

export async function previewLeadDateChange(args: { lead: DateLeadRow; date: string; today: string }): Promise<DatePreview> {
  const ready = await checkDateChange(args.lead, args.date, args.today);
  if (!isReady(ready)) return ready;
  return { kind: ready.u.lead.answered ? 'wouldRequest' : 'wouldChange', date: args.date, current: ready.u.date };
}

/**
 * Сменить дату заявки или попросить об этом оператора. `lead` — уже прочитанная
 * дверью заявка (право проверено там, адресат у неё есть); `reread` — её же
 * чтение ещё раз: запись не прошла — правду о заявке надо узнать, а не угадать.
 */
export async function changeLeadDateByClient(args: {
  lead: DateLeadRow;
  date: string;
  channel: DateChannel;
  today: string;
  reread: () => Promise<DateLeadRow | null | 'failed'>;
}): Promise<DateOutcome> {
  const { date, channel, today } = args;
  const ready = await checkDateChange(args.lead, date, today);
  if (!isReady(ready)) return ready;
  let { u } = ready;
  const { slot } = ready;
  const leadId = u.lead.id;
  const factsOf = (cur: Usable) => ({
    title: cur.title, from: cur.date, to: date, people: cur.people, free: slot.free,
    refusedOn: refusedOf(cur.lead).includes(cur.date) ? cur.date : null,
    agent: viaAgent(channel),
  });

  if (!u.lead.answered) {
    let logId: string | null = null;
    try {
      const { rows: [row] } = await pool.query<{ log_id: string }>(MY_TRIP_DATE_CHANGE_SQL, [leadId, date, u.date, channel]);
      logId = row?.log_id ?? null;
    } catch (err) {
      logFail('дата заявки не записана', err);
      return { kind: 'failed' };
    }
    if (logId !== null) {
      const changedFacts = factsOf(u);
      const notice = await notifyOperator(u.lead.operator_id, leadId, (b) => operatorDateText('changed', changedFacts, b), true);
      try {
        await pool.query(MY_TRIP_DATE_DELIVERY_SQL, [logId, notice]);
      } catch (err) {
        logFail('исход сообщения оператору не записан', err);
      }
      return { kind: 'changed', title: u.title, from: u.date, date, told: notice };
    }
    // Строки нет: оператор ответил между чтением и записью — или дату уже
    // сменило второе нажатие той же кнопки. Перечитываем, чтобы сказать
    // правду: «оператор ответил» туристу, у которого он не отвечал, — ложь.
    const reread = await args.reread();
    if (reread === 'failed') return { kind: 'failed' };
    if (reread === null) return { kind: 'gone' };
    const again = usable(reread, today);
    if (isBlock(again)) return { kind: again };
    if (!again.lead.answered) return again.date === date ? { kind: 'same', date } : { kind: 'changedElsewhere' };
    u = again;
  }

  // Просьба: сначала запись журнала (с лимитом в самом запросе), потом сообщение.
  let logId: string | null = null;
  try {
    const { rows: [row] } = await pool.query<{ log_id: string }>(MY_TRIP_DATE_REQUEST_LOG_SQL, [leadId, u.date, date, channel]);
    logId = row?.log_id ?? null;
  } catch (err) {
    logFail('просьба о переносе не записана в журнал', err);
    return { kind: 'failed' };
  }
  if (logId === null) return { kind: 'limit' };
  const requested = operatorDateText('request', factsOf(u));
  const notice = await notifyOperator(u.lead.operator_id, leadId, () => requested);
  try {
    await pool.query(MY_TRIP_DATE_DELIVERY_SQL, [logId, notice]);
  } catch (err) {
    logFail('исход просьбы о переносе не записан', err);
  }
  return { kind: 'requested', date, current: u.date, told: notice };
}

const NOT_TOLD = 'Сообщить оператору сейчас не удалось — у него не подключён чат или он не ответил. Заявку он видит в кабинете';

const again = (leadId: string): ChatReply['buttons'] => [{ text: 'Изменить дату', payload: myTripDateMenuPayload(leadId) }];

/** Исход смены даты — словами человеку в чате. */
function dateReply(o: DateOutcome, leadId: string): ChatReply {
  switch (o.kind) {
    case 'closed':
    case 'noData':
    case 'past':
    case 'limit':
    case 'datesFailed':
      return reply(TEXT[o.kind]);
    case 'failed': return reply(TEXT.unchecked);
    case 'gone': return reply(TEXT.notYours);
    case 'same': return reply(`${ruDate(o.date)} уже стоит в заявке — ничего не изменено.`);
    case 'refusedDate':
      return reply(`На ${ruDate(o.date)} оператор уже ответил «Нет мест» — выберите другую дату.`, again(leadId));
    case 'noSeats':
      return reply(`На ${ruDate(o.date)} мест на ${o.people} чел. уже нет — ничего не изменено. Откройте «Изменить дату» заново.`, again(leadId));
    case 'changedElsewhere':
      return reply('Дату по заявке только что изменили в другом окне — ничего не изменено. Откройте «Изменить дату» заново.');
    case 'changed': {
      const told = operatorTold(o.told) ? 'Оператору ушло сообщение о переносе.' : `${NOT_TOLD}, уже с новой датой.`;
      return reply(`Дата в заявке изменена: тур «${escapeHtml(o.title)}», теперь ${ruDate(o.date)}. ${told} Заявку по-прежнему подтверждает оператор.`);
    }
    case 'requested':
      return operatorTold(o.told)
        ? reply(`Оператор уже ответил по заявке, поэтому дату меняет он: просьба перенести на ${ruDate(o.date)} ему отправлена. В заявке пока прежняя дата — ${ruDate(o.current)}.`)
        : reply(`Оператор уже ответил по заявке, поэтому дату меняет он. ${NOT_TOLD}, но о просьбе не знает — напишите ему или позвоните. В заявке прежняя дата — ${ruDate(o.current)}.`);
  }
}

/** Нажатие на дату: смена сразу или просьба оператору. */
async function pick(channel: LinkChannel, chatId: string | number, leadId: string, date: string, today: string): Promise<ChatReply> {
  const lead = await readLead(channel, chatId, leadId);
  if (lead === 'failed') return reply(TEXT.unchecked);
  if (lead === null) return reply(TEXT.notYours);
  const outcome = await changeLeadDateByClient({
    lead, date, channel, today, reread: () => readLead(channel, chatId, leadId),
  });
  return dateReply(outcome, leadId);
}

/**
 * Нажатие «Изменить дату» или даты под «Моей поездкой» — MAX и Telegram.
 * Канал и чат — того апдейта, в котором нажали (личный диалог).
 */
export async function pressMyTripDate(
  payload: string, channel: LinkChannel, chatId: string | number, opts: { now?: number } = {},
): Promise<ChatReply> {
  const p = parseMyTripDate(payload);
  if (!p) return reply(TEXT.unknownButton);
  const today = kamchatkaToday(opts.now);
  return p.kind === 'menu' ? menu(channel, chatId, p.leadId, today) : pick(channel, chatId, p.leadId, p.date, today);
}
