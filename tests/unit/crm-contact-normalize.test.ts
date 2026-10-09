/**
 * Склейка клиента партнёра (CRM #2325): ключи и их порядок.
 *
 * Один человек приходит к партнёру разными записями: «8 (914) …» в брони,
 * «+7 914 …» в лиде, почтой без телефона в заказе. Если ключи нормализуются
 * по-разному, партнёр видит двух незнакомцев вместо одного клиента. Порядок
 * ключей — телефон, почта, аккаунт: для связи телефон и есть личность.
 */
import { describe, it, expect } from 'vitest';
import {
  isSourceKind, isValidSourceId, keyKind, normalizeEmail, normalizeName, normalizePhoneKey, personKey,
} from '@/lib/crm/contacts';
import { buildContactSearch, likeEscape } from '@/lib/crm/contact-queries';

describe('телефон как ключ', () => {
  it('российские написания одного номера дают один ключ', () => {
    for (const raw of ['8 (914) 111-22-33', '+7 914 111 22 33', '89141112233', '79141112233', '914 111-22-33']) {
      expect(normalizePhoneKey(raw), raw).toBe('+79141112233');
    }
  });

  it('не номер — не ключ', () => {
    for (const raw of ['', '   ', '12', 'привет', null, undefined]) {
      expect(normalizePhoneKey(raw as string | null | undefined)).toBeNull();
    }
  });
});

describe('почта как ключ', () => {
  it('регистр и пробелы не делают второго человека', () => {
    expect(normalizeEmail('  Anna@Mail.RU ')).toBe('anna@mail.ru');
  });

  it('не адрес — не ключ', () => {
    for (const raw of ['', 'anna', 'anna@', '@mail.ru', 'an na@mail.ru', null]) {
      expect(normalizeEmail(raw as string | null)).toBeNull();
    }
  });
});

describe('имя', () => {
  it('пробелы схлопываются, пустое — NULL, а не «Без имени»', () => {
    expect(normalizeName('  Анна   Петрова ')).toBe('Анна Петрова');
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName('я'.repeat(300))).toHaveLength(200);
  });
});

describe('порядок ключей', () => {
  const k = (row: { phone?: string | null; email?: string | null; user_id?: string | null }) =>
    keyKind(personKey({ person_name: 'Анна', phone: null, email: null, user_id: null, ...row }));

  it('телефон → почта → аккаунт → нечем склеивать', () => {
    expect(k({ phone: '+79141112233', email: 'a@b.ru', user_id: 'u' })).toBe('phone');
    expect(k({ email: 'a@b.ru', user_id: 'u' })).toBe('email');
    expect(k({ user_id: 'u' })).toBe('user');
    expect(k({})).toBe('none');
  });

  it('нечитаемый телефон ключом не становится, но сам телефон сохраняется', () => {
    const key = personKey({ person_name: null, phone: ' 12 ', email: 'a@b.ru', user_id: null });
    expect(key).toMatchObject({ phone: '12', phoneE164: null, emailNorm: 'a@b.ru' });
    expect(keyKind(key)).toBe('email');
  });
});

describe('id источника', () => {
  it('бронь тура — число, остальные — uuid; остальное не доходит до SQL', () => {
    expect(isValidSourceId('operator_booking', '12345')).toBe(true);
    expect(isValidSourceId('operator_booking', '1; DROP TABLE x')).toBe(false);
    expect(isValidSourceId('lead', '00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isValidSourceId('lead', '12345')).toBe(false);
  });

  it('вид источника — только из закрытого списка', () => {
    expect(isSourceKind('operator_booking')).toBe(true);
    expect(isSourceKind('tour_seat_request')).toBe(false);
    expect(isSourceKind('manual')).toBe(false);
  });
});

describe('поиск в списке клиентов', () => {
  it('четыре и больше цифр — хвост телефона, иначе имя и почта', () => {
    expect(buildContactSearch('11-22-33')).toEqual({ name: null, phone: '%112233%' });
    expect(buildContactSearch('Анна')).toEqual({ name: '%анна%', phone: null });
    expect(buildContactSearch('123')).toEqual({ name: '%123%', phone: null });
    expect(buildContactSearch('  ')).toEqual({ name: null, phone: null });
  });

  it('% и _ из запроса — буквы, а не шаблон', () => {
    expect(likeEscape('50%_x')).toBe('50\\%\\_x');
    expect(buildContactSearch('%')).toEqual({ name: '%\\%%', phone: null });
  });
});
