/**
 * Совпадение имени места без учёта порядка слов (issue #1986, #1987).
 *
 * Живой случай 21.09.2026: «Горелый вулкан» не находился вовсе (в базе
 * записано «Вулкан Горелый»), а «Мутновский вулкан» находил ЧУЖОЕ место
 * («Скитур на Мутновский вулкан») вместо канонической точки — из-за чего
 * терялась и строка KVERT, которая есть только у «Вулкан Мутновский».
 */
import { describe, it, expect } from 'vitest';
import { significantWords, nameContainsAllWordsSql, nameMatchesWords, placeNameSearchSql } from '@/lib/places/name-match';

describe('significantWords', () => {
  it('отбрасывает короткие слова и пунктуацию', () => {
    expect(significantWords('оз. Толбачик')).toEqual(['толбачик']);
  });

  it('нормализует регистр', () => {
    expect(significantWords('ГОРЕЛЫЙ Вулкан')).toEqual(['горелый', 'вулкан']);
  });
});

describe('nameMatchesWords — порядок слов не важен', () => {
  // Родовые слова из формулировки issue #1987: вулкан, озеро, река, бухта,
  // перевал, источники — плюс реальные записи каталога (§4.1: «Вулкан X»).
  const cases: Array<{ catalogName: string; naturalQuery: string }> = [
    { catalogName: 'Вулкан Горелый', naturalQuery: 'Горелый вулкан' },
    { catalogName: 'Вулкан Мутновский', naturalQuery: 'Мутновский вулкан' },
    { catalogName: 'Вулкан Авачинский', naturalQuery: 'Авачинский вулкан' },
    { catalogName: 'Курильское озеро', naturalQuery: 'озеро Курильское' },
    { catalogName: 'Авачинская бухта', naturalQuery: 'бухта Авачинская' },
    { catalogName: 'Вилючинский перевал', naturalQuery: 'перевал Вилючинский' },
    { catalogName: 'Дачные источники', naturalQuery: 'источники Дачные' },
  ];

  for (const { catalogName, naturalQuery } of cases) {
    it(`«${naturalQuery}» находит «${catalogName}» в обоих порядках`, () => {
      expect(nameMatchesWords(catalogName, significantWords(naturalQuery))).toBe(true);
      // И обратный порядок (как записано в каталоге) — тоже находит себя же.
      expect(nameMatchesWords(catalogName, significantWords(catalogName))).toBe(true);
    });
  }

  it('не превращается в совпадение чего угодно: посторонние слова не проходят', () => {
    expect(nameMatchesWords('Вулкан Горелый', significantWords('Мутновский вулкан'))).toBe(false);
  });
});

describe('nameContainsAllWordsSql', () => {
  it('строит условие AND по словам с плейсхолдерами от заданного номера', () => {
    const { clause, params } = nameContainsAllWordsSql('p.name', ['горелый', 'вулкан'], 1);
    expect(clause).toBe('p.name ILIKE $1 AND p.name ILIKE $2');
    expect(params).toEqual(['%горелый%', '%вулкан%']);
  });
});

describe('placeNameSearchSql', () => {
  it('многословный запрос → AND по словам', () => {
    const { clause, params } = placeNameSearchSql('name', 'Горелый вулкан', 1);
    expect(clause).toBe('name ILIKE $1 AND name ILIKE $2');
    expect(params).toEqual(['%горелый%', '%вулкан%']);
  });

  it('без значимых слов — честный откат на буквальную подстроку целиком', () => {
    const { clause, params } = placeNameSearchSql('name', 'оз.', 1);
    expect(clause).toBe('name ILIKE $1');
    expect(params).toEqual(['%оз.%']);
  });

  it('однословный запрос ведёт себя как раньше — одно условие', () => {
    const { clause, params } = placeNameSearchSql('name', 'Горелый', 1);
    expect(clause).toBe('name ILIKE $1');
    expect(params).toEqual(['%горелый%']);
  });
});
