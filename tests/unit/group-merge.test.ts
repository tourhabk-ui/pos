/**
 * Сторож правила сведения пожеланий группы (#2226, решение владельца 08.10).
 *
 * Интересы — объединение по голосам; ограничения — по самому слабому;
 * исключённое ограничением занятие и всякое расхождение названы словами.
 */
import { describe, it, expect } from 'vitest';
import { mergeGroupWishes, MAX_GROUP_INTERESTS, type MemberWishes } from '@/lib/planner/group-merge';

const m = (o: Partial<MemberWishes>): MemberWishes => ({
  interests: [], fitness: 'moderate', noHardClimbs: false, seasickness: false,
  limitedMobility: false, youngestChild: null, budget: 'comfort', ...o,
});

describe('сведение пожеланий группы', () => {
  it('пустая группа — null, а не план по умолчанию', () => {
    expect(mergeGroupWishes([])).toBeNull();
  });

  it('интересы — объединение по числу голосов', () => {
    const g = mergeGroupWishes([
      m({ interests: ['fishing', 'bears'] }),
      m({ interests: ['bears', 'thermal'] }),
      m({ interests: ['bears', 'fishing'] }),
    ])!;
    expect(g.interests).toEqual(['bears', 'fishing', 'thermal']);
    expect(g.votes[0]).toEqual({ interest: 'bears', votes: 3 });
    expect(g.conflicts).toEqual([]);
  });

  it('подготовка и бюджет — по самому слабому, расхождение сказано', () => {
    const g = mergeGroupWishes([
      m({ fitness: 'active', budget: 'premium' }),
      m({ fitness: 'beginner', budget: 'economy' }),
    ])!;
    expect(g.fitness).toBe('beginner');
    expect(g.budget).toBe('economy');
    expect(g.conflicts.join(' ')).toMatch(/по самому слабому: спокойный темп/);
    expect(g.conflicts.join(' ')).toMatch(/по самому скромному: эконом/);
  });

  it('«без тяжёлых подъёмов» у одного — вулкан не ставится, и это сказано', () => {
    const g = mergeGroupWishes([
      m({ interests: ['volcano', 'fishing'], fitness: 'active' }),
      m({ interests: ['volcano'], fitness: 'active' }),
      m({ noHardClimbs: true }),
    ])!;
    expect(g.interests).toEqual(['fishing']);
    expect(g.fitness).toBe('beginner');
    expect(g.conflicts.join(' ')).toContain('Вулканы: хотят 2, но у кого-то в группе «тяжёлые подъёмы не подходят» — в план не ставим');
  });

  it('«укачивает» у одного — морские прогулки не ставятся; подвижность — для всех', () => {
    const g = mergeGroupWishes([m({ interests: ['boat_trip', 'bears'] }), m({ seasickness: true, limitedMobility: true })])!;
    expect(g.interests).toEqual(['bears']);
    expect(g.seasickness).toBe(true);
    expect(g.limitedMobility).toBe(true);
    expect(g.conflicts.join(' ')).toContain('«укачивает»');
    expect(g.conflicts.join(' ')).toContain('ограничена подвижность');
  });

  it('младший ребёнок группы — самый младший из названных', () => {
    const g = mergeGroupWishes([m({ youngestChild: 9 }), m({ youngestChild: 6 }), m({})])!;
    expect(g.children).toEqual([6]);
  });

  it('интересов в плане не больше предела, остальные названы', () => {
    const g = mergeGroupWishes([m({ interests: ['bears', 'fishing', 'thermal', 'geyser', 'helicopter'] })])!;
    expect(g.interests).toHaveLength(MAX_GROUP_INTERESTS);
    expect(g.conflicts.join(' ')).toMatch(/не вошло/);
  });

  it('незнакомый ключ интереса не учитывается', () => {
    const g = mergeGroupWishes([m({ interests: ['casino', 'bears'] })])!;
    expect(g.interests).toEqual(['bears']);
  });
});
