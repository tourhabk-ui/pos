/**
 * Деньги на ИИ (запрос владельца 18.09): остаток у провайдеров и расход по
 * моделям на /hub/admin/health.
 *
 * Что держит сторож:
 *  1. у КАЖДОГО ключа из provider-config есть запись в реестре балансов —
 *     либо «API отдаёт», либо «не отдаёт, вот причина». Новый провайдер без
 *     записи — красный тест, а не молчаливое отсутствие строки на экране;
 *  2. разбор ответа DeepSeek не выдумывает ноль: нечисло и пустой ответ —
 *     исход failed;
 *  3. догадка о провайдере по имени модели не притягивает нераспознанное
 *     к «ближайшему похожему»;
 *  4. роут закрыт requireAdmin и не глушит отказ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BALANCE_SOURCES, parseDeepSeekBalance } from '@/lib/ai/balances';
import { guessProvider } from '@/lib/ai/model-spend';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('реестр балансов покрывает каждый ключ провайдера', () => {
  const config = read('lib/ai/provider-config.ts');
  const getters = [...config.matchAll(/^export function (get[A-Za-z]+Key|getQwenConfig|getTimewebAgents)\(/gm)]
    .map(m => m[1])
    // Источник ключа OpenRouter (какая из двух переменных) — не отдельный провайдер.
    .filter(g => g !== 'getOpenRouterKeySource');
  const covered = new Set(Object.values(BALANCE_SOURCES).map(s => s.key_getter));

  it('находит геттеры ключей в provider-config', () => {
    expect(getters.length).toBeGreaterThan(10);
  });

  for (const g of getters) {
    it(`${g} — есть исход в BALANCE_SOURCES`, () => {
      expect(covered.has(g)).toBe(true);
    });
  }

  it('Qwen: геттер живёт в providers.ts, а не в provider-config — покрыт явно', () => {
    expect(read('lib/ai/providers.ts')).toMatch(/^export function getQwenConfig\(/m);
    expect(covered.has('getQwenConfig')).toBe(true);
  });

  it('каждая запись unsupported называет причину и где смотреть', () => {
    for (const [id, s] of Object.entries(BALANCE_SOURCES)) {
      if (s.kind === 'unsupported') {
        expect(s.reason, id).toBeTruthy();
        expect((s.reason ?? '').length, id).toBeGreaterThan(20);
      }
    }
  });

  it('API отдают баланс ровно двое — DeepSeek и OpenRouter', () => {
    // Список может расти только вместе с кодом запроса в balances.ts.
    const api = Object.entries(BALANCE_SOURCES).filter(([, s]) => s.kind === 'api').map(([id]) => id).sort();
    expect(api).toEqual(['deepseek', 'openrouter']);
  });
});

describe('разбор баланса DeepSeek', () => {
  it('строковые числа провайдера читаются как числа', () => {
    const r = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }],
    });
    expect(r).toEqual({ amount: 12.34, currency: 'USD' });
  });

  it('пустой ответ — отказ, а не нулевой баланс', () => {
    expect(parseDeepSeekBalance({ is_available: false, balance_infos: [] })).toHaveProperty('error');
    expect(parseDeepSeekBalance(null)).toHaveProperty('error');
    expect(parseDeepSeekBalance('oops')).toHaveProperty('error');
  });

  it('нечисло в total_balance — отказ с текстом', () => {
    const r = parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: 'n/a' }] });
    expect(r).toHaveProperty('error');
    expect(String((r as { error: string }).error)).toContain('n/a');
  });

  it('нет total_balance — отказ', () => {
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: 'USD' }] })).toHaveProperty('error');
  });
});

describe('догадка о провайдере по имени модели', () => {
  it('распознаёт известные семейства', () => {
    expect(guessProvider('deepseek-v4-pro')).toBe('deepseek');
    expect(guessProvider('qwen-plus')).toBe('qwen');
    expect(guessProvider('grok-4.6')).toBe('xai');
    expect(guessProvider('z-ai/glm-5.3')).toBe('openrouter');
    expect(guessProvider('anthropic/claude-opus-5')).toBe('openrouter');
    expect(guessProvider('claude-sonnet-5')).toBe('anthropic');
  });

  it('нераспознанное имя — unknown, не ближайший похожий', () => {
    expect(guessProvider('llama-3.3-70b')).toBe('unknown');
    expect(guessProvider('')).toBe('unknown');
  });
});

describe('роут и карточка', () => {
  const route = read('app/api/admin/health/ai-money/route.ts');
  const page = read('app/hub/admin/health/_HealthDashboardClient.tsx');

  it('роут закрыт requireAdmin', () => {
    expect(route).toContain('requireAdmin(request)');
  });

  it('отказ роута пишется в лог, а не глушится', () => {
    expect(route).toContain("console.error('[health/ai-money]'");
    expect(route).not.toContain('catch {');
  });

  it('карточка читает роут и показывает четыре исхода баланса', () => {
    expect(page).toContain("'/api/admin/health/ai-money'");
    for (const label of ['остаток', 'ключа нет', 'API не отдаёт', 'не смог спросить']) {
      expect(page).toContain(label);
    }
  });

  it('неизвестная цена не выдаётся за ноль', () => {
    expect(page).toContain('цена не посчитана');
    expect(page).toContain('без цены');
  });

  it('модуль балансов под надзором D2', () => {
    expect(read('lib/agents/compliance/provider-registry.ts')).toContain("'lib/ai/balances.ts'");
  });
});
