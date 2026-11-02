import { describe, it, expect } from 'vitest';
import { bookingContact } from '@/lib/admin/booking-contact';
import { formatKamchatkaDate } from '@/lib/admin/kamchatka-date';
import { isTestTouristName } from '@/lib/bookings/test-booking';

describe('bookingContact — контакт брони без аккаунта', () => {
  it('без аккаунта берёт имя и почту из брони, телефон маской', () => {
    const c = bookingContact({ user_name: null, user_email: null, tourist_name: 'Иван', tourist_email: 'i@x.ru', tourist_phone: '+7 999 123-45-67' });
    expect(c).toEqual({ name: 'Иван', email: 'i@x.ru', phoneMasked: '***67', hasAccount: false });
  });
  it('аккаунт важнее полей брони', () => {
    const c = bookingContact({ user_name: 'Акк', user_email: 'a@x.ru', tourist_name: 'Иван', tourist_email: 'i@x.ru' });
    expect(c.name).toBe('Акк'); expect(c.email).toBe('a@x.ru'); expect(c.hasAccount).toBe(true);
  });
  it('«Гость» — только когда имени нет нигде', () => {
    expect(bookingContact({ tourist_name: '  ' }).name).toBe('Гость');
  });
  it('полный телефон не утекает', () => {
    expect(JSON.stringify(bookingContact({ tourist_phone: '+79991234567' }))).not.toContain('9991234567');
  });
});

describe('formatKamchatkaDate', () => {
  it('момент создания — по Камчатке (01.11 09:31Z → 01.11, 13:00Z → 02.11)', () => {
    expect(formatKamchatkaDate('2026-11-01T09:31:55Z')).toBe('01.11.2026');
    expect(formatKamchatkaDate('2026-11-01T13:00:00Z')).toBe('02.11.2026');
  });
  it('календарная дата тура не сдвигается', () => {
    expect(formatKamchatkaDate('2026-11-15')).toBe('15.11.2026');
  });
  it('пусто — прочерк', () => { expect(formatKamchatkaDate(null)).toBe('—'); });
});

describe('isTestTouristName', () => {
  it.each(['ТЕСТ Кузьмич (не звонить)', 'тест', 'Test agent'])('%s — тест', (n) => expect(isTestTouristName(n)).toBe(true));
  it.each(['Тестов Пётр', 'Иван', null, ''])('%s — не тест', (n) => expect(isTestTouristName(n as string | null)).toBe(false));
});
