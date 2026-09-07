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

  it('«пустой дайджест» считается по существу, а не по числу заглушек', () => {
    // Порог «четыре строки-заглушки» держался на том, что пустой раздел
    // получает строку «Нет значимых сигналов за сегодня». С 06.09 заглушки
    // нет вовсе — пустой раздел исчезает, — и счёт по ней не сработал бы
    // НИКОГДА: выпуск из одних заголовков ушёл бы в канал. Считает
    // hasSubstance: есть ли хоть одна строка, кроме заголовков.
    expect(SCOUT).toMatch(/const allEmpty = !hasSubstance\(digest\)/);
    expect(SCOUT).not.toMatch(/Нет значимых сигналов за сегодня\/g\)/);
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
