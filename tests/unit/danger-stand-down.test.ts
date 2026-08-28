import { describe, it, expect } from 'vitest';
import { isStandDownTransition } from '@/lib/agents/agencies/danger-analyst-agency';

describe('isStandDownTransition — граница слоя ПОСЛЕ тревоги (issue #1420)', () => {
  it('high → low — переход, пуш нужен', () => {
    expect(isStandDownTransition('high', 'low')).toBe(true);
  });

  it('critical → moderate — переход, пуш нужен', () => {
    expect(isStandDownTransition('critical', 'moderate')).toBe(true);
  });

  it('high → high — не переход, риск ещё повышен', () => {
    expect(isStandDownTransition('high', 'high')).toBe(false);
  });

  it('critical → high — остаётся повышенным, не переход', () => {
    expect(isStandDownTransition('critical', 'high')).toBe(false);
  });

  it('low → high — рост риска, это не stand-down', () => {
    expect(isStandDownTransition('low', 'high')).toBe(false);
  });

  it('low → low — обычное спокойствие, пуш не нужен', () => {
    expect(isStandDownTransition('low', 'low')).toBe(false);
  });

  it('previous = null (первая оценка зоны вообще) — переход посчитать не из чего', () => {
    expect(isStandDownTransition(null, 'low')).toBe(false);
    expect(isStandDownTransition(null, 'high')).toBe(false);
  });

  it('срабатывает ровно один раз на переход: второй низкий подряд — уже не переход', () => {
    // Симулирует три прогона подряд: critical → low → low.
    expect(isStandDownTransition('critical', 'low')).toBe(true);
    expect(isStandDownTransition('low', 'low')).toBe(false);
  });
});
