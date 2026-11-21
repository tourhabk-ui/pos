/**
 * «Собрать план» на главной (21.11): гость — в план в чате Кузьмича, а не на
 * экран входа планера; вошедший — в /planner. Кузьмич — в меню шапки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planEntryHref, GUEST_PLAN_ASK } from '@/lib/planner/plan-entry';
import { HEADER_NAV } from '@/components/layout/Header';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('вход в план с главной', () => {
  it('гость и «не знаем» — чат Кузьмича с готовым вопросом', () => {
    for (const authed of [false, null]) {
      const href = planEntryHref(authed);
      expect(href.startsWith('/kuzmich?ask=')).toBe(true);
      expect(decodeURIComponent(href.split('ask=')[1])).toBe(GUEST_PLAN_ASK);
    }
  });

  it('вошедший — планер', () => {
    expect(planEntryHref(true)).toBe('/planner');
  });

  it('кнопки главной не ведут гостя прямо на /planner', () => {
    const desk = read('components/homepage/desk/DeskHero.tsx');
    expect(desk).toMatch(/PlanEntryLink[\s\S]*?Собрать план[\s\S]*?\/PlanEntryLink>/);
    expect(desk).not.toMatch(/href="\/planner"/);
    const mobile = read('app/_home/_HomeV8Client.tsx');
    expect(mobile).not.toMatch(/href="\/planner"/);
  });

  it('Кузьмич — пункт меню шапки', () => {
    expect(HEADER_NAV).toContainEqual({ href: '/kuzmich', label: 'Кузьмич' });
  });
});
