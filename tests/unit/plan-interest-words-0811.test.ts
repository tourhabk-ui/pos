/**
 * Интересы плана из слов человека (разбор 08.11): второй словарь
 * (lib/planner/interests) ловит только то, чего не понял первый
 * (lib/planner/interest-words). До 08.11 он читал тот же текст целиком, и
 * «вулканы» давали ещё «треккинг»: план «вулканы, 6 дней» вёз группу на
 * треккинг в Восточную зону, а экран планера тех же слов так не понимал.
 */
import { describe, it, expect } from 'vitest';
import { parseChatInterestsDetailed } from '@/lib/kuzmich/trip-plan-tool';

describe('интересы плана из слов человека', () => {
  it('«вулканы» — только вулканы', () => {
    expect(parseChatInterestsDetailed('вулканы').interests).toEqual(['volcano']);
    expect(parseChatInterestsDetailed('Вулканы и медведи').interests.sort()).toEqual(['bears', 'volcano']);
  });

  it('слова, которых первый словарь не знает, по-прежнему понимаются вторым', () => {
    expect(parseChatInterestsDetailed('вулканы и восхождение').interests.sort()).toEqual(['trekking', 'volcano']);
    expect(parseChatInterestsDetailed('рыбалка, хариус').interests).toEqual(['fishing']);
    expect(parseChatInterestsDetailed('перевал и гора').interests).toEqual(['trekking']);
  });

  it('ничего не понято — классика первой поездки, с признаком', () => {
    expect(parseChatInterestsDetailed('просто отдохнуть').defaulted).toBe(true);
  });
});
