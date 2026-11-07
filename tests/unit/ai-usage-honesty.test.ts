/**
 * «Расходы AI», вкладка «Активность» — счётчик действий, а не деньги.
 *
 * Колонки cost_usd/tokens в ai_actions_log есть, но cost_usd НЕ ПИШЕТ ни один
 * insert. До 07.11 роут считал по ней «стоимость», а страница из-за этого
 * всегда писала «стоимость пока не пишется» — при живых книгах llm_usage_log,
 * по которым считает вкладка «Деньги» (tests/unit/ai-money-tab.test.tsx).
 * Владелец 07.11: «наведи порядок в этом разделе». Здесь — запрет вернуть
 * «стоимость» из колонки, которую никто не пишет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Комментарии вырезаются: шапка роута объясняет историю словами «cost_usd».
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const api = strip(readFileSync('app/api/admin/analytics/ai-usage/route.ts', 'utf8'));

describe('API активности ai-usage', () => {
  it('под админом (requireAdmin)', () => {
    expect(api).toMatch(/requireAdmin/);
  });

  it('агрегация из ai_actions_log, дата строкой, не JS Date', () => {
    expect(api).toMatch(/FROM ai_actions_log/);
    expect(api).toMatch(/to_char\(created_at::date/);
  });

  it('денег из ai_actions_log не считает: колонку cost_usd не пишет никто', () => {
    expect(api).not.toMatch(/cost_usd/);
    expect(api).not.toMatch(/instrumented/);
  });
});
