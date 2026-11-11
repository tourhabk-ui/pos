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
 */
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { escapeHtml } from '@/lib/text/escape-html';
import { getPublicBaseUrl } from '@/lib/config';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { LEAD_WAITING_STATUSES } from '@/lib/leads/owner-lead-words';
import { loadFreeDates } from '@/lib/tours/nearest-free-date';
import { parseMyTripDate, myTripDatePickPayload, myTripDateMenuPayload } from '@/lib/requests/my-trip-ask';
import type { LinkChannel } from '@/lib/requests/chat-links';
import type { ChatReply } from '@/lib/requests/request-chat-service';

export { isMyTripDatePayload, myTripDateMenuPayload, myTripDatePickPayload, parseMyTripDate } from '@/lib/requests/my-trip-ask';

/** Сколько свободных дат показываем кнопками. */
export const MY_TRIP_DATE_CHOICES = 6;
/** Смен даты и просьб о переносе по одной заявке за сутки. */
export const MY_TRIP_DATE_DAILY_LIMIT = 3;

const WAITING_SQL = `(${LEAD_WAITING_STATUSES.map((s) => `'${s}'`).join(', ')})`;

/** Ответил ли оператор — одно выражение на чтение и на условие записи. */
const ANSWERED_SQL = `(
  l.status NOT IN ${WAITING_SQL}
  OR EXISTS (SELECT 1 FROM operator_bookings ob_a WHERE ob_a.lead_id = l.id AND ob_a.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM partner_incoming_answers pa_a WHERE pa_a.subject_kind = 'lead' AND pa_a.subject_id = l.id::text)
  OR EXISTS (SELECT 1 FROM request_messages rm_a WHERE rm_a.lead_id = l.id AND rm_a.author = 'owner')
)`;

/**
 * Заявка на тур, привязанная к этому чату ключом новой заявки. `$1` — канал,
 * `$2` — чат, `$3` — лид. Нет строки — заявка не этого чата (или ключ истёк,
 * или это не заявка на тур на дату).
 */
