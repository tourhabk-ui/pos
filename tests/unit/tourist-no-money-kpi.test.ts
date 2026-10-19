import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// До марта 2027 оплат нет: кабинет туриста не показывает денежных итогов
// (аудит кабинета туриста 20.10).
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('кабинет туриста без денежных итогов', () => {
  it('обзор: нет плитки «Потрачено», уровень не пустой', () => {
    const src = read('app/hub/tourist/_TouristDashboardClient.tsx');
    expect(src).not.toMatch(/label: 'Потрачено'/);
    expect(src).toMatch(/'Новичок'/);
  });
  it('эко и бонусы: суммы заказов и рубли уровней скрыты флагом', () => {
    const src = read('app/hub/tourist/loyalty/_LoyaltyClient.tsx');
    expect(src).toMatch(/export const SHOW_MONEY = false;/);
    expect(src).not.toMatch(/'Сумма заказов'/);
    expect(src).not.toMatch(/от суммы заказа/);
    expect(src).toMatch(/SHOW_MONEY && nextLevel/);
    expect(src).toMatch(/SHOW_MONEY && <th/);
  });
});
