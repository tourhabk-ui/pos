// @vitest-environment node
/**
 * Guardrail величины хода цены (03.09, сверка с blueprint commerce-agents).
 *
 * Право менять цену решает policy; guardrail держит ВЕЛИЧИНУ: «12000 вместо
 * 120000» — опечатка, а не решение. Большой ход проходит только с явным
 * подтверждением человека, которое модель сама не выставляет.
 *
 * Сторож держит: три исхода чистой функции; проверка стоит ДО
 * executeGovernedAction, а не после; подтверждение — явный аргумент.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPriceMove, PRICE_MOVE_MAX_PCT } from '@/lib/agents/kernel/guardrails';

const TOOLS = readFileSync(join(process.cwd(), 'lib/agents/sdk/operator-tools.ts'), 'utf-8');

describe('checkPriceMove', () => {
  it('в пределах порога — ок, процент назван', () => {
    const r = checkPriceMove('10000', 12000, false);
    expect(r.ok).toBe(true);
    expect(r.move_pct).toBe(20);
  });

  it('за порогом без подтверждения — отказ с процентом и подсказкой', () => {
    const r = checkPriceMove(120000, 12000, false);
    expect(r.ok).toBe(false);
    expect(r.move_pct).toBe(90);
    if (!r.ok) expect(r.reason).toMatch(/confirm_large_move/);
  });

  it('за порогом с подтверждением — ок', () => {
    expect(checkPriceMove(120000, 12000, true).ok).toBe(true);
    expect(checkPriceMove(10000, 30000, true).ok).toBe(true);
  });

  it('ровно порог — ещё в пределах', () => {
    expect(checkPriceMove(100, 100 + PRICE_MOVE_MAX_PCT, false).ok).toBe(true);
  });

  it('нечисловая или неположительная новая цена — отказ, не «ноль процентов»', () => {
    expect(checkPriceMove(10000, 0, true).ok).toBe(false);
    expect(checkPriceMove(10000, 'abc', true).ok).toBe(false);
    expect(checkPriceMove(10000, -5, true).ok).toBe(false);
  });

  it('нет прежней цены — сверять не с чем: только с подтверждением', () => {
    expect(checkPriceMove(null, 10000, false).ok).toBe(false);
    expect(checkPriceMove(0, 10000, true).ok).toBe(true);
  });
});

describe('проводка в инструмент оператора', () => {
  it('проверка стоит до executeGovernedAction в update_tour_price', () => {
    const start = TOOLS.indexOf("name: 'update_tour_price'");
    const body = TOOLS.slice(start, TOOLS.indexOf("name: 'set_tour_published'", start) > 0
      ? TOOLS.indexOf("name: 'set_tour_published'", start)
      : start + 4000);
    const check = body.indexOf('checkPriceMove(');
    const gov = body.indexOf('executeGovernedAction');
    expect(check).toBeGreaterThan(0);
    expect(gov).toBeGreaterThan(check);
  });

  it('подтверждение — явный аргумент, описанный модели как решение человека', () => {
    expect(TOOLS).toMatch(/confirm_large_move: \{ type: 'string'/);
    expect(TOOLS).toMatch(/args\.confirm_large_move === 'true'/);
  });
});
