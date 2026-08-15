/**
 * В полевом режиме нет коммерции.
 *
 * Активная навигация — режим, где рядом живут SOS, offline-предупреждения и
 * расстояние до следующей точки. Продажа тура рядом с SOS разрушает смысл
 * режима: человек в поле должен видеть только полевые действия — карту,
 * условия, группу, SOS.
 *
 * Сегодня OnTrailTab чист. Этот сторож закрепляет чистоту: коммерческий блок,
 * добавленный «на минутку» в полевой экран, — регрессия доверия, а не фича
 * (план Field Confidence Navigator, инвариант «Field focus»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

/** Полевой компонент: от объявления OnTrailTab до следующего компонента. */
function fieldSlice(): string {
  const start = src.indexOf('function OnTrailTab');
  const end = src.indexOf('function PlanningTab');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('полевой режим свободен от коммерции', () => {
  const field = fieldSlice();

  it.each([
    [/забронир/i, 'бронирование'],
    [/купить|покупк/i, 'покупка'],
    [/хочу тур/i, 'CTA «Хочу тур»'],
    [/аренд/i, 'аренда'],
    [/operator_tours|marketplace\/tours|\/catalog\b/, 'витрина туров'],
    [/LeadModal|PaymentModal|BookingForm/, 'модалки продажи'],
    [/base_price|₽\s*\/|от\s+\d+\s*₽/, 'цены'],
  ])('в OnTrailTab нет: %s (%s)', (pattern) => {
    expect(field).not.toMatch(pattern);
  });

  it('полевые действия на месте: SOS остаётся — и он общий, не свой', () => {
    // Раньше здесь стоял сырой tel:112 — копия SOS без офлайн-ветки.
    // Проверяем именно общий компонент: `tel:112` в файле есть и у листа
    // «Группа», и проверка на него проходила бы по случайной причине.
    expect(field).toMatch(/<EmergencyAction variant="field"/);
  });

  it('offline-предупреждение о несработавшем SW говорит словами', () => {
    // 0.1: отказ регистрации Service Worker больше не глотается — полевой
    // экран умеет сказать «офлайн недоступен» до выхода.
    expect(field).toContain('useSwRegistration');
  });
});
