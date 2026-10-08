/**
 * Прямой Anthropic раньше OpenRouter — по переменной, на раннере (08.10).
 *
 * У ключа Anthropic в секретах GitHub — ежемесячные API-кредиты подписки
 * (решение владельца). Пока кредит есть, платить OpenRouter за ту же модель
 * незачем: судья и ревью ставят прямой путь первым. По умолчанию (прод)
 * порядок прежний: там прямой Anthropic закрыт гео-блоком.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { preferAnthropicDirectFirst } from '@/lib/ai/providers';

const ORIGINAL = process.env.EVO_DECISION_ANTHROPIC_FIRST;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EVO_DECISION_ANTHROPIC_FIRST;
  else process.env.EVO_DECISION_ANTHROPIC_FIRST = ORIGINAL;
});

describe('preferAnthropicDirectFirst', () => {
  it('не задана — прежний порядок', () => {
    delete process.env.EVO_DECISION_ANTHROPIC_FIRST;
    expect(preferAnthropicDirectFirst()).toBe(false);
  });
  it('1 и true — прямой Anthropic первым', () => {
    process.env.EVO_DECISION_ANTHROPIC_FIRST = '1';
    expect(preferAnthropicDirectFirst()).toBe(true);
    process.env.EVO_DECISION_ANTHROPIC_FIRST = ' TRUE ';
    expect(preferAnthropicDirectFirst()).toBe(true);
  });
  it('мусор — прежний порядок, а не включение', () => {
    process.env.EVO_DECISION_ANTHROPIC_FIRST = 'yes please';
    expect(preferAnthropicDirectFirst()).toBe(false);
  });
});

describe('решатель меняет порядок двух флагманских ступеней, а не теряет одну', () => {
  const src = readFileSync('lib/ai/providers.ts', 'utf8');
  const decider = src.match(/export async function callAIDecisionDetailed[\s\S]*?\n\}/)?.[0] ?? '';

  it('обе ступени — функции, порядок выбирается флагом, обе вызываются', () => {
    expect(decider).toMatch(/const tryOpenRouterFlagship = async/);
    expect(decider).toMatch(/const tryAnthropicDirect = async/);
    expect(decider).toMatch(/\[tryAnthropicDirect, tryOpenRouterFlagship\]/);
    expect(decider).toMatch(/\[tryOpenRouterFlagship, tryAnthropicDirect\]/);
  });
  it('выбранный порядок виден в provenance', () => {
    expect(decider).toMatch(/порядок: прямой Anthropic раньше OpenRouter/);
  });
  it('потолок прогона прямого пути по-прежнему спрашивается', () => {
    expect(decider).toMatch(/anthropicDirectGate\(\)/);
  });
  it('судья и ревью находок включают флаг', () => {
    for (const wf of ['.github/workflows/evo-judge.yml', '.github/workflows/evo-review.yml']) {
      const y = readFileSync(wf, 'utf8');
      expect(y, wf).toMatch(/EVO_DECISION_ANTHROPIC_FIRST: '1'/);
      // Решение владельца 08.10: потолок прямого пути на раннере — $5 за прогон.
      expect(y, wf).toMatch(/ANTHROPIC_DIRECT_MAX_USD: '5'/);
    }
  });
});
