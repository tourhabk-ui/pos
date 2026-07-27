/**
 * Раздел «Аналитика» в админке падал в error.tsx с самого своего появления.
 *
 * Причина не в данных и не в сети: страница читала `data.charts.revenueByMonth`,
 * `bookingsByCategory` и `userGrowth`, а `/api/admin/dashboard` клал в `charts`
 * только `topTours`. `.map` по undefined — TypeError при рендере, его ловил
 * сегментный error.tsx, и весь /hub/admin показывал «Ошибка в разделе
 * "Администратор"». TypeScript промолчал: `res.json()` возвращает `any`, и
 * объявленный на странице интерфейс ни с чем не сверялся.
 *
 * Отсюда два инварианта ниже: (1) контракт сходится — каждое поле charts,
 * которое читает страница, эндпоинт реально отдаёт; (2) страница читает
 * защитно, чтобы будущее расхождение давало пустой график, а не белый экран
 * во всей админке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PAGE = read('app/hub/admin/analytics/page.tsx');
const ROUTE = read('app/api/admin/dashboard/route.ts');

/** Поля charts, которые страница действительно читает. */
function chartFieldsReadByPage(): string[] {
  const found = new Set<string>();
  for (const m of PAGE.matchAll(/charts\.([a-zA-Z_][\w]*)/g)) found.add(m[1]);
  return [...found];
}

/** Поля charts, которые эндпоинт кладёт в ответ. */
function chartFieldsServed(): string[] {
  const block = ROUTE.match(/charts:\s*\{([\s\S]*?)\n      \},/)?.[1] ?? '';
  const found = new Set<string>();
  for (const m of block.matchAll(/^\s{8}([a-zA-Z_][\w]*):/gm)) found.add(m[1]);
  return [...found];
}

describe('контракт /api/admin/dashboard ↔ страница аналитики', () => {
  it('страница читает непустой набор полей charts', () => {
    expect(chartFieldsReadByPage().length).toBeGreaterThan(0);
  });

  it('эндпоинт отдаёт непустой набор полей charts', () => {
    expect(chartFieldsServed().length).toBeGreaterThan(0);
  });

  it('каждое читаемое поле charts реально отдаётся эндпоинтом', () => {
    const served = chartFieldsServed();
    for (const field of chartFieldsReadByPage()) {
      expect(served, `charts.${field} читается страницей, но не отдаётся API`).toContain(field);
    }
  });

  it('три графика, из-за которых падал раздел, на месте', () => {
    const served = chartFieldsServed();
    for (const field of ['revenueByMonth', 'bookingsByCategory', 'userGrowth']) {
      expect(served, `нет ${field}`).toContain(field);
    }
  });
});

describe('страница не роняет админку при расхождении контракта', () => {
  it('ряды графиков читаются с фолбэком на пустой массив', () => {
    for (const field of ['revenueByMonth', 'bookingsByCategory', 'userGrowth', 'topTours']) {
      expect(PAGE, `${field} читается без ?? []`).toMatch(
        new RegExp(`charts\\.${field}\\s*\\?\\?\\s*\\[\\]`),
      );
    }
  });

  it('нет прямого data.charts.X.map — именно он ронял раздел', () => {
    expect(PAGE).not.toMatch(/data\.charts\.\w+\.(map|slice)\(/);
  });
});
