/**
 * «Свободные даты» в календаре оператора читают список туров той формой,
 * которой роут его отдаёт (#1796).
 *
 * `GET /api/hub/operator/tours` отвечает `{ success, data: Tour[], pagination }`;
 * панель читала `data.tours`, получала [] и каждому оператору говорила «нет
 * активных туров» — панель была мертва с момента написания. Здесь держится:
 * панель проверяет, что `data` — массив; отказ запроса — отдельное состояние
 * с повтором, не «туров нет» (§4.0); пустота ведёт к созданию тура.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('панель свободных дат (#1796)', () => {
  const panel = read('app/hub/operator/calendar/_FreeDatesPanel.tsx');
  const route = read('app/api/hub/operator/tours/route.ts');

  it('роут отдаёт массив в data — и панель ждёт именно массив', () => {
    expect(route).toMatch(/data: data\.rows/);
    expect(panel).toMatch(/Array\.isArray\(toursJson\.data\)/);
    expect(panel).not.toMatch(/data\?\.tours/);
  });

  it('три исхода: ошибка загрузки — своё состояние с «Повторить», не пустой список', () => {
    expect(panel).toMatch(/setLoadError\(/);
    expect(panel).toMatch(/console\.error\('\[free-dates\] покрытие дат не загружено:'/);
    expect(panel).toMatch(/\) : loadError \? \(/);
    expect(panel).toMatch(/Повторить/);
    // Отказ второго запроса (покрытие) тоже не глушится.
    expect(panel).toMatch(/!coverageRes\.ok \|\| !coverageJson\.success/);
  });

  it('пустота честная и ведёт к делу: «туров нет» + ссылка на создание тура', () => {
    expect(panel).toMatch(/Активных туров пока нет/);
    expect(panel).toMatch(/href="\/hub\/operator\/tours\/new"/);
  });

  it('id туров и покрытия сравниваются как строки (bigint приходит строкой, tourId — числом)', () => {
    expect(panel).toMatch(/id: String\(t\.id\)/);
    expect(panel).toMatch(/tourId: String\(a\.tourId\)/);
  });
});
