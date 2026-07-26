/**
 * Дашборд «Расходы AI» — честность о стоимости.
 * Колонки cost_usd/tokens в ai_actions_log есть, но НИ ОДИН insert их не пишет.
 * Дашборд обязан не выдумывать рубли: признак instrumented честно отражает,
 * есть ли хоть одна строка со стоимостью, а UI при его отсутствии объясняет
 * пробел вместо показа «$0.00» как факта.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const api = readFileSync('app/api/admin/analytics/ai-usage/route.ts', 'utf8');
const page = readFileSync('app/hub/admin/ai-usage/page.tsx', 'utf8');

describe('API ai-usage', () => {
  it('под админом (requireAdmin)', () => {
    expect(api).toMatch(/requireAdmin/);
  });

  it('признак instrumented — из наличия строк с cost_usd, не выдуман', () => {
    expect(api).toMatch(/cost_usd IS NOT NULL/);
    expect(api).toMatch(/instrumented:\s*Number\(t\.cost_rows\)\s*>\s*0/);
  });

  it('NUMERIC/bigint приведены к float8 (ловушка pg-строк)', () => {
    expect(api).toMatch(/SUM\(cost_usd\)/);
    expect(api).toMatch(/\)::float8/);            // COALESCE(SUM(...), 0)::float8
    expect(api).toMatch(/to_char\(created_at::date/); // дата строкой, не JS Date
  });

  it('агрегация из ai_actions_log', () => {
    expect(api).toMatch(/FROM ai_actions_log/);
  });
});

describe('страница ai-usage', () => {
  it('при отсутствии инструментации объясняет пробел, а не показывает $0 как факт', () => {
    expect(page).toMatch(/data\.cost\.instrumented \?/);
    expect(page).toMatch(/не заполняет|не пишутся/);
  });

  it('показывает активность (реальные данные)', () => {
    expect(page).toMatch(/по типу действия|По типу действия/i);
    expect(page).toMatch(/по провайдеру|По провайдеру/i);
  });
});
