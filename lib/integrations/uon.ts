/**
 * U-ON.Travel CRM integration
 *
 * Docs: https://api.u-on.ru/
 * Operator sets uon_api_key in their partner profile.
 * On booking creation: POST /request/create.json → get request_id → store on operator_bookings.
 */

const UON_BASE = 'https://api.u-on.ru';
const TIMEOUT_MS = 10_000;

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

  const url = `${UON_BASE}/${encodeURIComponent(apiKey)}/request/create.json`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`U-ON HTTP ${res.status}`);
  }

  const data = await res.json() as UonCreateResponse;

  if (data.error) throw new Error(`U-ON error: ${data.error}`);

  return data.id ?? null;
}
