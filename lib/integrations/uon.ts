/**
 * U-ON.Travel CRM integration
 *
 * Docs: https://api.u-on.ru/
 * Operator sets uon_api_key in their partner profile.
 * On booking creation: POST /request/create.json → get request_id → store on operator_bookings.
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
  ).catch(() => { /* лог не критичен */ });
}

interface UonTourist {
  t_name: string;
  t_surname?: string;
  t_phone?: string;
  t_email?: string;
}

interface UonCreateRequestPayload {
  r_dat: string;          // DD.MM.YYYY — start date
  r_tour: string;         // tour title
  r_count_tur: number;    // participant count
  r_price: number;        // total price
  r_note?: string;        // special requests
  tourist: UonTourist[];
}

interface UonCreateResponse {
  id?: number;
  result?: string;
  error?: string;
}

function toUonDate(isoDate: string): string {
  // 'YYYY-MM-DD' → 'DD.MM.YYYY'
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] ?? fullName, last: '' };
  const [first, ...rest] = parts;
  return { first: first ?? '', last: rest.join(' ') };
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
  // Опционально — для структурного лога синхронизации (не влияет на запрос к U-ON)
  operator_id?: string;
  booking_id?: string;
}

export async function createUonRequest(
  apiKey: string,
  booking: UonBookingInput,
): Promise<number | null> {
  const { first, last } = splitName(booking.tourist_name);

  const payload: UonCreateRequestPayload = {
    r_dat:       toUonDate(booking.booking_date),
    r_tour:      booking.tour_title,
    r_count_tur: booking.participants,
    r_price:     booking.total_price,
    r_note:      booking.special_requests ?? undefined,
    tourist: [{
      t_name:    first,
      t_surname: last || undefined,
      t_phone:   booking.tourist_phone ?? undefined,
      t_email:   booking.tourist_email ?? undefined,
    }],
  };

  const endpoint = 'request/create.json';
  const url = `${UON_BASE}/${encodeURIComponent(apiKey)}/${endpoint}`;
  const t0 = Date.now();
  let httpStatus: number | null = null;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
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
