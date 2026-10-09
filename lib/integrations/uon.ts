/**
 * U-ON.Travel CRM integration
 *
 * Документация: https://api.u-on.ru/doc. Оператор хранит ключ в
 * partners.uon_api_key; при новой брони — POST /request/create.json, id заявки
 * U-ON пишется в operator_bookings.uon_request_id.
 *
 * Поля сверены с документацией request/create 09.10 (пробы 747–749 с раннера,
 * #2313). До этого отправка называла поля, которых в документации нет вовсе:
 * r_tour, r_count_tur, r_price, r_note и массив tourist[] с t_name/t_phone. А
 * r_dat там — дата СОЗДАНИЯ заявки в формате Y-m-d H:i:s, не дата тура. Все
 * поля request/create необязательны, поэтому U-ON отвечал id, лог писал
 * «успех», а у оператора появлялась заявка без клиента, телефона, даты, цены
 * и названия тура.
 *
 * Тело — форма (application/x-www-form-urlencoded), как в примерах клиентов
 * U-ON на PHP: форму сервер на PHP разбирает сам, JSON — только если так
 * настроен. На живом ключе формат не проверялся: ключа у нас нет.
 */

import { pool } from '@/lib/db-pool';

const UON_BASE = 'https://api.u-on.ru';
const TIMEOUT_MS = 10_000;

interface UonSyncLogEntry {
  operator_id?: string;
  booking_id?: string;
  endpoint: string;
  success: boolean;
  http_status: number | null;
  latency_ms: number;
  uon_request_id?: number | null;
  error?: string | null;
}

/**
 * Структурный лог вызова U-ON API (латентность, статус, ошибка).
 * Fire-and-forget: не блокирует и не ломает поток брони, если таблицы ещё нет.
 */
function logUonSync(entry: UonSyncLogEntry): void {
  void pool.query(
    `INSERT INTO uon_sync_log
       (operator_id, booking_id, endpoint, success, http_status, latency_ms, uon_request_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.operator_id ?? null,
      entry.booking_id ?? null,
      entry.endpoint,
      entry.success,
      entry.http_status,
      entry.latency_ms,
      entry.uon_request_id ?? null,
      entry.error ? entry.error.slice(0, 500) : null,
    ],
  ).catch((e: unknown) => {
    // Лог не критичен для брони, но молчать о нём нельзя (§4.0).
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'нет кода';
    console.error('[uon] строка uon_sync_log не записана, SQLSTATE', code);
  });
}

/**
 * Поля request/create, которые мы отправляем, — подмножество документации
 * (имена дословно). Сторож uon-request-fields держит, что других нет.
 */
export const UON_REQUEST_FIELDS = [
  'r_dat_begin', // дата начала заявки, Y-m-d H:i:s
  'price',       // стоимость заявки
  'note',        // примечание: тур, дата, участники, пожелания, номер брони
  'source',      // источник заявки — в отчётах U-ON по источникам виден Ведар
  'u_name',      // клиент (покупатель)
  'u_phone',
  'u_email',
] as const;

type UonRequestField = typeof UON_REQUEST_FIELDS[number];

/** Так заявка с платформы подписана в отчётах U-ON по источникам. */
export const UON_SOURCE = 'Ведар';

interface UonCreateResponse {
  id?: number;
  result?: string;
  error?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function ruDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Тело request/create. Имя туриста уходит в u_name целиком, как он его ввёл:
 * порядок «имя фамилия» или «фамилия имя» из одной строки не узнать, а
 * угаданная фамилия в карточке клиента хуже пустой.
 */
export function uonRequestBody(booking: UonBookingInput): URLSearchParams {
  const fields: Partial<Record<UonRequestField, string>> = {};
  const dateKnown = ISO_DATE.test(booking.booking_date);
  if (dateKnown) fields.r_dat_begin = `${booking.booking_date} 00:00:00`;
  fields.price = String(booking.total_price);
  fields.source = UON_SOURCE;

  const note = [
    booking.booking_id ? `Заявка с Ведара, бронь № ${booking.booking_id}` : 'Заявка с Ведара',
    `Тур: ${booking.tour_title}`,
    `Дата: ${dateKnown ? ruDate(booking.booking_date) : booking.booking_date}`,
    `Участников: ${booking.participants}`,
  ];
  if (booking.special_requests?.trim()) note.push(`Пожелания: ${booking.special_requests.trim()}`);
  fields.note = note.join('\n');

  const name = booking.tourist_name.trim();
  if (name) fields.u_name = name;
  if (booking.tourist_phone?.trim()) fields.u_phone = booking.tourist_phone.trim();
  if (booking.tourist_email?.trim()) fields.u_email = booking.tourist_email.trim();

  const body = new URLSearchParams();
  for (const key of UON_REQUEST_FIELDS) {
    const value = fields[key];
    if (value !== undefined) body.set(key, value);
  }
  return body;
}

export interface UonBookingInput {
  tour_title: string;
  booking_date: string;       // YYYY-MM-DD
  participants: number;
  total_price: number;
  tourist_name: string;
  tourist_phone?: string;
  tourist_email?: string;
  special_requests?: string;
  // operator_id — только для лога синхронизации; booking_id — для лога и
  // номера брони в примечании заявки U-ON.
  operator_id?: string;
  booking_id?: string;
}

export async function createUonRequest(
  apiKey: string,
  booking: UonBookingInput,
): Promise<number | null> {
  const endpoint = 'request/create.json';
  const url = `${UON_BASE}/${encodeURIComponent(apiKey)}/${endpoint}`;
  const t0 = Date.now();
  let httpStatus: number | null = null;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    uonRequestBody(booking),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    httpStatus = res.status;

    if (!res.ok) {
      logUonSync({ operator_id: booking.operator_id, booking_id: booking.booking_id, endpoint, success: false, http_status: httpStatus, latency_ms: Date.now() - t0, error: `U-ON HTTP ${res.status}` });
      throw new Error(`U-ON HTTP ${res.status}`);
    }

    const data = await res.json() as UonCreateResponse;

    if (data.error) {
      logUonSync({ operator_id: booking.operator_id, booking_id: booking.booking_id, endpoint, success: false, http_status: httpStatus, latency_ms: Date.now() - t0, error: `U-ON error: ${data.error}` });
      throw new Error(`U-ON error: ${data.error}`);
    }

    const requestId = data.id ?? null;
    logUonSync({ operator_id: booking.operator_id, booking_id: booking.booking_id, endpoint, success: true, http_status: httpStatus, latency_ms: Date.now() - t0, uon_request_id: requestId });
    return requestId;
  } catch (err) {
    // Сетевой сбой (fetch бросил до ответа) — ещё не залогирован
    if (httpStatus === null) {
      logUonSync({ operator_id: booking.operator_id, booking_id: booking.booking_id, endpoint, success: false, http_status: null, latency_ms: Date.now() - t0, error: err instanceof Error ? err.message : 'fetch failed' });
    }
    throw err;
  }
}
