/**
 * План устарел, если анкету поправили после сборки (разбор планера 14.11,
 * экран-1). Правило — вызовом, баннер — рендером (CLAUDE.md §4).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { planStaleReasons, planStaleText, type PlanSnapshot } from '@/lib/planner/plan-stale';
import { PlanStaleNotice } from '@/components/planner/PlanStaleNotice';

afterEach(() => { cleanup(); });

const BUILT: PlanSnapshot = {
  arrival: '2030-08-01', departure: '2030-08-05', adults: 2, children: [6], tripOrigin: 'visitor',
  interests: ['volcano', 'bears'], budgetTier: 'comfort',
};

describe('что изменилось после сборки', () => {
  it('ничего — план в силе; порядок занятий и детей не важен', () => {
    expect(planStaleReasons(BUILT, { ...BUILT, interests: ['bears', 'volcano'], children: [6] })).toEqual([]);
  });

  it('прогон разбора: даты 10–20.09 и 6 взрослых — «даты» и «состав группы»', () => {
    const r = planStaleReasons(BUILT, { ...BUILT, arrival: '2030-09-10', departure: '2030-09-20', adults: 6 });
    expect(r).toEqual(['даты', 'состав группы']);
    expect(planStaleText(r)).toBe('После сборки плана изменились даты и состав группы — план собран на прежние. Пересоберите план, чтобы дни, туры и заявка были на то, что в анкете.');
  });

  it('занятия, откуда едете, уровень жилья, дети', () => {
    expect(planStaleReasons(BUILT, { ...BUILT, interests: ['volcano'] })).toEqual(['занятия']);
    expect(planStaleReasons(BUILT, { ...BUILT, tripOrigin: 'local' })).toEqual(['откуда едете']);
    expect(planStaleReasons(BUILT, { ...BUILT, budgetTier: 'economy' })).toEqual(['уровень жилья']);
    expect(planStaleReasons(BUILT, { ...BUILT, children: [6, 9] })).toEqual(['состав группы']);
  });
});

describe('баннер на экране', () => {
  it('нет расхождений — баннера нет', () => {
    render(<PlanStaleNotice reasons={[]} onRebuild={() => {}} />);
    expect(screen.queryByTestId('plan-stale')).toBeNull();
  });

  it('есть — сказано что, и «Пересобрать план» пересобирает', () => {
    const onRebuild = vi.fn();
    render(<PlanStaleNotice reasons={['даты']} onRebuild={onRebuild} />);
    expect(screen.getByTestId('plan-stale').textContent).toContain('После сборки плана изменились даты');
    fireEvent.click(screen.getByRole('button', { name: 'Пересобрать план' }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });
});
