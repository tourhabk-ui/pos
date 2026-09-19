/**
 * #1862 (решение владельца 14.09, карт-бланш): цена вызова — из каталога
 * моделей (model_catalog, миграция 946), а не из захардкоженной COST_PER_1K.
 * Ни одна модель, реально работающая сегодня (deepseek-v4-pro, glm-5.3,
 * grok-4.6, qwen-vl), в старой таблице не значилась — каждая живая строка
 * llm_usage_log считалась умолчанием $0.0005, втрое искажая счёт в обе
 * стороны. Промах и в каталоге, и в запасной таблице — `cost: null`, не
 * догадка.
 *
 * `resolveCostUsd` экспортирована из lib/ai/providers.ts ровно для этой
 * прямой проверки — тот же приём, что у `fetchSource` в evo-report.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { resolveCostUsd, priceLookupIds } from '@/lib/ai/providers';

beforeEach(() => {
  queryMock.mockReset();
});

describe('resolveCostUsd: каталог первичен, запас — только для моделей вне него', () => {
  it('модель есть в каталоге с обеими ценами — считает по факту токенов', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ usd_per_mtok_in: '1.4', usd_per_mtok_out: '4.4' }],
    });
    const { cost, basis } = await resolveCostUsd('z-ai/glm-5.3', 1000, 200);
    // (1000*1.4 + 200*4.4) / 1e6
    expect(cost).toBeCloseTo((1000 * 1.4 + 200 * 4.4) / 1e6, 10);
    expect(basis).toBe('model_catalog');
  });

  it('каталог знает модель, но цену не назвал (NULL) — не считается за ноль, падаем на запас или unknown', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ usd_per_mtok_in: null, usd_per_mtok_out: null }],
    });
    const { cost, basis } = await resolveCostUsd('some/unpriced-model', 1000, 200);
    expect(cost).toBeNull();
    expect(basis).toBe('unknown');
  });

  it('модели нет в каталоге, но есть в запасной таблице (прямой DeepSeek) — считает по ней', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { cost, basis } = await resolveCostUsd('deepseek-chat', 1000, 200);
    expect(cost).toBeCloseTo((0.00050 * 1200) / 1000, 10);
    expect(basis).toBe('cost_table_fallback');
  });

  it('модели нет нигде — cost: null, не умолчание $0.0005', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { cost, basis } = await resolveCostUsd('deepseek-v4-pro', 1000, 200);
    expect(cost).toBeNull();
    expect(basis).toBe('unknown');
  });

  it('каталог не спросился (сеть/БД упала) — не выдумывает цену, падает на запас', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    const { cost, basis } = await resolveCostUsd('deepseek-chat', 1000, 200);
    expect(cost).toBeCloseTo((0.00050 * 1200) / 1000, 10);
    expect(basis).toBe('cost_table_fallback');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('каталог не спросился, и модели нет в запасной таблице — честное unknown, не тихий 0', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(new Error('timeout'));
    const { cost, basis } = await resolveCostUsd('grok-4.6', 1000, 200);
    expect(cost).toBeNull();
    expect(basis).toBe('unknown');
    consoleSpy.mockRestore();
  });
});

/**
 * 19.09: ключ журнала и ключ прайса расходились разделителем, и расходился
 * ровно самый дорогой путь. Прямой Anthropic (ступень 0b решателя) пишет
 * `anthropic:claude-opus-5`, а оба источника цен знают `anthropic/claude-opus-5`
 * — строка уходила в журнал с `estimated_cost_usd` NULL, а SUM(...) в
 * llm-budget-check такие строки пропускает. То есть дневной бюджет не видел
 * Opus 5 ($5/$25 за млн) вовсе и сработать по нему не мог.
 */
describe('ключ журнала с вендором через двоеточие находит свою цену', () => {
  it('anthropic:claude-opus-5 — цена НЕ null: находится по слагу с косой чертой', async () => {
    // Каталога нет (прод-БД недоступна с раннера) — работает запас COST_PER_1K.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValue(new Error('connection refused'));
    const { cost, basis } = await resolveCostUsd('anthropic:claude-opus-5', 1000, 200);
    expect(cost).toBeCloseTo((0.00750 * 1200) / 1000, 10);
    expect(basis).toBe('cost_table_fallback');
    consoleSpy.mockRestore();
  });

  it('каталог спрашивается и по нормализованному id, не только по исходному', async () => {
    // Первый id (как в журнале) каталогу неизвестен, второй — известен.
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [{ usd_per_mtok_in: '5', usd_per_mtok_out: '25' }] });
    const { cost, basis } = await resolveCostUsd('anthropic:claude-opus-5', 1000, 200);
    expect(cost).toBeCloseTo((1000 * 5 + 200 * 25) / 1e6, 10);
    expect(basis).toBe('model_catalog');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('вендор, которого нет ни в каталоге, ни в запасе, остаётся честным unknown', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValue(new Error('connection refused'));
    const { cost, basis } = await resolveCostUsd('qwen:qwen-plus', 1000, 200);
    expect(cost).toBeNull();
    expect(basis).toBe('unknown');
    consoleSpy.mockRestore();
  });

  it('timeweb:<agent_id> цены не получает — у агента шлюза её нет ни в одном каталоге', () => {
    // Нормализация механическая, а не догадка: агент шлюза не модель.
    expect(priceLookupIds('timeweb:a1b2c3')).toEqual(['timeweb:a1b2c3', 'timeweb/a1b2c3']);
    expect(priceLookupIds('anthropic:claude-opus-5')).toEqual(['anthropic:claude-opus-5', 'anthropic/claude-opus-5']);
  });

  it('обычный слаг OpenRouter второго варианта не порождает — лишнего запроса нет', async () => {
    expect(priceLookupIds('z-ai/glm-5.3')).toEqual(['z-ai/glm-5.3']);
    queryMock.mockResolvedValueOnce({ rows: [{ usd_per_mtok_in: '1.4', usd_per_mtok_out: '4.4' }] });
    await resolveCostUsd('z-ai/glm-5.3', 10, 10);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('logLLMUsage пишет cost_basis рядом с ценой', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

  it('INSERT несёт колонку cost_basis и параметр basis', () => {
    const start = SRC.indexOf('async function logLLMUsage');
    const body = SRC.slice(start, start + 1500);
    expect(body).toMatch(/estimated_cost_usd,\s*cost_basis/);
    expect(body).toMatch(/\[model, prompt, completion, total, cost, basis, currentAgentId\(\)\]/);
  });

  it('отказ INSERT не глушится молча — логируется с моделью и причиной', () => {
    const start = SRC.indexOf('async function logLLMUsage');
    const body = SRC.slice(start, start + 1500);
    expect(body).not.toMatch(/\.catch\(\(\) => \{\s*\/\* silent \*\/\s*\}\)/);
    expect(body).toMatch(/console\.error\(.*llm-usage.*строка не записана/);
  });
});
