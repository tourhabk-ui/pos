/**
 * lib/mcp/change-request.ts — change_request: отмена и перенос заявки на тур
 * ИИ-агентом по ключу заявки (12.11).
 *
 * Слово владельца 11.11: «мы доверяем агенту»; отменить и перенести можно «как
 * самим человеком», а что будет по вызову — «зависит от ответа». Поэтому здесь
 * только ДВЕРЬ: чей ключ, вызов без записи (проба) и ответ агенту словами и
 * полями. Само правило и запись — те же, что у кнопок «Моей поездки»:
 * lib/requests/cancel-request (отмена) и lib/requests/my-trip-date (дата).
 * Второго правила «ответил ли оператор» здесь нет и быть не должно.
 *
 * Право — у живого ключа НОВОЙ заявки на тур на дату: `opens_chat`, выдан
 * `create_booking_request`. То же условие, что у кнопок чата, только вместо
 * связи «чат ↔ ключ» — сам ключ. Ключ повтора (тот же телефон, тур и дата за
 * сутки) получил бы любой, кто знает чужой телефон: он видит статус, но не
 * меняет. Право стоит условием самого чтения заявки — кодом ниже только
 * объясняется, почему строки нет.
 *
 * Не заявка на тур (подбор, машина, прокат, жильё, запрос мест) — отказ
 * словами: у них «ответил» устроено иначе, их отмена — следующими шагами.
 *
 * Бронь не трогается никогда: есть бронь или «Договорились» — только просьба.
 *
 * Агенту — без ПД, без номера заявки и брони, без текста оператора и без
 * страницы с ключом: ответ хранит копия задач A2A, а номер заявки — оракул.
 */
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { isTestKey } from '@/lib/mcp/test-run';
import { REQUEST_KEY_TTL_DAYS, consentPurposeOfKey, readKey, requestKeyHash } from '@/lib/mcp/request-status';
import { ADDRESSEE_WORDS } from '@/lib/mcp/request-status-schema';
import {
  CHANGE_ACTIONS, type ChangeAction, type ChangeOutcome, type ChangeRequestResult, type ChangeTold,
} from '@/lib/mcp/change-request-schema';
import { isRealDate, kamchatkaToday } from '@/lib/seat-requests/core';
import {
  CANCEL_LEAD_COLUMNS_SQL, CANCEL_LEAD_JOINS_SQL, cancelBlock, cancelLeadByClient, cancelMode, priorCancelRequest,
  type CancelLeadRow, type CancelOutcome,
} from '@/lib/requests/cancel-request';
import {
  DATE_LEAD_COLUMNS_SQL, DATE_LEAD_JOINS_SQL, MY_TRIP_DATE_DAILY_LIMIT, changeLeadDateByClient, previewLeadDateChange,
  type DateLeadRow, type DatePreview,
} from '@/lib/requests/my-trip-date';
import { operatorTold } from '@/lib/requests/notify-request-operator';

export { CHANGE_REQUEST_TOOL_NAME } from '@/lib/mcp/change-request-schema';

/** Какой дверью пришёл агент — в журнал заявки. */
export type ChangeVia = 'mcp' | 'a2a';

/**
 * Что за ключ — чтобы объяснить отказ. `$1` — hash ключа. Права это чтение не
 * даёт: заявку для записи читают запросы ниже, со своим условием.
 */
export const CHANGE_KEY_SQL = `
  SELECT k.tool_name, k.opens_chat,
         k.lead_id::text AS lead_id, k.seat_request_id::text AS seat_request_id, k.stay_request_id::text AS stay_request_id,
         l.is_self AS lead_is_self, (l.operator_id IS NOT NULL) AS lead_addressed,
         l.source_data->>'kind' AS lead_kind
    FROM agent_request_keys k
    LEFT JOIN leads l ON l.id = k.lead_id
   WHERE k.key_hash = $1 AND k.expires_at > NOW()`;

/**
 * Право менять заявку — одно условие на отмену и перенос: живой ключ новой
 * заявки на тур на дату и не своя проба владельца. Псевдонимы — `k` и `l`.
 */
const CHANGE_RIGHT_SQL = `
    FROM agent_request_keys k
    JOIN leads l ON l.id = k.lead_id`;

