import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextBookingStep, bookingFormUrl, BOOKING_CONSENT_LINE } from '@/lib/kuzmich/core';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

describe('заявка Кузьмича в MAX/Telegram (01.11)', () => {
  it('дата и люди из реплики пропускают шаги', () => {
    expect(nextBookingStep({ step: 'name', started_at: 0, name: 'Анна' })).toBe('date');
    expect(nextBookingStep({ step: 'name', started_at: 0, name: 'Анна', date: '2027-07-15' })).toBe('participants');
    expect(nextBookingStep({ step: 'name', started_at: 0, name: 'Анна', date: '2027-07-15', participants: 2 })).toBe('phone');
  });
  it('Telegram ведёт на форму тура с датой и людьми, без ПД в чате', () => {
    const url = bookingFormUrl({ id: 7, title: 'T', base_price: null, multi_day_count: null, slug: 'kurilskoe' }, '2027-07-15', 2);
    expect(url).toMatch(/\/catalog\/tours\/kurilskoe\?date=2027-07-15&guests=2#booking$/);
    expect(read('lib/kuzmich/core.ts')).toMatch(/Имя и телефон в Telegram не принимаю/);
  });
  it('согласие на ПД и штатная формулировка успеха', () => {
    expect(BOOKING_CONSENT_LINE).toMatch(/обработку персональных данных/);
    const core = read('lib/kuzmich/core.ts');
    expect(core).toMatch(/`Заявка создана\. Номер/);
    expect(core).toMatch(/не мгновенная бронь и не сбой/);
    expect(core).not.toMatch(/Заявка отправлена оператору\. Номер/);
  });
  it('MAX «Оформить заявку» запускает заявку в чате, а не голый лид', () => {
    const route = read('app/api/max/kuzmich/route.ts');
    expect(route).not.toMatch(/CONTACT_REQUEST_BUTTONS/);
    expect(read('lib/kuzmich/answer-quality.ts')).not.toMatch(/Сам я заявку не отправляю/);
  });
});
