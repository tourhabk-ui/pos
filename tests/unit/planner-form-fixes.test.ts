/**
 * Форма планера — три дефекта со снимков владельца 26.09.
 *
 * 1. «Некорректные параметры» на последнем шаге: сервер принимал не больше
 *    12 интересов, а чипов в форме 14 — отметивший почти всё получал отказ,
 *    и слова отказа не называли причину.
 * 2. Дни отдыха стояли нулём, пока их не нажали: «должны считаться от дат
 *    прилёта и отлёта, но с возможностью корректировки».
 * 3. Выбранный «Режим маршрутов» — сплошная плашка без текста: `bg-opacity-20`
 *    не действует на цвет из CSS-переменной, фон и текст совпадали.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { suggestRestDays, REST_EVERY_DAYS } from '@/lib/planner/travel-style';
import { INTERESTS_MAX, describeRecommendError } from '@/lib/planner/recommend-errors';

const CLIENT = readFileSync('app/planner/_PlannerClient.tsx', 'utf-8');
const ROUTE = readFileSync('app/api/planner/recommend/route.ts', 'utf-8');

function chipCount(name: string): number {
  const block = new RegExp(`const ${name}(?::[^=]+)? = \\[([\\s\\S]*?)\\];`).exec(CLIENT)?.[1] ?? '';
  return (block.match(/\{ id: '/g) ?? []).length;
}

describe('интересы: форма не просит того, что отвергает сервер', () => {
  it('потолок не меньше числа всех чипов формы', () => {
    const chips = chipCount('PLACES') + chipCount('ACTIVITIES');
    expect(chips).toBeGreaterThanOrEqual(10);
    expect(INTERESTS_MAX).toBeGreaterThanOrEqual(chips);
    expect(ROUTE).toMatch(/interests: z\.array\(z\.string\(\)\.max\(40\)\)\.min\(1\)\.max\(INTERESTS_MAX\)/);
  });

  it('отказ называет поле, а не «Некорректные параметры»', () => {
    const tooMany = z.object({ interests: z.array(z.string()).max(2) }).safeParse({ interests: ['a', 'b', 'c'] });
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) expect(describeRecommendError(tooMany.error.issues)).toMatch(/Выберите не больше \d+ мест и активностей/);
    const badRest = z.object({ restDays: z.number().max(1) }).safeParse({ restDays: 5 });
    if (!badRest.success) expect(describeRecommendError(badRest.error.issues)).toBe('Проверьте поле «Дни отдыха».');
    expect(ROUTE).not.toMatch(/'Некорректные параметры'/);
  });
});

describe('дни отдыха — от дат, с правкой', () => {
  it('один на каждые пять дней, короче пяти — ноль, не больше потолка формы', () => {
    expect(REST_EVERY_DAYS).toBe(5);
    expect(suggestRestDays(10)).toBe(2);
    expect(suggestRestDays(7)).toBe(1);
    expect(suggestRestDays(5)).toBe(1);
    expect(suggestRestDays(4)).toBe(0);
    expect(suggestRestDays(null)).toBe(0);
    expect(suggestRestDays(21)).toBe(4);
  });

  it('форма берёт расчёт по датам, пока счётчик не тронут; правка — вручную и с возвратом', () => {
    expect(CLIENT).toMatch(/restManual \? restDays : restSuggested/);
    expect(CLIENT).toMatch(/restManual \? restDays : suggestRestDays\(span\)/);
    expect(CLIENT).toMatch(/setRestManual\(true\); setRestDays\(Math\.max\(0, restDaysToSend - 1\)\)/);
    expect(CLIENT).toContain('Вернуть по датам');
  });
});

describe('выбранный режим маршрутов читается', () => {
  it('прозрачность фона — через color-mix, а не bg-opacity на цвете-переменной', () => {
    expect(CLIENT).not.toMatch(/bg-\[var\(--[a-z-]+\)\] bg-opacity-\d+/);
    expect(CLIENT).toMatch(/bg-\[color-mix\(in_srgb,var\(--accent\)_16%,var\(--bg-card\)\)\] border-\[var\(--accent\)\] text-\[var\(--accent\)\]/);
  });
});
