/**
 * План семьи не ставит занятия, на которые младшего ребёнка не пустят
 * (решение владельца 08.10: «убери»).
 *
 * До этого восхождение 12+ стояло в плане семьи с шестилетним ребёнком, и
 * возраст звучал только пометкой на самом дне. Теперь `splitByChildAge`
 * убирает такой интерес до раскладки по дням, а ответ называет, что убрано,
 * с каким порогом и чем заменить. Порог — один, `minChildAge` из
 * `ACTIVITY_CONSTRAINTS`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitByChildAge } from '@/lib/planner/engine';
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner';
import { buildRefusal, childAgeLine } from '@/lib/kuzmich/trip-plan-tool';

const ENGINE = readFileSync(join(process.cwd(), 'lib/planner/engine.ts'), 'utf-8');

describe('splitByChildAge', () => {
  it('без детей ничего не убирает', () => {
    expect(splitByChildAge(['volcano', 'bears'], null)).toEqual({ allowed: ['volcano', 'bears'], blocked: [] });
  });

  it('убирает ровно то, где младший моложе порога, с порогом и альтернативой', () => {
    const volcanoAge = ACTIVITY_CONSTRAINTS.volcano.minChildAge;
    const { allowed, blocked } = splitByChildAge(['volcano', 'hot_spring'], volcanoAge - 1);
    expect(allowed).toEqual(['hot_spring']);
    expect(blocked).toEqual([{
      interest: 'volcano', minAge: volcanoAge, youngest: volcanoAge - 1,
      alternative: ACTIVITY_CONSTRAINTS.volcano.childAlternative ?? null,
    }]);
  });

  it('ровно на пороге — пускает', () => {
    const age = ACTIVITY_CONSTRAINTS.volcano.minChildAge;
    expect(splitByChildAge(['volcano'], age).blocked).toEqual([]);
  });

  it('неизвестный интерес не трогает: порога нет — выдумывать нельзя', () => {
    expect(splitByChildAge(['nonexistent'], 3)).toEqual({ allowed: ['nonexistent'], blocked: [] });
  });
});

describe('ответ называет убранное', () => {
  const blocked = splitByChildAge(['volcano'], 6).blocked;

  it('строка с порогом и альтернативой', () => {
    const line = childAgeLine(blocked);
    expect(line).toMatch(/^По возрасту младшего \(6\) в план не вошло: вулканы — с 12 лет/i);
    if (ACTIVITY_CONSTRAINTS.volcano.childAlternative) expect(line).toContain('альтернатива:');
    expect(childAgeLine([])).toBe('');
  });

  it('отказ, где всё убрано по возрасту, не врёт «не сезон» и не молчит', () => {
    const text = buildRefusal(7, ['volcano'], 'https://vedarai.ru', null, blocked);
    expect(text).toMatch(/По возрасту младшего \(6\) в план не вошло/);
    expect(text).not.toMatch(/не сезон: вулканы/i);
    expect(text).not.toMatch(/по этим интересам план не сложился/);
  });

  it('без детей отказ прежний', () => {
    expect(buildRefusal(11, ['volcano'], 'https://vedarai.ru')).toMatch(/^В ноябре это уже не сезон: вулканы/i);
  });
});

describe('движок: убирает до раскладки, а не помечает на дне', () => {
  it('зоны и дни считаются по профилю без убранного, предупреждения — по полному', () => {
    expect(ENGINE).toMatch(/splitByChildAge\(profile\.interests, youngestChild\(profile\)\)/);
    expect(ENGINE).toMatch(/await scoreZones\(planProfile, cache, catalogueOpen\)/);
    expect(ENGINE).toMatch(/await generateDayPlans\(planProfile, zones, tripDays, cache, catalogueOpen, onRequestOnly\)/);
    expect(ENGINE).toMatch(/collectWarnings\(profile, zones,/);
    expect(ENGINE).not.toMatch(/dayWarnings\.push\(`Детям </);
  });
});
