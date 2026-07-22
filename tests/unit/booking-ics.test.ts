import { describe, it, expect } from 'vitest';
import { buildBookingIcs, escapeIcs, foldLine } from '@/lib/calendar/ics';

const now = new Date('2026-07-22T10:00:00.000Z');

describe('escapeIcs — экранирование спецсимволов RFC 5545', () => {
  it('экранирует ; , \\ и перевод строки', () => {
    expect(escapeIcs('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });
});

describe('foldLine', () => {
  it('короткую строку не трогает', () => {
    expect(foldLine('SUMMARY:тур')).toBe('SUMMARY:тур');
  });
  it('длинную сворачивает с продолжением через CRLF + пробел', () => {
    const folded = foldLine('X'.repeat(200));
    expect(folded).toContain('\r\n ');
    // развернём обратно — должно совпасть с исходником
    expect(folded.replace(/\r\n /g, '')).toBe('X'.repeat(200));
  });
});

describe('buildBookingIcs', () => {
  const ics = buildBookingIcs({
    id: 'abc-123',
    tourName: 'Восхождение на Авачинский',
    date: '2026-08-01',
    operatorName: 'Камчатка Тур',
    participants: 2,
  }, now);

  it('валидный каркас VCALENDAR/VEVENT', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('UID:booking-abc-123@vedarai.ru');
  });

  it('all-day событие: DTSTART на дату брони, DTEND — следующий день', () => {
    expect(ics).toContain('DTSTART;VALUE=DATE:20260801');
    expect(ics).toContain('DTEND;VALUE=DATE:20260802');
  });

  it('SUMMARY = название тура, DESCRIPTION с оператором и участниками', () => {
    expect(ics).toContain('SUMMARY:Восхождение на Авачинский');
    expect(ics).toContain('Оператор: Камчатка Тур');
    expect(ics).toContain('Участников: 2');
  });

  it('строки разделены CRLF', () => {
    expect(ics.includes('\r\n')).toBe(true);
  });
});
