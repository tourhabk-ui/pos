/**
 * Экран планировщика говорит, что дня на возвращение из дальней зоны нет,
 * после правки на экране (разбор планера 14.11, экран-4). Рендером.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { PlanReturnWarning } from '@/components/planner/PlanReturnWarning';
import { returnLegMissingMessage } from '@/lib/planner/plan-edit-warnings';

afterEach(() => { cleanup(); });

type Z = 'avachinsky' | 'western' | 'eastern' | 'northern';
const d = (day: number, type: string, zone: Z) => ({ day, type, zone });

describe('нет дня на возвращение', () => {
  it('после «Возвращения» добавлен день в Восточной зоне — строка на экране', () => {
    const days = [d(1, 'arrival', 'avachinsky'), d(2, 'travel', 'avachinsky'), d(3, 'activity', 'eastern'), d(4, 'travel', 'avachinsky'), d(5, 'activity', 'eastern'), d(6, 'departure', 'avachinsky')];
    render(<PlanReturnWarning days={days} origin="visitor" shown={[]} />);
    expect(screen.getByTestId('plan-return-warning').textContent).toBe(returnLegMissingMessage('eastern', 'visitor'));
  });

  it('план кончается в городе — строки нет', () => {
    render(<PlanReturnWarning days={[d(1, 'arrival', 'avachinsky'), d(2, 'activity', 'eastern'), d(3, 'travel', 'avachinsky'), d(4, 'departure', 'avachinsky')]} origin="visitor" shown={[]} />);
    expect(screen.queryByTestId('plan-return-warning')).toBeNull();
  });

  it('та же строка уже есть в предупреждениях движка — второй раз не встаёт', () => {
    const days = [d(1, 'activity', 'western'), d(2, 'departure', 'avachinsky')];
    render(<PlanReturnWarning days={days} origin="visitor" shown={[returnLegMissingMessage('western', 'visitor')]} />);
    expect(screen.queryByTestId('plan-return-warning')).toBeNull();
  });
});
