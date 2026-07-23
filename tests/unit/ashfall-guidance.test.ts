import { describe, it, expect } from 'vitest';
import { ASHFALL_RULES, shouldShowAshfallGuidance } from '@/lib/safety/ashfall-guidance';

describe('shouldShowAshfallGuidance — показываем только при повышенной активности', () => {
  it('оранжевый и красный → показываем', () => {
    expect(shouldShowAshfallGuidance('orange')).toBe(true);
    expect(shouldShowAshfallGuidance('red')).toBe(true);
  });

  it('зелёный/жёлтый/unassigned/пусто → не показываем (нет тревожного шума)', () => {
    expect(shouldShowAshfallGuidance('green')).toBe(false);
    expect(shouldShowAshfallGuidance('yellow')).toBe(false);
    expect(shouldShowAshfallGuidance('unassigned')).toBe(false);
    expect(shouldShowAshfallGuidance(null)).toBe(false);
    expect(shouldShowAshfallGuidance(undefined)).toBe(false);
  });
});

describe('ASHFALL_RULES — авторитетный непустой справочник', () => {
  it('есть правила и первое — про закрыть окна/не выходить', () => {
    expect(ASHFALL_RULES.length).toBeGreaterThanOrEqual(5);
    expect(ASHFALL_RULES[0]).toMatch(/окн|двер|не выходите/i);
  });

  it('покрыты ключевые меры: респиратор/повязка и очки при уборке', () => {
    const joined = ASHFALL_RULES.join(' ');
    expect(joined).toMatch(/респиратор|повязк/i);
    expect(joined).toMatch(/очк/i);
  });
});
