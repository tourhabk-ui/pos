/**
 * Сторож: список броней оператора не падает от отсутствующего параметра, а
 * его отказ не молчит.
 *
 * ── Что нашлось 27.09 (сквозная проверка «турист сделал — партнёр увидел») ──
 *
 * `GET /api/hub/operator/bookings` без `?limit=` отвечал **500**. Замер:
 *
 *   ''                 → HTTP 500
 *   '?limit=20'        → HTTP 200
 *   '?offset=0'        → HTTP 500
 *
 * Причина — `Number(null) = 0`. `searchParams.get()` отдаёт `null`, когда
 * параметра нет; `z.coerce.number()` превращает его в ноль; `.default(20)`
 * срабатывает только на `undefined`. Ноль не проходит `.min(1)`, Zod бросает,
 * и ошибка РАЗБОРА ПАРАМЕТРОВ выдавалась за поломку сервера.
 *
 * Тот же «Number(null) = 0», что стоил платформе нулевой комиссии в разборе
 * денежного пути 11.09 (CLAUDE.md §7).
 *
 * ── Почему это не нашлось раньше ──────────────────────────────────────────
 *
 * Экран кабинета зовёт роут С параметрами (`limit` и `offset` ставит
 * `_BookingsManagementClient`), поэтому оператор список видел и жалоб не было.
 * А `catch` не писал НИ СТРОКИ: в логе стояло только «GET ... 500», и причину
 * нельзя было узнать ниоткуда. Сканер тихих catch
 * (`tests/unit/silent-catch-guard.test.ts`) этот случай не ловит: он ищет
 * ПУСТОЙ ответ, а здесь возвращался 500 с текстом — то есть форма «ответ есть,
 * диагностики нет» проходила мимо него.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Отсутствие параметра — это умолчание, мусор в параметре — 400 с внятным
 * текстом, и любой отказ называет себя в логе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PaginationSchema } from '@/lib/api/operator-tours';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/hub/operator/bookings/route.ts');
const CLIENT = read('app/hub/operator/bookings/_BookingsManagementClient.tsx');

describe('отсутствующий параметр — это умолчание', () => {
  it('null (так отдаёт searchParams.get) даёт умолчание, а не ноль', () => {
    const p = PaginationSchema.parse({ limit: null, offset: null });
    expect(p.limit).toBe(20);
    expect(p.offset).toBe(0);
  });

  it('пустая строка — тоже умолчание', () => {
    // `?limit=` в адресе даёт именно её.
    expect(PaginationSchema.parse({ limit: '', offset: '' }).limit).toBe(20);
  });

  it('undefined — умолчание, как и было', () => {
    expect(PaginationSchema.parse({}).limit).toBe(20);
  });

  it('число строкой по-прежнему принимается', () => {
    const p = PaginationSchema.parse({ limit: '50', offset: '100' });
    expect(p.limit).toBe(50);
    expect(p.offset).toBe(100);
  });

  it('мусор и выход за границы по-прежнему ОТВЕРГАЮТСЯ', () => {
    // Умолчание не должно превратиться в «принимаем что угодно».
    expect(() => PaginationSchema.parse({ limit: 'abc' })).toThrow();
    expect(() => PaginationSchema.parse({ limit: '0' })).toThrow();
    expect(() => PaginationSchema.parse({ limit: '101' })).toThrow();
    expect(() => PaginationSchema.parse({ offset: '-1' })).toThrow();
  });
});

describe('отказ называет себя', () => {
  it('неверный параметр — 400, а не 500', () => {
    expect(ROUTE).toMatch(/error instanceof z\.ZodError/);
    expect(ROUTE).toMatch(/status: 400/);
  });

  it('оба catch пишут в лог имя и SQLSTATE', () => {
    const at = ROUTE.indexOf("console.error(`[hub/operator/bookings] список не отдан");
    expect(at, 'отказ списка снова молчит').toBeGreaterThan(0);
    expect(ROUTE).toMatch(/\[hub\/operator\/bookings\] ручная бронь не заведена/);
    expect((ROUTE.match(/SQLSTATE/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('текст отказа параметров — по-русски и про параметры', () => {
    // «Failed to fetch bookings» на неверный limit звучит как поломка сервера.
    expect(ROUTE).toMatch(/Неверные параметры списка/);
  });
});

describe('экран кабинета по-прежнему просит страницу явно', () => {
  it('клиент передаёт limit и offset', () => {
    // Умолчание — страховка, а не замена: страницы в списке считает клиент.
    expect(CLIENT).toMatch(/limit: LIMIT\.toString\(\)/);
    expect(CLIENT).toMatch(/offset: \(\(page - 1\) \* LIMIT\)\.toString\(\)/);
  });
});
