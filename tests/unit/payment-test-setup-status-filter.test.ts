/**
 * Сторож: payment-test-setup не переиспользует отменённую бронь.
 *
 * ── Что случилось 30.08 ───────────────────────────────────────────────────
 *
 * Живой прогон нашёл дефект руками: повторный вызов искал незакрытую бронь
 * ТОЛЬКО по `paid_at IS NULL`, а `booking_status` не проверял. Бронь,
 * отменённая через abandoned-bookings (2-24ч без оплаты), тоже подходит под
 * это условие — и находилась вместо создания новой. Выпуск QR на неё честно
 * отвечал 404 «Бронирование не найдено», и это выглядело как поломка
 * маршрута выпуска QR, а не как переиспользование мёртвой строки: три
 * прогона потратились на то, чтобы отличить одно от другого.
 *
 * Оба места — WHERE NOT EXISTS перед INSERT и fallback SELECT — обязаны
 * исключать 'cancelled' СИММЕТРИЧНО: разойдись они, INSERT решит, что
 * живая бронь уже есть (NOT EXISTS ложно), а fallback её не найдёт
 * (SELECT её исключает) — и роут провалится с «бронь не создана и не
 * найдена», хотя достаточно было просто вставить новую строку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/payment-test-setup/route.ts'), 'utf-8');
// Судим КОД, не комментарии: разбор рядом с правкой вправе называть то же
// условие словами, не удваивая счёт.
const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('бронь для повторного использования — только незавершённая и не отменённая', () => {
  it('INSERT ... WHERE NOT EXISTS исключает cancelled', () => {
    const at = SRC.indexOf('INSERT INTO operator_bookings');
    expect(at).toBeGreaterThan(0);
    const block = SRC.slice(at, at + 700);
    expect(block).toMatch(/WHERE NOT EXISTS/);
    expect(block, 'INSERT снова готов молчать на отменённой брони')
      .toMatch(/booking_status NOT IN \('cancelled'\)/);
  });

  it('fallback SELECT исключает cancelled — тем же условием', () => {
    const at = SRC.indexOf('bookingRows[0]?.id');
    expect(at).toBeGreaterThan(0);
    const block = SRC.slice(at, at + 500);
    expect(block).toMatch(/SELECT id::text FROM operator_bookings/);
    expect(block, 'fallback снова может вернуть отменённую бронь')
      .toMatch(/booking_status NOT IN \('cancelled'\)/);
  });

  it('оба условия исключения cancelled — дословно одинаковые', () => {
    // Разные формулировки ('cancelled' vs status <> 'cancelled') дали бы
    // INSERT и SELECT разное представление о том, что значит «есть бронь» —
    // ровно та рассинхронизация, которую этот сторож и держит.
    const occurrences = [...CODE.matchAll(/booking_status NOT IN \('cancelled'\)/g)];
    expect(occurrences.length).toBe(2);
  });
});
