/**
 * Генерация .ics (RFC 5545) для брони туриста — кнопка «В календарь».
 * Инфраструктура календаря уже была у операторов (app/api/operator/calendar/
 * ical); тут — компактный переиспользуемый билдер под одно бронирование.
 * Чистые функции, без сети/БД.
 */

export function escapeIcs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Сворачивание длинных строк по 75 октетов (RFC 5545 §3.1). Упрощённо по
// символам — для ASCII/кириллицы в наших полях достаточно.
export function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const out: string[] = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    out.push(' ' + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest.length) out.push(' ' + rest);
  return out.join('\r\n');
}

function dateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export interface BookingIcsInput {
  id: string;
  tourName: string;
  date: string | Date;
  operatorName?: string | null;
  participants?: number | null;
}

/**
 * Однодневное (all-day) событие на дату брони. All-day, чтобы не врать про
 * точное время старта, которого в booking_date может не быть.
 */
export function buildBookingIcs(b: BookingIcsInput, now: Date = new Date()): string {
  const start = new Date(b.date);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const descParts = [
    b.operatorName ? `Оператор: ${b.operatorName}` : '',
    b.participants ? `Участников: ${b.participants}` : '',
    'Бронирование на Ведар (KamchatourHub)',
  ].filter(Boolean).map(escapeIcs);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KamchatourHub//Booking//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    foldLine(`UID:booking-${b.id}@vedarai.ru`),
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${dateOnly(start)}`,
    `DTEND;VALUE=DATE:${dateOnly(end)}`,
    foldLine(`SUMMARY:${escapeIcs(b.tourName)}`),
    foldLine(`DESCRIPTION:${descParts.join('\\n')}`),
    'LOCATION:Камчатка',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