const CHANGE_RIGHT_WHERE_SQL = `
   WHERE k.key_hash = $1 AND k.expires_at > NOW()
     AND k.opens_chat AND k.tool_name = 'create_booking_request'
     AND l.is_self = FALSE`;

/** Заявка для отмены — по ключу. Адресат не обязателен: большую группу без адресата отменить можно. */
export const CHANGE_CANCEL_LEAD_SQL = `
  SELECT ${CANCEL_LEAD_COLUMNS_SQL}
  ${CHANGE_RIGHT_SQL}
  ${CANCEL_LEAD_JOINS_SQL}
  ${CHANGE_RIGHT_WHERE_SQL}`;

/** Заявка для переноса — по ключу. Адресат обязателен: дату подтверждает он. */
export const CHANGE_DATE_LEAD_SQL = `
  SELECT ${DATE_LEAD_COLUMNS_SQL}
  ${CHANGE_RIGHT_SQL}
  ${DATE_LEAD_JOINS_SQL}
  ${CHANGE_RIGHT_WHERE_SQL}
     AND l.operator_id IS NOT NULL`;

interface KeyRow {
  tool_name: string;
  opens_chat: boolean;
  lead_id: string | null;
  seat_request_id: string | null;
  stay_request_id: string | null;
  lead_is_self: boolean | null;
  lead_addressed: boolean | null;
  lead_kind: string | null;
}

const argsSchema = z.object({
  action: z.enum(CHANGE_ACTIONS, { error: 'action — cancel (отменить заявку) или change_date (перенести на другую дату)' }),
  date: z.string({ error: 'date — строка YYYY-MM-DD' }).trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD').optional(),
  test: z.union([z.boolean(), z.enum(['true', 'false'])], { error: 'test — true или false' }).optional(),
});

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[change-request] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
    logText(err instanceof Error ? err.message : err, 160),
  );
}

