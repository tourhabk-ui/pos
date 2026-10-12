/**
 * get_request_status — состояние заявки для агента по ключу (ступень 1
 * агентного контура, #2371; миграция 1220).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * После заявки через MCP или A2A агент не мог узнать ничего и не мог
 * вернуться к человеку с ответом: номер заявки в ответе не называется
 * намеренно (совпавший номер — оракул «этот телефон уже просил этот тур на
 * эту дату», проверка MCP 29.09), а страница статуса с ключом есть только у
 * запроса мест. Теперь каждый вызов пишущего инструмента выдаёт СВОЙ
 * случайный ключ: он не номер, одинаков по форме у новой и повторной заявки
 * и ничего о ней не говорит; по нему здесь читается состояние.
 *
 * ── Что отдаётся и что нет ─────────────────────────────────────────────────
 *
 * Состояние одним словом из закрытого словаря (REQUEST_STATES), название
 * тура, дата, число человек, предложенная оператором дата, срок ответа и
 * текст для человека. Имени, телефона, комментария, номера лида и ссылки на
 * бронь (в ней ключ доступа человека) нет by construction: SQL их не
 * выбирает. Ключ не найден или истёк — отказ по входу с объяснением, не
 * «заявки нет»; база не ответила — исключение с SQLSTATE в логе (§4.0), а не
 * «ждёт оператора».
 *
 * Сторожа: tests/unit/mcp-request-status.test.ts (форма, словарь, отсутствие
 * ПД, хеш вместо ключа), tests/integration/mcp-request-status.pg.test.ts
 * (SQL на схеме прода).
 */

import { createHash, randomBytes } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { logText } from '@/lib/log/log-text';
import { effectiveStatus, type SeatRequestStatus, type FailureKind } from '@/lib/seat-requests/core';
import {
  REQUEST_KEY_MIN_CHARS, REQUEST_KEY_MAX_CHARS, type RequestState, type RequestKind,
} from '@/lib/mcp/request-status-schema';

export { REQUEST_STATUS_TOOL_NAME, GET_REQUEST_STATUS_TOOL } from '@/lib/mcp/request-status-schema';

/** Сколько живёт ключ. Заявка на тур следующего сезона старше трёх месяцев — редкость. */
export const REQUEST_KEY_TTL_DAYS = 90;

const KEY_RE = /^[A-Za-z0-9_-]+$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type RequestKeyTarget = { leadId: string } | { seatRequestId: string };

/**
 * Выдать ключ на заявку. В базу — только хеш; сырой ключ возвращается ровно
 * один раз. Отказ базы — null и строка в лог: заявка уже принята, и без
 * ключа она не хуже, чем была до 12.10; агент услышит, что ключа нет.
 */