export const MY_TRIP_DATE_LEAD_SQL = `
  SELECT l.id::text AS id, l.status, l.operator_id::text AS operator_id,
         l.source_data->>'date' AS date,
         CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END AS tour_id,
         CASE WHEN l.source_data->>'participants' ~ '^[0-9]{1,3}$' THEN (l.source_data->>'participants')::int END AS participants,
         ot.title AS tour_title,
         bk.booking_status, bk.booking_date::text AS booking_date,
         ${ANSWERED_SQL} AS answered,
         (SELECT count(*)::int FROM lead_activity_log g
           WHERE g.lead_id = l.id AND g.action IN ('date_changed', 'date_change_requested')
             AND g.created_at > NOW() - INTERVAL '24 hours') AS date_actions
    FROM leads l
    LEFT JOIN operator_tours ot
           ON ot.id = CASE WHEN l.source_data->>'tour_id' ~ '^[0-9]{1,18}$' THEN (l.source_data->>'tour_id')::bigint END
    LEFT JOIN LATERAL (
      SELECT b.booking_status, b.booking_date FROM operator_bookings b
       WHERE b.lead_id = l.id AND b.deleted_at IS NULL
       ORDER BY b.created_at DESC
       LIMIT 1
    ) bk ON TRUE
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

/** Просьба оператору перенести — запись журнала с исходом доставки. */
export const MY_TRIP_DATE_REQUEST_LOG_SQL = `
  INSERT INTO lead_activity_log (lead_id, actor, action, details)
  VALUES ($1::uuid, 'tourist', 'date_change_requested',
          jsonb_build_object('from', $2::text, 'to', $3::text, 'channel', $4::text, 'delivery', $5::text))`;

interface LeadDateRow {
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
  date_actions: number;
}

/** Исход сообщения оператору: дошло в MAX / заглушкой в Telegram / некуда / адрес не прочитался. */
export type OperatorNotice = 'max' | 'telegram' | 'none' | 'unknown';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Бронь закрыта — дату больше не меняют ни так, ни просьбой. */
const CLOSED_BOOKING = new Set(['cancelled', 'no_show', 'completed']);

const TEXT = {
  unknownButton: 'Кнопка не распознана — ничего не изменено. Откройте «Моя поездка» заново.',
  notYours: 'Эта заявка не подключена к этому чату — дату здесь не меняю. Откройте «Моя поездка» и выберите заявку из списка.',
  unchecked: 'Не удалось проверить заявку — это сбой на нашей стороне. Ничего не изменено, повторите через минуту.',
  closed: 'Заявка закрыта — дату по ней не меняю. Новую поездку можно подобрать здесь же, в чате.',
  noData: 'В заявке не записаны тур или дата — сменить дату кнопкой нельзя. Напишите оператору: дату он поменяет сам.',
  datesFailed: 'Свободные даты тура сейчас не прочитались — это сбой, а не «дат нет». Ничего не изменено, повторите через минуту.',
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

async function readLead(channel: LinkChannel, chatId: string | number, leadId: string): Promise<LeadDateRow | null | 'failed'> {
  try {
    const { rows: [row] } = await pool.query<LeadDateRow>(MY_TRIP_DATE_LEAD_SQL, [channel, String(chatId), leadId]);
    return row ?? null;
  } catch (err) {
    logFail('заявка не прочиталась', err);
    return 'failed';
  }
}

/** `date` — действующая дата поездки; смена без оператора возможна только без брони, и тогда это дата заявки. */
type Usable = { lead: LeadDateRow; tourId: number; date: string; people: number; title: string };

/** Отказ словами или заявка, у которой можно сменить дату. */
function usable(lead: LeadDateRow | null | 'failed'): Usable | ChatReply {
  if (lead === 'failed') return reply(TEXT.unchecked);
  if (lead === null) return reply(TEXT.notYours);
  if (lead.status === 'lost' || (lead.booking_status !== null && CLOSED_BOOKING.has(lead.booking_status))) return reply(TEXT.closed);
  const tourId = lead.tour_id === null ? NaN : Number(lead.tour_id);
  // Действующая дата: у брони — её день, без брони — та, что в заявке.
  const date = lead.booking_date ?? lead.date;
  if (!Number.isFinite(tourId) || !date || !ISO_DAY.test(date)) return reply(TEXT.noData);
  return {
    lead,
    tourId,
    date,
    people: lead.participants && lead.participants > 0 ? lead.participants : 1,
    title: lead.tour_title ?? 'тур заявки',
  };
}

const isReply = (x: Usable | ChatReply): x is ChatReply => 'text' in x;

/** Что будет по нажатию — одной строкой над датами. */
function ruleLine(answered: boolean): string {
  return answered
    ? 'Оператор уже ответил по заявке, поэтому дату меняет он: выберите дату — ему уйдёт ваша просьба перенести.'
    : 'Оператор ещё не ответил — выбранная дата сразу встанет в заявку, а оператору уйдёт сообщение о переносе.';
}

/** «Изменить дату»: свободные даты тура кнопками. Только чтение. */
async function menu(channel: LinkChannel, chatId: string | number, leadId: string): Promise<ChatReply> {
  const u = usable(await readLead(channel, chatId, leadId));
  if (isReply(u)) return u;
  if (u.lead.date_actions >= MY_TRIP_DATE_DAILY_LIMIT) return reply(TEXT.limit);
  const head = `Тур «${escapeHtml(u.title)}», в заявке ${ruDate(u.date)}, участников ${u.people}.`;
  const free = await loadFreeDates(u.tourId, u.people, MY_TRIP_DATE_CHOICES + 1);
  if (free.state === 'failed') return reply(TEXT.datesFailed);
  if (!free.hasCalendar) {
    return reply(`${head}\nРасписания у тура в системе нет — свободных дат показать не могу. Новую дату согласуйте с оператором: он подтверждает её сам.`);
  }
  const dates = free.dates.filter((d) => d.date !== u.date).slice(0, MY_TRIP_DATE_CHOICES);
  if (dates.length === 0) {
    return reply(`${head}\nДругих свободных дат на ${u.people} чел. в календаре тура на год вперёд нет. Можно спросить оператора — он видит заявку.`);
  }
  return reply(
    [head, `Свободные даты на ${u.people} чел.:`, ruleLine(u.lead.answered)].join('\n'),
    dates.map((d) => ({ text: `${shortDate(d.date)} · мест ${d.free}`, payload: signPayload(myTripDatePickPayload(leadId, d.date)) })),
  );
}

/** Сообщение оператору без ПД: тур, даты, люди, места на новую дату. */
export function operatorDateText(kind: 'changed' | 'request', u: { title: string; from: string; to: string; people: number; free: number }): string {
  const tour = `Тур «${escapeHtml(u.title)}», участников ${u.people}`;
  const seats = `По календарю на ${ruDate(u.to)} свободно мест: ${u.free}.`;
  return kind === 'changed'
    ? [
      '<b>Турист перенёс заявку на другую дату</b>',
      `${tour}: было ${ruDate(u.from)}, стало ${ruDate(u.to)}.`,
      seats,
      'Дату турист выбрал сам из свободных: пока вы не ответили, она меняется без вас. Ответ по заявке — как обычно.',
    ].join('\n')
    : [
      '<b>Турист просит перенести заявку</b>',
      `${tour}: сейчас ${ruDate(u.from)}, просит ${ruDate(u.to)}.`,
      seats,
      'Вы уже ответили по заявке, поэтому дату в ней и в брони меняете вы. Туристу ответьте в переписке по заявке или звонком.',
    ].join('\n');
}

/** Оператору — лично, в его MAX или Telegram (без ПД — одна строка на оба). */
async function notifyOperator(operatorId: string, leadId: string, text: string): Promise<OperatorNotice> {
  const { reachForPartner } = await import('@/lib/partners/reach');
  const reach = await reachForPartner(operatorId);
  if (reach === null) {
    console.error(`[my-trip-date] адрес оператора ${operatorId} не прочитался — о дате по заявке ${leadId} не сообщено`);
    return 'unknown';
  }
  if (!reach.reachable) {
    console.error(`[my-trip-date] у оператора ${operatorId} нет ни MAX, ни Telegram — о дате по заявке ${leadId} не сообщено`);
    return 'none';
  }
  const { sendPdAlert } = await import('@/lib/notifications/pd-alert');
  const res = await sendPdAlert({
    text,
    stub: text,
    buttons: [{ text: 'Открыть в кабинете', url: `${getPublicBaseUrl()}/hub/operator/leads/${leadId}` }],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max' && res.delivered) return 'max';
  if (res.channel === 'telegram-stub') return 'telegram';
  console.error(`[my-trip-date] оператору ${operatorId} о дате по заявке ${leadId} не доставлено (${res.channel}) — ${logText(res.reason, 160)}`);
  return 'none';
}

const NOT_TOLD = 'Сообщить оператору сейчас не удалось — у него не подключён чат или он не ответил. Заявку он видит в кабинете';

/** Нажатие на дату: смена сразу или просьба оператору. */
async function pick(channel: LinkChannel, chatId: string | number, leadId: string, date: string): Promise<ChatReply> {
  let u = usable(await readLead(channel, chatId, leadId));
  if (isReply(u)) return u;
  if (date === u.date) return reply(`${ruDate(date)} уже стоит в заявке — ничего не изменено.`);
  if (u.lead.date_actions >= MY_TRIP_DATE_DAILY_LIMIT) return reply(TEXT.limit);
  // Дата свободна СЕЙЧАС: между списком и нажатием места могли разобрать.
  const free = await loadFreeDates(u.tourId, u.people, 1, date);
  if (free.state === 'failed') return reply(TEXT.datesFailed);
  const slot = free.dates[0];
  if (!slot) {
    return reply(
      `На ${ruDate(date)} мест на ${u.people} чел. уже нет — ничего не изменено. Откройте «Изменить дату» заново.`,
      [{ text: 'Изменить дату', payload: myTripDateMenuPayload(leadId) }],
    );
  }
  const factsOf = (cur: Usable) => ({ title: cur.title, from: cur.date, to: date, people: cur.people, free: slot.free });

  if (!u.lead.answered) {
    let logId: string | null = null;
    try {
      const { rows: [row] } = await pool.query<{ log_id: string }>(MY_TRIP_DATE_CHANGE_SQL, [leadId, date, u.date, channel]);
      logId = row?.log_id ?? null;
    } catch (err) {
      logFail('дата заявки не записана', err);
      return reply(TEXT.unchecked);
    }
    if (logId !== null) {
      const notice = await notifyOperator(u.lead.operator_id, leadId, operatorDateText('changed', factsOf(u)));
      try {
        await pool.query(MY_TRIP_DATE_DELIVERY_SQL, [logId, notice]);
      } catch (err) {
        logFail('исход сообщения оператору не записан', err);
      }
      const told = notice === 'max' || notice === 'telegram'
        ? 'Оператору ушло сообщение о переносе.'
        : `${NOT_TOLD}, уже с новой датой.`;
      return reply(`Дата в заявке изменена: тур «${escapeHtml(u.title)}», теперь ${ruDate(date)}. ${told} Заявку по-прежнему подтверждает оператор.`);
    }
    // Строки нет: оператор ответил между чтением и записью — или дату уже
    // сменило второе нажатие той же кнопки. Перечитываем, чтобы сказать
    // правду: «оператор ответил» туристу, у которого он не отвечал, — ложь.
    const again = usable(await readLead(channel, chatId, leadId));
    if (isReply(again)) return again;
    if (!again.lead.answered) {
      return reply(again.date === date
        ? `${ruDate(date)} уже стоит в заявке — ничего не изменено.`
        : 'Дату по заявке только что изменили в другом окне — ничего не изменено. Откройте «Изменить дату» заново.');
    }
    u = again;
  }

  const notice = await notifyOperator(u.lead.operator_id, leadId, operatorDateText('request', factsOf(u)));
  try {
    await pool.query(MY_TRIP_DATE_REQUEST_LOG_SQL, [leadId, u.date, date, channel, notice]);
  } catch (err) {
    logFail('просьба о переносе не записана в журнал', err);
  }
  if (notice === 'max' || notice === 'telegram') {
    return reply(`Оператор уже ответил по заявке, поэтому дату меняет он: просьба перенести на ${ruDate(date)} ему отправлена. В заявке пока прежняя дата — ${ruDate(u.date)}.`);
  }
  return reply(`Оператор уже ответил по заявке, поэтому дату меняет он. ${NOT_TOLD}, но о просьбе не знает — напишите ему или позвоните. В заявке прежняя дата — ${ruDate(u.date)}.`);
}

/**
 * Нажатие «Изменить дату» или даты под «Моей поездкой» — MAX и Telegram.
 * Канал и чат — того апдейта, в котором нажали (личный диалог).
 */
export async function pressMyTripDate(payload: string, channel: LinkChannel, chatId: string | number): Promise<ChatReply> {
  const p = parseMyTripDate(payload);
  if (!p) return reply(TEXT.unknownButton);
  return p.kind === 'menu' ? menu(channel, chatId, p.leadId) : pick(channel, chatId, p.leadId, p.date);
}
