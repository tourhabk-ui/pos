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
 *
 * Правка 26.09 (пакет «бронь жилья: оплата на месте, доступность»):
 * - занятость в book считается по НОЧАМ единой формулой
 *   (lib/stay/availability.ts: roomNightsSql) вместо «COUNT(*) as bookings»
 *   по пересечению окна — сторож проверяет, что формула позвана внутри
 *   транзакции, до INSERT;
 * - платёж book-роутом больше не создаётся ВОВСЕ (оплата жилья на месте,
 *   решение владельца 26.09) — сторож «URL платежа от запроса» для жилья
 *   заменён на «платежа нет»;
 * - каталог зовёт ту же формулу, что book, — сторож сверяет вызов, а не
 *   прежний текст подзапроса.
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
    expect(txBlock).toContain('roomNightsSql(');
    expect(txBlock).toContain('INSERT INTO accommodation_bookings');
    expect(txBlock.indexOf('roomNightsSql(')).toBeLessThan(txBlock.indexOf('INSERT INTO accommodation_bookings'));
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
  it('жильё: платёж не создаётся вовсе — оплата на месте (26.09)', () => {
    expect(BOOK).not.toContain('http://127.0.0.1');
    expect(BOOK).not.toContain('/api/payments/create');
  });

  it('туры: тот же фикс', () => {
    expect(TOURS_BOOK).not.toContain('http://127.0.0.1');
    expect(TOURS_BOOK).toContain("new URL('/api/payments/create', request.url)");
  });
});

describe('листинг: колонки с префиксом, JOIN не даёт ambiguous', () => {
  it('условия и сортировка — через a.', () => {
    // Витрина — is_active И одобрение администратора (миграция 1027): одно
    // условие из lib/stay/moderation, с префиксом a.
    expect(LIST).toContain("publicAccommodationSql('a')");
    expect(LIST).toContain('a.name ILIKE');
    expect(LIST).toContain('a.rating >=');
    // Проверяется ПРЕФИКС, ради которого сторож и писался (без него JOIN
    // даёт ambiguous), а не точная строка сортировки целиком. 20.09 к ней
    // добавилось NULLS LAST — пустая цена при убывании вставала БЕЗ него
    // первой и читалась туристом как «самое дорогое» (миграция 1006). Смысл
    // сторожа от этого не изменился, буква изменилась; пришпиленная буква
    // краснеет на правке, которая её не касается.
    expect(LIST).toMatch(/rating_desc: 'a\.rating DESC[^']*, a\.review_count DESC'/);
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

  it('семантика занятости — та же, что в book-роуте (одна формула по ночам)', () => {
    expect(LIST).toContain("import { roomNightsSql } from '@/lib/stay/availability'");
    expect(LIST).toContain("roomNightsSql({ accommodation: 'a.id'");
    expect(LIST).toContain('HAVING bool_and(NOT rn.blocked AND rn.free_units > 0)');
    expect(BOOK).toContain('roomNightsSql(');
  });

  it('даты доходят до разбора — до 26.09 фильтр был написан, но check_in не передавался', () => {
    expect(LIST).toContain("check_in: paramOrUndefined(searchParams, 'check_in')");
    expect(LIST).toContain("check_out: paramOrUndefined(searchParams, 'check_out')");
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
