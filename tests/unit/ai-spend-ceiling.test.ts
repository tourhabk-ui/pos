// @vitest-environment node
/**
 * Потолок и книги самого дорогого пути (19.09).
 *
 * Владелец: «ANTHROPIC_API_KEY закончился баланс, при чем что то очень быстро».
 * Быстро — потому что тратила ступень, которая включается САМА, когда ломается
 * дешёвая, а книги её не считали:
 *
 *   - ключ OpenRouter лежал не в своём секрете → ступень 0 (GLM 5.3,
 *     $0.91/$2.86 за млн) отказывала на каждом вызове;
 *   - ступень 0b просит сильнейшую модель Anthropic — Opus 5, $5/$25 за млн;
 *   - расход раннера (судья, ревью) в `llm_usage_log` не попадал ВОВСЕ:
 *     DATABASE_URL в их workflow нет, БД Timeweb с раннера закрыта;
 *   - значит `/api/cron/llm-budget-check` не мог сработать ни при каком
 *     AI_DAILY_BUDGET_USD.
 *
 * Сторож держит обе починки по МЕХАНИЗМУ, а не по наличию строк: потолок
 * спрашивается ДО запроса и считается ПОСЛЕ ответа теми же ценами, что книги;
 * сток раннера включается только на раннере и цену не присылает — её считает
 * сервер.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import {
  anthropicDirectGate,
  chargeAnthropicDirect,
  anthropicDirectBudgetState,
  resetAnthropicDirectBudget,
} from '@/lib/ai/providers';
import { usageSinkEnabled } from '@/lib/ai/usage-sink';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PROVIDERS = read('lib/ai/providers.ts');
const SINK = read('lib/ai/usage-sink.ts');
const ROUTE = read('app/api/admin/llm-usage/report/route.ts');

const ENV_KEYS = ['ANTHROPIC_DIRECT_MAX_USD', 'ANTHROPIC_DIRECT_MAX_CALLS', 'GITHUB_ACTIONS', 'CRON_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  queryMock.mockReset();
  // Каталога в тесте нет — цена берётся из запаса COST_PER_1K, как на раннере.
  queryMock.mockRejectedValue(new Error('no db in test'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  resetAnthropicDirectBudget();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetAnthropicDirectBudget();
  vi.restoreAllMocks();
});

describe('потолок прямого Anthropic: сумма и число вызовов', () => {
  it('на чистом прогоне пускает', () => {
    expect(anthropicDirectGate().allowed).toBe(true);
  });

  it('деньги кончились — не пускает и называет переменную, которой это меняется', async () => {
    process.env.ANTHROPIC_DIRECT_MAX_USD = '0.005';
    // Opus 5 в запасе: 0.00750 за 1К всех токенов → 1200 токенов = $0.009.
    await chargeAnthropicDirect('anthropic:claude-opus-5', 1000, 200);
    const gate = anthropicDirectGate();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('ANTHROPIC_DIRECT_MAX_USD');
    expect(anthropicDirectBudgetState().spent_usd).toBeCloseTo(0.009, 10);
  });

  it('число вызовов кончилось — не пускает, даже когда денег потрачено мало', async () => {
    process.env.ANTHROPIC_DIRECT_MAX_CALLS = '2';
    await chargeAnthropicDirect('anthropic:claude-haiku-4-5', 10, 10);
    expect(anthropicDirectGate().allowed).toBe(true);
    await chargeAnthropicDirect('anthropic:claude-haiku-4-5', 10, 10);
    const gate = anthropicDirectGate();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('ANTHROPIC_DIRECT_MAX_CALLS');
  });

  it('«цену не знаю» не значит «трать сколько хочешь»: вызов считается штукой', async () => {
    process.env.ANTHROPIC_DIRECT_MAX_CALLS = '3';
    // Модель вне каталога и вне запаса — resolveCostUsd честно вернёт null.
    await chargeAnthropicDirect('anthropic:claude-unknown-future', 1000, 1000);
    const st = anthropicDirectBudgetState();
    expect(st.spent_usd).toBe(0);
    expect(st.unpriced_calls).toBe(1);
    expect(st.calls).toBe(1);
  });

  it('мусор в переменной не снимает потолок — остаётся умолчание', () => {
    process.env.ANTHROPIC_DIRECT_MAX_USD = 'сколько-нибудь';
    expect(anthropicDirectBudgetState().max_usd).toBe(1.0);
    process.env.ANTHROPIC_DIRECT_MAX_CALLS = '-5';
    expect(anthropicDirectBudgetState().max_calls).toBe(8);
  });
});

describe('ступень 0b спрашивает потолок ДО запроса и говорит вслух', () => {
  it('гейт стоит перед вызовом, а не после', () => {
    const gateAt = PROVIDERS.indexOf('const gate = anthropicDirectGate()');
    const callAt = PROVIDERS.indexOf('label: `evo-decision-anthropic:');
    expect(gateAt).toBeGreaterThan(0);
    expect(callAt).toBeGreaterThan(gateAt);
  });

  it('вызов ЗАВИСИТ от гейта, а не просто стоит после него', () => {
    // Первая редакция этого сторожа проверяла только порядок строк — и
    // положительный контроль (снял `gate.allowed` из условия) остался зелёным:
    // гейт считался, отказ печатался, а запрос уходил всё равно. Порядок без
    // связи — то же объявление без источника (§10.09), только в тесте.
    expect(PROVIDERS).toContain('if (antModel && gate.allowed) try {');
  });

  it('отказ по потолку громкий: и в лог, и в provenance отчёта', () => {
    expect(PROVIDERS).toContain("console.error(`[ai-decision] прямой Anthropic не вызван:");
    expect(PROVIDERS).toMatch(/why\.push\(`anthropic\(\$\{antModel\}\): \$\{gate\.reason\}`\)/);
  });

  it('счёт ведётся теми же ценами, что книги — resolveCostUsd, а не своя таблица', () => {
    const start = PROVIDERS.indexOf('export async function chargeAnthropicDirect');
    const body = PROVIDERS.slice(start, start + 900);
    expect(body).toContain('resolveCostUsd(');
    // Своего прайса у потолка нет: расхождение двух счётчиков одного факта
    // здесь уже стоило дня разбора.
    expect(body).not.toMatch(/COST_PER_1K|0\.0000?\d/);
  });
});

describe('расход раннера доходит до книг', () => {
  it('сток включается ТОЛЬКО на раннере и только когда есть чем авторизоваться', () => {
    delete process.env.GITHUB_ACTIONS;
    process.env.CRON_SECRET = 'x';
    expect(usageSinkEnabled()).toBe(false);

    process.env.GITHUB_ACTIONS = 'true';
    delete process.env.CRON_SECRET;
    expect(usageSinkEnabled()).toBe(false);

    process.env.GITHUB_ACTIONS = 'true';
    process.env.CRON_SECRET = 'x';
    expect(usageSinkEnabled()).toBe(true);
  });

  it('logLLMUsage на раннере уходит в сток, а не в прямой INSERT', () => {
    const start = PROVIDERS.indexOf('async function logLLMUsage');
    const body = PROVIDERS.slice(start, start + 2200);
    expect(body).toContain('usageSinkEnabled()');
    expect(body).toContain('sendUsageToProd(');
    // Ветка стока ЗАВЕРШАЕТ функцию: иначе к INSERT пошли бы обе, и строка
    // записалась бы дважды при живой БД.
    const sinkAt = body.indexOf('sendUsageToProd(');
    const insertAt = body.indexOf('INSERT INTO llm_usage_log');
    expect(sinkAt).toBeLessThan(insertAt);
    expect(body.slice(sinkAt, insertAt)).toContain('return;');
  });

  it('сток посылает токены, но НЕ цену — иначе книги верили бы звонящему на слово', () => {
    expect(SINK).toContain('prompt_tokens');
    expect(SINK).toContain('completion_tokens');
    expect(SINK).not.toMatch(/estimated_cost_usd|cost_usd|resolveCostUsd/);
  });

  it('адрес прода зашит в код, а не приходит переменной (§8, урок 08.08)', () => {
    expect(SINK).toContain("const PROD_BASE = 'https://vedarai.ru'");
    expect(SINK).not.toMatch(/process\.env\.\w*(BASE|URL)\w*/);
  });

  it('отказ стока не глушится: работа не падает, но молчания нет', () => {
    expect(SINK).toMatch(/console\.error\('\[llm-usage-sink\]/);
    expect(SINK).toContain('res.status === 207');
  });
});

