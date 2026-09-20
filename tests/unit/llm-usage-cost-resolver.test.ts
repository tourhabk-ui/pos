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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { resolveCostUsd, priceLookupIds } from '@/lib/ai/providers';

const savedDbUrl = process.env.DATABASE_URL;

beforeEach(() => {
  queryMock.mockReset();
  // Каталог живёт в БД, и с 20.09 `resolveCostUsd` не ходит туда, когда строки
  // подключения нет вовсе (на раннере GitHub её нет, и запрос падал бы всегда,
  // крича «каталог моделей не прочитан» на каждый вызов модели). Проверки ниже
  // говорят про ветку С каталогом — значит предпосылку надо назвать вслух, а не
  // полагаться на то, что окружение прогона её случайно даёт.
  process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
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
/**
 * 20.09: прогон evo-judge 53 написал «каталог моделей не прочитан» трижды —
 * на каждый вызов модели. Чинить там было нечего: БД Timeweb с раннера закрыта
 * файрволом, `DATABASE_URL` в workflow нет, и запрос не мог выполниться НИ
 * РАЗУ. Тревога по известному состоянию — не сигнал, а шум, и в тот день она
 * увела разбор немоты флагмана в сторону БД, хотя сломан был сток расхода.
 */
describe('недостижимый каталог — известное состояние, а не отказ', () => {
  it('без DATABASE_URL в базу не ходят вовсе', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DATABASE_URL;
    const { cost, basis } = await resolveCostUsd('anthropic:claude-opus-5', 1000, 200);
    // Цена берётся из запаса — ровно то, чем живёт потолок прямого Anthropic.
    expect(cost).toBeCloseTo((0.00750 * 1200) / 1000, 10);
    expect(basis).toBe('cost_table_fallback');
    expect(queryMock, 'запрос ушёл в БД, которой нет').not.toHaveBeenCalled();
    expect(consoleSpy, 'тревога по известному состоянию').not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('незнание цены и без каталога остаётся незнанием', async () => {
    delete process.env.DATABASE_URL;
    const { cost, basis } = await resolveCostUsd('z-ai/glm-5.3', 1000, 200);
    expect(cost).toBeNull();
    expect(basis).toBe('unknown');
  });
});

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
  // Окно чтения тела: 19.09 функция подросла ветвью прод-стока для раннера
  // (расход судьи и ревью в книги не попадал вовсе), и прежние 1500 символов
  // обрывались до INSERT — тест краснел на своей же мерке, а не на дефекте.
  const WINDOW = 2800;

  it('INSERT несёт колонку cost_basis и параметр basis', () => {
    const start = SRC.indexOf('async function logLLMUsage');
    const body = SRC.slice(start, start + WINDOW);
    expect(body).toMatch(/estimated_cost_usd,\s*cost_basis/);
    expect(body).toMatch(/\[model, prompt, completion, total, cost, basis, currentAgentId\(\)\]/);
  });

  it('отказ INSERT не глушится молча — логируется с моделью и причиной', () => {
    const start = SRC.indexOf('async function logLLMUsage');
    const body = SRC.slice(start, start + WINDOW);
    expect(body).not.toMatch(/\.catch\(\(\) => \{\s*\/\* silent \*\/\s*\}\)/);
    expect(body).toMatch(/console\.error\(.*llm-usage.*строка не записана/);
  });
});