export async function issueRequestKey(target: RequestKeyTarget, toolName: string): Promise<string | null> {
  const key = randomBytes(24).toString('base64url');
  const leadId = 'leadId' in target ? target.leadId : null;
  const seatRequestId = 'seatRequestId' in target ? target.seatRequestId : null;
  try {
    await pool.query(
      `INSERT INTO agent_request_keys (key_hash, lead_id, seat_request_id, tool_name, expires_at)
       VALUES ($1, $2::uuid, $3::uuid, $4, NOW() + ($5::int * INTERVAL '1 day'))`,
      [sha256(key), leadId, seatRequestId, toolName, REQUEST_KEY_TTL_DAYS],
    );
    return key;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] ключ не выдан:', logText(toolName), typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}

/** Хвост ответа пишущего инструмента: ключ есть — как им пользоваться; нет — так и сказано. */
export function keyLine(key: string | null): string {
  return key
    ? ` Ключ статуса заявки: ${key} — по нему get_request_status покажет, ответил ли оператор (без имени и телефона). Храните ключ у себя или у человека, не публикуйте.`
    : ' Ключ статуса заявки не выдан (сбой записи ключа): узнать исход можно только по звонку оператора.';
}

export interface RequestStatusView {
  state: RequestState;
  kind: RequestKind;
  tour: string | null;
  date: string | null;
  participants: number | null;
  alt_date: string | null;
  deadline: string | null;
  human: string;
  next: string;
}

interface StatusRow {
  tool_name: string;
  lead_id: string | null;
  seat_request_id: string | null;
  lead_status: string | null;
  route_title: string | null;
  booking_status: string | null;
  booking_date: string | null;
  booking_participants: number | null;
  booking_tour: string | null;
  seat_status: SeatRequestStatus | null;
  deadline_at: Date | string | null;
  answered_at: Date | string | null;
  seat_date: string | null;
  seat_participants: number | null;
  alt_date: string | null;
  failure_kind: FailureKind | null;
  seat_tour: string | null;
}

/** Лид: сначала бронь по нему (если оператор уже завёл), иначе статус самого лида. */
export function leadState(leadStatus: string | null, bookingStatus: string | null): RequestState {
  if (bookingStatus) {
    if (bookingStatus === 'confirmed' || bookingStatus === 'completed') return 'confirmed';
    if (bookingStatus === 'cancelled') return 'cancelled';
    return 'awaiting_operator';
  }
  switch (leadStatus) {
    case 'new': return 'awaiting_operator';
    case 'contacted': return 'operator_contacted';
    case 'qualified': return 'in_progress';
    case 'converted': return 'confirmed';
    case 'lost': return 'declined';
    default: return 'unknown';
  }
}

export function seatState(status: SeatRequestStatus): RequestState {
  switch (status) {
    case 'pending': return 'awaiting_operator';
    case 'confirmed': return 'confirmed';
    case 'declined': return 'declined';
    case 'other_date': return 'other_date';
    case 'expired': return 'no_answer';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

const HUMAN: Record<RequestState, string> = {
  awaiting_operator: 'Заявка принята, оператор ещё не ответил.',
  operator_contacted: 'Оператор связался с человеком по заявке.',
  in_progress: 'Заявка в работе у оператора: детали уточняются.',
  confirmed: 'Оператор подтвердил заявку.',
  declined: 'Оператор отказал по заявке или она не состоялась.',
  other_date: 'На запрошенную дату мест нет, оператор предложил другую дату.',
  no_answer: 'Оператор не ответил в срок.',
  cancelled: 'Бронь по заявке отменена.',
  failed: 'Ответ оператора не записался — исход выясняется у оператора напрямую.',
  unknown: 'Состояние заявки не распознано.',
};

const NEXT: Record<RequestState, string> = {
  awaiting_operator: 'Подождите звонка оператора; повторно спрашивать статус раньше чем через час не нужно.',
  operator_contacted: 'Дальнейшее человек согласует с оператором по телефону.',
  in_progress: 'Дальнейшее человек согласует с оператором по телефону.',
  confirmed: 'Оплата — оператору напрямую, он скажет как. Через платформу оплаты нет.',
  declined: 'Можно выбрать другой тур или дату: get_tours, get_tour_availability; подбор — create_lead.',
  other_date: 'Если дата подходит, человек подтверждает её оператору по телефону; иначе — другой тур или дата.',
  no_answer: 'Это не значит, что мест нет: можно оставить заявку через create_lead — менеджер свяжется с оператором сам.',
  cancelled: 'Можно оставить новую заявку: create_booking_request или create_lead.',
  failed: 'Человеку стоит связаться с оператором напрямую; можно оставить заявку через create_lead.',
  unknown: 'Человеку стоит связаться с оператором напрямую; можно оставить заявку через create_lead.',
};

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  const t = v instanceof Date ? v : new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function readKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < REQUEST_KEY_MIN_CHARS || key.length > REQUEST_KEY_MAX_CHARS || !KEY_RE.test(key)) {
    throw new McpUserError('Ключ статуса не похож на выданный — передайте его как есть из ответа пишущего инструмента.', 'invalid_args:key');
  }
  return key;
}

/**
 * Один запрос: ключ живой → отметка прочтения и строка лида или запроса мест.
 * Бронь по лиду — последняя не удалённая (оператор мог завести одну).
 */
export const REQUEST_STATUS_SQL = `
  WITH k AS (
    UPDATE agent_request_keys
       SET last_read_at = NOW(), read_count = read_count + 1
     WHERE key_hash = $1 AND expires_at > NOW()
    RETURNING lead_id, seat_request_id, tool_name
  )
  SELECT k.tool_name, k.lead_id::text, k.seat_request_id::text,
         l.status AS lead_status, l.route_title,
         ob.booking_status, ob.booking_date::text AS booking_date, ob.participants AS booking_participants, ot.title AS booking_tour,
         r.status AS seat_status, r.deadline_at, r.answered_at, r.tour_date::text AS seat_date,
         r.participants AS seat_participants, r.alt_date::text AS alt_date, r.failure_kind, st.title AS seat_tour
    FROM k
    LEFT JOIN leads l ON l.id = k.lead_id
    LEFT JOIN LATERAL (
      SELECT b.booking_status, b.booking_date, b.participants, b.operator_tour_id
        FROM operator_bookings b
       WHERE b.lead_id = k.lead_id AND b.deleted_at IS NULL
       ORDER BY b.created_at DESC
       LIMIT 1
    ) ob ON k.lead_id IS NOT NULL
    LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    LEFT JOIN tour_seat_requests r ON r.id = k.seat_request_id
    LEFT JOIN operator_tours st ON st.id = r.tour_id`;

export async function readRequestStatus(rawKey: unknown): Promise<RequestStatusView> {
  const key = readKey(rawKey);
  let row: StatusRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<StatusRow>(REQUEST_STATUS_SQL, [sha256(key)]));
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[request-status] статус не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    throw new Error('get_request_status: статус не прочитан');
  }
  if (!row) {
    throw new McpUserError(`Ключ не найден или истёк (ключ живёт ${REQUEST_KEY_TTL_DAYS} дней). Проверьте, что передан ключ из ответа инструмента целиком.`, 'key_not_found');
  }

  if (row.seat_request_id && row.seat_status) {
    const status = effectiveStatus({ status: row.seat_status, deadline_at: row.deadline_at ?? new Date(0), answered_at: row.answered_at });
    const state = seatState(status);
    return {
      state,
      kind: 'seat_request',
      tour: row.seat_tour,
      date: row.seat_date,
      participants: row.seat_participants,
      alt_date: state === 'other_date' ? row.alt_date : null,
      deadline: state === 'awaiting_operator' ? iso(row.deadline_at) : null,
      human: HUMAN[state] + (state === 'failed' && row.failure_kind === 'unfinished' ? ' Ответ оператора был получен, но не записан.' : ''),
      next: NEXT[state],
    };
  }

  // Лид без строки lead: сама заявка удалена (ON DELETE CASCADE снял бы и
  // ключ, но строка могла исчезнуть между UPDATE и JOIN) — честное unknown.
  const state = row.lead_id ? leadState(row.lead_status, row.booking_status) : 'unknown';
  return {
    state,
    kind: 'lead',
    tour: row.booking_tour ?? row.route_title,
    date: row.booking_date,
    participants: row.booking_participants,
    alt_date: null,
    deadline: null,
    human: HUMAN[state],
    next: NEXT[state],
  };
}

/** Исполнитель для роута MCP: JSON-строка того же объекта (как у search/fetch). */
export async function runRequestStatusTool(rawArgs: Record<string, unknown>): Promise<string> {
  return JSON.stringify(await readRequestStatus(rawArgs.key));
}