describe('приёмник расхода: авторизация, Zod, цена на сервере, частичный отказ', () => {
  it('auth — CRON_SECRET постоянным временем, без ?secret=', () => {
    expect(ROUTE).toContain('getCronSecret(req)');
    expect(ROUTE).toContain('timingSafeCompare');
    expect(ROUTE).not.toContain('?secret=');
  });

  it('вход валидируется Zod, размер партии ограничен', () => {
    expect(ROUTE).toContain('BodySchema.parse');
    expect(ROUTE).toMatch(/\.max\(200\)/);
  });

  it('цену считает сервер, а не берёт из тела запроса', () => {
    expect(ROUTE).toContain('resolveCostUsd(row.model');
    // В схеме тела нет ни цены, ни базиса: их нельзя прислать даже случайно.
    const schemaStart = ROUTE.indexOf('const UsageRow');
    const schemaEnd = ROUTE.indexOf('export async function POST');
    const schema = ROUTE.slice(schemaStart, schemaEnd);
    expect(schema).not.toMatch(/cost|basis/i);
  });

  it('частично записал — не 200: обе цифры названы', () => {
    expect(ROUTE).toContain('failed.length === 0 ? 200 : 207');
    expect(ROUTE).toMatch(/written,/);
    expect(ROUTE).toMatch(/failed: failed\.length/);
  });

  it('SQL параметризован, таблица — llm_usage_log', () => {
    expect(ROUTE).toContain('INSERT INTO llm_usage_log');
    expect(ROUTE).toMatch(/\$1, \$2, \$3, \$4, \$5, \$6, \$7/);
  });
});