/** Сбой базы — исключение, не отказ по входу: агент слышит «сбой у Ведара», а не «нельзя». */
function failed(what: string): never {
  throw new Error(`change_request: ${what}`);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function ruDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

const KEY_GONE = `Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней). Проверьте, что передан ключ из ответа create_booking_request целиком.`;

// Почему ключ только статусный, отказ не говорит: «заявка уже была» — ответ на
// вопрос «просил ли этот телефон этот тур на эту дату» (анти-оракул 29.09).
const STATUS_ONLY = 'Этот ключ только показывает статус заявки — отменить или перенести её по нему нельзя. '
  + 'Нужен ключ, который create_booking_request выдал при создании заявки; нет его — отмену и перенос человек согласует с оператором сам. '
  + 'Заявка не изменена.';

/** Почему по этому ключу менять нельзя — словами; null — ключ годится. */
function keyRefusal(k: KeyRow): McpUserError | null {
  const tourRequest = k.lead_id !== null && k.tool_name === 'create_booking_request';
  if (!tourRequest) {
    const who = ADDRESSEE_WORDS[consentPurposeOfKey(k)];
    const what = k.stay_request_id ? 'заявка на жильё'
      : k.seat_request_id ? 'запрос мест у оператора (тур без расписания)'
        : k.tool_name === 'request_charter' || k.lead_kind === 'charter' ? 'заявка на машину'
          : k.tool_name === 'create_car_rental_request' || k.lead_kind === 'car_rental' ? 'заявка на прокат'
            : k.tool_name === 'create_lead' ? 'заявка на подбор'
              : 'заявка другого вида';
    return new McpUserError(
      `Этим инструментом меняются только заявки на тур на дату (create_booking_request); этот ключ — ${what}. `
      + `Отмену и перенос по ней согласуйте с тем, кто её ведёт (${who.nom} или менеджер Ведара): в переписке на странице заявки `
      + '(get_request_status, поле page), если она открыта, или по телефону. Заявка не изменена.',
      'not_supported',
    );
  }
  if (!k.opens_chat || k.lead_is_self === true) return new McpUserError(STATUS_ONLY, 'status_only_key');
  return null;
}

async function readKeyRow(hash: string): Promise<KeyRow | null> {
  try {
    const { rows: [row] } = await pool.query<KeyRow>(CHANGE_KEY_SQL, [hash]);
    return row ?? null;
  } catch (err) {
    logFail('ключ не прочитан', err);
    return failed('ключ не прочитан');
  }
}

async function readByRight<T extends { id: string }>(sql: string, hash: string, what: string): Promise<T | null | 'failed'> {
  try {
    const { rows: [row] } = await pool.query<T>(sql, [hash]);
    return row ?? null;
  } catch (err) {
    logFail(what, err);
    return 'failed';
  }
}

/** «Тур «…», 14.01.2027, участников 3» — о какой заявке речь. Текст — не HTML: агент передаст его как есть. */
function headOf(lead: { tour_title: string | null; booking_date: string | null; date: string | null; participants: number | null }): string {
  const date = lead.booking_date ?? lead.date;
  return [
    `тур «${lead.tour_title ?? 'тур заявки'}»`,
    date && ISO_DAY.test(date) ? ruDate(date) : null,
    lead.participants && lead.participants > 0 ? `участников ${lead.participants}` : null,
  ].filter(Boolean).join(', ');
}

const currentDate = (lead: { booking_date: string | null; date: string | null }): string | null => {
  const d = lead.booking_date ?? lead.date;
  return d && ISO_DAY.test(d) ? d : null;
};

type Said = Pick<ChangeRequestResult, 'outcome' | 'changed' | 'human' | 'next' | 'told'>;

const NEXT_NEW = 'Вернуть отменённую заявку нельзя. Новая заявка — create_booking_request.';
const NEXT_WATCH = 'Состояние заявки — get_request_status: оно сменится, когда заявку закроют. Повторный вызов просьбу не дублирует.';
const NEXT_NOTHING = 'Ничего делать не нужно.';
const NEXT_RETRY = 'Повторите вызов через пару минут. Надёжнее, если человек сам напишет оператору на странице заявки (get_request_status, поле page) или позвонит.';

/** Исход отмены — агенту: слово, поля и что сказать человеку. */
export function cancelSaid(o: Exclude<CancelOutcome, { kind: 'failed' }>, head: string): Said {
  switch (o.kind) {
    case 'cancelled': {
      const done = `Заявка отменена: ${head}.`;
      if (o.told === 'no_addressee') {
        return { outcome: 'cancelled', changed: true, told: o.manager === 'told' ? 'manager' : 'nobody', next: NEXT_NEW,
          human: `${done} Оператора у неё не было — дальше её никому не передадут.` };
      }
      if (operatorTold(o.told)) {
        return { outcome: 'cancelled', changed: true, told: 'operator', next: NEXT_NEW, human: `${done} Оператору ушло сообщение.` };
      }
      return {
        outcome: 'cancelled', changed: true, told: o.manager === 'told' ? 'manager' : 'nobody', next: NEXT_NEW,
        human: `${done} Сообщить оператору сейчас не удалось — в кабинете он увидит её отменённой.${o.manager === 'told' ? ' Менеджер Ведара предупреждён.' : ''}`,
      };
    }
    case 'requested':
      if (o.told === 'no_addressee') {
        return { outcome: 'cancel_requested', changed: false, told: 'manager', next: NEXT_WATCH,
          human: 'По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба об отмене передана менеджеру Ведара. Заявка действует, пока её не закроют.' };
      }
      return operatorTold(o.told)
        ? { outcome: 'cancel_requested', changed: false, told: 'operator', next: NEXT_WATCH,
          human: 'Оператор уже ответил по заявке, поэтому отменяет он: просьба ему отправлена. Заявка действует, пока он её не закроет.' }
        : { outcome: 'cancel_requested', changed: false, told: 'manager', next: NEXT_WATCH,
          human: 'Оператор уже ответил по заявке, поэтому отменяет он. Сообщить ему сейчас не удалось — просьба передана менеджеру Ведара. '
            + 'Заявка остаётся в силе, пока её не закроют; надёжнее написать оператору или позвонить.' };
    case 'request_undelivered':
      return {
        outcome: 'cancel_request_undelivered', changed: false, told: 'nobody', next: NEXT_RETRY,
        human: o.addressee
          ? 'Оператор уже ответил по заявке, поэтому отменяет он, но передать просьбу сейчас не удалось — ни ему, ни менеджеру Ведара. Заявка остаётся в силе.'
          : 'По заявке уже есть договорённость, поэтому сразу она не отменяется, а передать просьбу менеджеру Ведара сейчас не удалось. Заявка остаётся в силе.',
      };
    case 'already_cancelled':
      return { outcome: 'already_cancelled', changed: false, told: null, next: 'Ничего делать не нужно. Новая заявка — create_booking_request.',
        human: 'Заявка уже отменена — ничего не изменено.' };
    case 'already_requested':
      return {
        outcome: 'cancel_already_requested', changed: false, told: o.via === 'pending' ? null : o.via, next: o.via === 'pending' ? NEXT_RETRY : NEXT_WATCH,
        human: o.via === 'operator'
          ? 'Просьба об отмене по этой заявке уже отправлена оператору — повторно не отправляется. Заявка действует, пока он её не закроет.'
          : o.via === 'manager'
            ? 'Просьба об отмене по этой заявке уже передана менеджеру Ведара — повторно не отправляется. Заявка действует, пока её не закроют.'
            : 'Просьба об отмене по этой заявке сейчас отправляется — повторный вызов ничего не добавил. Заявка пока действует.',
      };
    case 'closed':
      return { outcome: 'closed', changed: false, told: null, next: NEXT_NOTHING, human: 'Заявка уже закрыта — отменять нечего.' };
    case 'past':
      return { outcome: 'past', changed: false, told: null, next: NEXT_NOTHING, human: 'Поездка по заявке уже прошла — отменять нечего.' };
  }
}

/** Проба отмены: что произошло бы. Те же чистые правила, что у записи; ничего не пишет. */
export function cancelPreview(lead: CancelLeadRow, today: string): Said {
  const block = cancelBlock(lead, today);
  if (block === 'cancelled') return cancelSaid({ kind: 'already_cancelled' }, '');
  if (block) return cancelSaid({ kind: block }, '');
  const head = headOf(lead);
  if (cancelMode(lead) === 'request') {
    const prior = priorCancelRequest(lead);
    if (prior === 'operator' || prior === 'manager' || prior === 'pending') return cancelSaid({ kind: 'already_requested', via: prior }, head);
    return {
      outcome: 'would_request_cancel', changed: false, told: null,
      next: 'Чтобы просьба ушла, повторите вызов без test: true — только если человек сам просит об отмене.',
      human: lead.operator_id === null
        ? `Проба, ничего не изменено. По заявке (${head}) уже есть договорённость: сразу она не отменится — просьба уйдёт менеджеру Ведара, заявка будет действовать, пока её не закроют.`
        : `Проба, ничего не изменено. Оператор уже ответил по заявке (${head}), поэтому отменяет он: ему уйдёт просьба, ${lead.booking_status !== null ? 'заявка и бронь будут' : 'заявка будет'} действовать, пока он не закроет.`,
    };
  }
  return {
    outcome: 'would_cancel', changed: false, told: null,
    next: 'Чтобы отменить, повторите вызов без test: true — только если человек сам просит об отмене: вернуть отменённую заявку нельзя.',
    human: lead.operator_id === null
      ? `Проба, ничего не изменено. Оператора у заявки (${head}) сейчас нет — она отменится сразу, и дальше её никому не передадут.`
      : `Проба, ничего не изменено. Оператор ещё не ответил по заявке (${head}) — она отменится сразу, оператору уйдёт сообщение.`,
  };
}

const NEXT_DATES = 'Свободные даты тура — get_tour_availability (people — число людей заявки).';
const LIMIT_TEXT = `Дату по этой заявке за сутки уже меняли или просили перенести ${MY_TRIP_DATE_DAILY_LIMIT} раза — больше сегодня не меняется. Дальше человек договаривается с оператором напрямую: тот видит заявку и её дату.`;

/** Исход переноса (или пробы) — агенту. `head` — заявка словами, с действующей датой. */
export function dateSaid(o: Exclude<DatePreview, { kind: 'failed' | 'datesFailed' | 'gone' }>, head: string): Said {
  switch (o.kind) {
    case 'changed':
      return {
        outcome: 'date_changed', changed: true, told: operatorTold(o.told) ? 'operator' : 'nobody',
        next: 'Заявку по-прежнему подтверждает оператор: состояние — get_request_status.',
        human: `Дата в заявке изменена: тур «${o.title}», было ${ruDate(o.from)}, теперь ${ruDate(o.date)}. `
          + (operatorTold(o.told) ? 'Оператору ушло сообщение о переносе.' : 'Сообщить оператору сейчас не удалось — заявку он увидит в кабинете уже с новой датой.'),
      };
    case 'requested':
      return operatorTold(o.told)
        ? { outcome: 'date_change_requested', changed: false, told: 'operator',
          next: 'Дату меняет оператор: get_request_status покажет её в поле date, когда он перенесёт. Повторять просьбу на ту же дату незачем.',
          human: `Оператор уже ответил по заявке, поэтому дату меняет он: просьба перенести на ${ruDate(o.date)} ему отправлена. В заявке пока прежняя дата — ${ruDate(o.current)}.` }
        : { outcome: 'date_change_request_undelivered', changed: false, told: 'nobody',
          next: 'Пусть человек сам напишет оператору на странице заявки (get_request_status, поле page) или позвонит: о просьбе оператор не знает.',
          human: `Оператор уже ответил по заявке, поэтому дату меняет он, но сообщить ему о просьбе сейчас не удалось. В заявке прежняя дата — ${ruDate(o.current)}.` };
    case 'wouldChange':
      return { outcome: 'would_change_date', changed: false, told: null,
        next: 'Чтобы перенести, повторите вызов без test: true — только если человек сам просит о переносе.',
        human: `Проба, ничего не изменено. Оператор ещё не ответил по заявке (${head}) — дата ${ruDate(o.date)} сразу встанет в заявку, оператору уйдёт сообщение о переносе.` };
    case 'wouldRequest':
      return { outcome: 'would_request_date_change', changed: false, told: null,
        next: 'Чтобы просьба ушла, повторите вызов без test: true — только если человек сам просит о переносе.',
        human: `Проба, ничего не изменено. Оператор уже ответил по заявке (${head}), поэтому дату меняет он: ему уйдёт просьба перенести на ${ruDate(o.date)}, в заявке останется ${ruDate(o.current)}.` };
    case 'same':
      return { outcome: 'same_date', changed: false, told: null, next: NEXT_NOTHING, human: `${ruDate(o.date)} уже стоит в заявке — ничего не изменено.` };
    case 'refusedDate':
      return { outcome: 'date_refused_by_operator', changed: false, told: null, next: NEXT_DATES,
        human: `На ${ruDate(o.date)} оператор уже ответил «Нет мест» — на эту дату заявка не переносится. Нужна другая дата.` };
    case 'noSeats':
      return o.hasCalendar
        ? { outcome: 'no_seats', changed: false, told: null, next: NEXT_DATES,
          human: `На ${ruDate(o.date)} мест на ${o.people} чел. по календарю тура нет (или выезда в этот день нет) — ничего не изменено.` }
        : { outcome: 'no_schedule', changed: false, told: null,
          next: 'Новую дату человек согласует с оператором: в переписке на странице заявки (get_request_status, поле page) или по телефону.',
          human: 'Расписания у тура в системе нет — свободных дат платформа не знает, поэтому дату по заявке не меняет: её подтверждает оператор.' };
    case 'limit':
      return { outcome: 'daily_limit', changed: false, told: null, next: 'Сегодня дату по этой заявке больше не менять.', human: LIMIT_TEXT };
    case 'changedElsewhere':
      return { outcome: 'changed_elsewhere', changed: false, told: null, next: 'Прочитайте заявку заново (get_request_status) и решите, нужен ли перенос ещё.',
        human: 'Дату по заявке только что изменили другим вызовом или нажатием — этим вызовом ничего не изменено.' };
    case 'closed':
      return { outcome: 'closed', changed: false, told: null, next: 'Новая заявка — create_booking_request.', human: 'Заявка закрыта — дату по ней не меняют.' };
    case 'past':
      return { outcome: 'past', changed: false, told: null, next: 'Новая заявка — create_booking_request.', human: 'Поездка по заявке уже прошла — дату по ней не меняют.' };
    case 'noData':
      return { outcome: 'no_data', changed: false, told: null,
        next: 'Дату человек согласует с оператором напрямую.',
        human: 'В заявке не записаны тур или дата — перенести её этим инструментом нельзя.' };
  }
}

/** Вызов инструмента: что сделано и что сказать. Отказ по входу — McpUserError; сбой базы — исключение. */
export async function changeRequest(rawArgs: Record<string, unknown>, via: ChangeVia, opts: { now?: number } = {}): Promise<ChangeRequestResult> {
  const key = readKey(rawArgs.key);
  const parsed = argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new McpUserError(issue?.message ?? 'Некорректные аргументы', `invalid_args:${String(issue?.path?.[0] ?? '').slice(0, 20)}`);
  }
  const action: ChangeAction = parsed.data.action;
  const test = parsed.data.test === true || parsed.data.test === 'true';
  const today = kamchatkaToday(opts.now);
  let date: string | null = null;
  if (action === 'change_date') {
    if (!parsed.data.date) throw new McpUserError('Для переноса нужна новая дата: date в формате YYYY-MM-DD.', 'invalid_args:date');
    if (!isRealDate(parsed.data.date)) throw new McpUserError(`Даты ${parsed.data.date} не существует — заявка не изменена.`, 'invalid_args:date');
    if (parsed.data.date < today) throw new McpUserError(`Дата ${ruDate(parsed.data.date)} уже прошла — заявка не изменена.`, 'invalid_args:date');
    date = parsed.data.date;
  }
  if (isTestKey(key)) {
    throw new McpUserError('Это ключ пробной заявки (create_booking_request с test: true): заявки нет — менять нечего.', 'test_key');
  }

  const hash = requestKeyHash(key);
  const k = await readKeyRow(hash);
  if (!k) throw new McpUserError(KEY_GONE, 'key_not_found');
  const refusal = keyRefusal(k);
  if (refusal) throw refusal;

  const out = (said: Said, lead: { booking_date: string | null; date: string | null }, dateNow?: string | null): ChangeRequestResult => ({
    action, test, ...said, date: dateNow === undefined ? currentDate(lead) : dateNow,
  });

  if (action === 'cancel') {
    const read = () => readByRight<CancelLeadRow>(CHANGE_CANCEL_LEAD_SQL, hash, 'заявка для отмены не прочиталась');
    const lead = await read();
    if (lead === 'failed') return failed('заявка не прочитана');
    // Ключ годился мгновение назад, а строки нет: истёк или заявку закрыли между чтениями.
    if (lead === null) throw new McpUserError(KEY_GONE, 'key_not_found');
    if (test) return out(cancelPreview(lead, today), lead);
    const outcome = await cancelLeadByClient({ lead, channel: via, today, reread: read });
    if (outcome.kind === 'failed') return failed('отмена не записана');
    return out(cancelSaid(outcome, headOf(lead)), lead);
  }

  if (k.lead_addressed !== true) {
    throw new McpUserError(
      'У заявки сейчас нет оператора (большую группу передали другим операторам или её ведёт менеджер Ведара) — дату по ней подтверждать некому, она не изменена. '
      + 'Отменить такую заявку можно: action cancel.',
      'no_addressee',
    );
  }
  const read = () => readByRight<DateLeadRow>(CHANGE_DATE_LEAD_SQL, hash, 'заявка для переноса не прочиталась');
  const lead = await read();
  if (lead === 'failed') return failed('заявка не прочитана');
  if (lead === null) throw new McpUserError(KEY_GONE, 'key_not_found');
  const outcome: DatePreview = test
    ? await previewLeadDateChange({ lead, date: date!, today })
    : await changeLeadDateByClient({ lead, date: date!, channel: via, today, reread: read });
  if (outcome.kind === 'failed') return failed('дата не записана');
  if (outcome.kind === 'datesFailed') return failed('свободные даты тура не прочитаны');
  if (outcome.kind === 'gone') throw new McpUserError(KEY_GONE, 'key_not_found');
  return out(dateSaid(outcome, headOf(lead)), lead, outcome.kind === 'changed' ? outcome.date : undefined);
}

/** Исполнитель для роута MCP: JSON-строка того же объекта (как у get_request_status). */
export async function runChangeRequestTool(rawArgs: Record<string, unknown>, via: ChangeVia): Promise<string> {
  return JSON.stringify(await changeRequest(rawArgs, via));
}

export type { ChangeOutcome, ChangeTold };
