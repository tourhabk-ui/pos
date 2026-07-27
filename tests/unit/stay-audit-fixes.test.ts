/**
 * Аудит домена Stay 27.07 — сторожа четырёх дефектов и поиска по датам.
 *
 * 1. Гонка овербукинга: COUNT занятости и INSERT брони шли отдельными
 *    запросами без блокировки — две одновременные брони последнего номера
 *    проходили обе. Теперь транзакция + pg_advisory_xact_lock по номеру.
 * 2. Письмо гостю врало «Ваше бронирование подтверждено!» при status=pending.
 * 3. Платёж создавался fetch-ем на 127.0.0.1:3001 (мимо прод-порта) — без
 *    env-переменной создание платежа молча падало на каждой брони.
 * 4. Листинг: WHERE/ORDER BY без префикса a. при JOIN partners — фильтры
 *    search/rating_min падали «column reference is ambiguous».
 * 5. Поиск по датам в каталоге — той же семантикой занятости, что book-роут.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const BOOK = read('app/api/accommodations/[id]/book/route.ts');
const TOURS_BOOK = read('app/api/tours/[id]/book/route.ts');
const LIST = read('app/api/accommodations/route.ts');
const FORM = read('components/booking/StayBookingForm.tsx');
const CLIENT = read('app/accommodations/_AccommodationsClient.tsx');

describe('бронь жилья без гонки', () => {
  it('проверка занятости и INSERT — в транзакции под advisory-lock', () => {
    expect(BOOK).toContain('pg_advisory_xact_lock');
    expect(BOOK).toContain('transaction(');
    // Проверка и вставка живут внутри одного transaction-колбэка.
    const txBlock = BOOK.match(/transaction\(async \(client\) => \{[\s\S]*?\n    \}\);/)?.[0] ?? '';
    expect(txBlock).toContain('COUNT(*) as bookings');
    expect(txBlock).toContain('INSERT INTO accommodation_bookings');
  });
});

describe('честное письмо гостю', () => {
  it('жильё: pending-бронь не называется подтверждённой', () => {
    expect(BOOK).not.toContain('подтверждено!');
    expect(BOOK).toContain('Заявка на бронирование принята');
    expect(BOOK).toContain('Владелец объекта подтвердит');
  });

  it('туры: тот же класс лжи убран', () => {
    expect(TOURS_BOOK).not.toContain('подтверждено!');
    expect(TOURS_BOOK).toContain('Заявка на бронирование принята');
  });
});

describe('платёжный URL — от текущего запроса', () => {
  it('жильё: нет фолбэка на 127.0.0.1:3001', () => {
    expect(BOOK).not.toContain('http://127.0.0.1');
    expect(BOOK).toContain("new URL('/api/payments/create', request.url)");
  });

  it('туры: тот же фикс', () => {
    expect(TOURS_BOOK).not.toContain('http://127.0.0.1');
    expect(TOURS_BOOK).toContain("new URL('/api/payments/create', request.url)");
  });
});

describe('листинг: колонки с префиксом, JOIN не даёт ambiguous', () => {
  it('условия и сортировка — через a.', () => {
    expect(LIST).toContain('a.is_active = true');
    expect(LIST).toContain('a.name ILIKE');
    expect(LIST).toContain('a.rating >=');
    expect(LIST).toContain("rating_desc: 'a.rating DESC, a.review_count DESC'");
  });

  it('count-запрос использует тот же алиас', () => {
    expect(LIST).toContain('FROM accommodations a ${whereClause}');
  });
});

describe('поиск по датам в каталоге', () => {
  it('схема принимает check_in/check_out и требует пару', () => {
    expect(LIST).toContain('check_in:');
    expect(LIST).toContain('check_out:');
    expect(LIST).toContain('нужны обе даты, выезд — позже заезда');
  });

  it('семантика занятости — та же, что в book-роуте (пересечение броней + блок календаря)', () => {
    expect(LIST).toContain('generate_series');
    expect(LIST).toContain("b.status NOT IN ('cancelled')");
    expect(LIST).toContain('av.is_blocked');
    expect(LIST).toContain('HAVING COUNT(*) >= r.available_rooms');
  });

  it('клиент шлёт даты только валидной парой', () => {
    expect(CLIENT).toContain("p.set('check_in'");
    expect(CLIENT).toMatch(/checkIn && currentFilters\.checkOut && currentFilters\.checkOut > currentFilters\.checkIn/);
  });
});

describe('ссылка «Войти» ведёт на существующую страницу', () => {
  it('/auth/login, а не несуществующий /login', () => {
    expect(FORM).toContain('href="/auth/login"');
    expect(FORM).not.toContain('href="/login"');
  });
});
