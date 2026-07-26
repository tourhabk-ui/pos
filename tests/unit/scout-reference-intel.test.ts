/**
 * Разведка → Эволюция: «передовые референсы» доходят до evo_growth_issues.
 *
 * Дыра была структурной: intelligence-monitor видел Skift/Product Hunt/конкурентов,
 * но упирался в каналы; в эволюцию кормил только Scout, а у Scout этих источников
 * не было, и мост брал ≤2 находки, задавленные объёмом AI-фидов. Тут проверяем,
 * что источники-референсы заведены, у дайджеста есть их раздел, порог пустоты
 * подрос под 4 раздела, а мост знает про референсы и требует разнообразия.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCOUT = readFileSync(resolve(__dirname, '../../lib/agents/scout-digest.ts'), 'utf8');
const BRIDGE = readFileSync(resolve(__dirname, '../../lib/agents/evo/intel-bridge.ts'), 'utf8');

describe('Scout: источники-референсы заведены', () => {
  it('Skift и Product Hunt — в источниках с категорией reference', () => {
    // Проверяем наличие фидов подстрокой (не regex): CodeQL «missing anchor»
    // срабатывает на любом RegExp-литерале с host-подобным `.com`, а тут это
    // просто grep исходника, не валидация URL.
    expect(SCOUT).toContain('https://skift.com/feed');
    expect(SCOUT).toContain('https://www.producthunt.com/feed');
    expect(SCOUT).toMatch(/category:\s*'reference'/);
  });

  it('категория reference добавлена в тип источника', () => {
    expect(SCOUT).toMatch(/type SourceCategory =[^;]*'reference'/);
  });

  it('в синтезе дайджеста появился раздел «Референсы»', () => {
    expect(SCOUT).toMatch(/Референсы и рынок/);
  });

  it('порог «пустого дайджеста» поднят под 4 раздела (иначе глушит раздел с сигналом)', () => {
    // Раньше было >= 3 при трёх разделах; с четвёртым разделом порог обязан быть 4,
    // иначе дайджест с сигналом только в «Референсах» ошибочно не публикуется.
    expect(SCOUT).toMatch(/Нет значимых сигналов за сегодня\/g\)\s*\?\?\s*\[\]\)\.length\s*>=\s*4/);
  });
});

describe('Мост intel-bridge: референсы доходят до эволюции', () => {
  it('кап поднят до 3 находок за прогон', () => {
    expect(BRIDGE).toMatch(/MAX_INTEL_PER_RUN\s*=\s*3/);
  });

  it('промпт знает про раздел референсов/рынка', () => {
    expect(BRIDGE).toMatch(/референс/i);
    expect(BRIDGE).toMatch(/Skift|Product Hunt/);
  });

  it('промпт требует разнообразия тем (не все слоты на AI)', () => {
    expect(BRIDGE).toMatch(/РАЗНООБРАЗИЕ/);
  });
});
