// @vitest-environment node
/**
 * Слова запроса для search коннектора (lib/mcp/search-terms, 12.10).
 *
 * Живой search на проде отвечал пусто на свой же пример «Курильское озеро
 * медведи» и на «Kurile Lake bears»: вся строка шла в ILIKE одним куском.
 * Сторож держит: запрос режется на слова, русские сводятся к основе,
 * английские переводятся словарём (с множественным числом), служебные
 * отбрасываются, пустого набора не бывает, потолок — MAX_TERMS; в SQL каждое
 * слово — свой параметр, запись проходит по любому слову, а ранг — число
 * совпавших (hits) раньше похожести.
 */
import { describe, it, expect } from 'vitest';
import { searchTerms, stemRu, translateEn, EN_TO_RU, MAX_TERMS } from '@/lib/mcp/search-terms';
import { termSql, searchSql, searchParams, SEARCH_TOOL } from '@/lib/mcp/connector-tools';

describe('русские слова → основы', () => {
  it('усечение до max(4, len−2) у слов от пяти букв, короткие как есть, ё → е', () => {
    expect(stemRu('озеро')).toBe('озер');
    expect(stemRu('Курильское')).toBe('курильск');
    expect(stemRu('медведи')).toBe('медве');
    expect(stemRu('сплав')).toBe('спла');
    expect(stemRu('мыс')).toBe('мыс');
    expect(stemRu('вертолёт')).toBe('вертол');
  });

  it('пример из описания инструмента даёт три основы — и ни одна не требует соседства', () => {
    expect(SEARCH_TOOL.name).toBe('search');
    expect(searchTerms('Курильское озеро медведи')).toEqual(['курильск', 'озер', 'медве']);
  });
});

describe('английские слова → русские основы', () => {
  it('словарь закрытый: топонимы и слова туриста; множественное число снимается', () => {
    expect(translateEn('bears')).toEqual(['медве']);
    expect(translateEn('geysers')).toEqual(['гейзер']);
    expect(translateEn('volcanoes')).toEqual(['вулкан']);
    expect(translateEn('Kurile')).toEqual(['курильск']);
    expect(translateEn('unicorn')).toBeNull();
    for (const stems of Object.values(EN_TO_RU)) {
      for (const s of stems) expect(s).toMatch(/^[а-я]+$/);
    }
  });

  it('«Kurile Lake bears» ищется теми же основами, что русский пример', () => {
    expect(searchTerms('Kurile Lake bears')).toEqual(['курильск', 'озер', 'медве']);
  });

  it('неизвестная латиница остаётся как есть — «не нашли», а не «нет»', () => {
    expect(searchTerms('Zzyzx lake')).toEqual(['zzyzx', 'озер']);
  });
});

describe('служебные слова, пустота и потолок', () => {
  it('предлоги и артикли не ищутся; дубли схлопываются', () => {
    expect(searchTerms('сплав по реке Быстрая и рыбалка')).toEqual(['спла', 'реке', 'быстр', 'рыбал']);
    expect(searchTerms('the lake of the lakes')).toEqual(['озер']);
  });

  it('если значимых слов не осталось — ищется вся строка, пустого набора нет', () => {
    expect(searchTerms('и на')).toEqual(['и на']);
  });

  it(`не больше ${MAX_TERMS} слов`, () => {
    const q = 'вулкан озеро гейзер медведь сплав рыбалка вертолёт пляж';
    expect(searchTerms(q)).toHaveLength(MAX_TERMS);
  });
});

describe('SQL по словам', () => {
  it('каждое слово — свой параметр, запись проходит по любому, hits считает совпавшие', () => {
    const { where, hits } = termSql(['p.name', "COALESCE(p.description, '')"], 2);
    expect(where).toBe("(p.name ILIKE $2 OR COALESCE(p.description, '') ILIKE $2) OR (p.name ILIKE $3 OR COALESCE(p.description, '') ILIKE $3)");
    expect(hits).toBe("((p.name ILIKE $2 OR COALESCE(p.description, '') ILIKE $2))::int + ((p.name ILIKE $3 OR COALESCE(p.description, '') ILIKE $3))::int");
    expect(() => termSql(['x'], 0)).toThrow();
  });

  it('параметры: строка для similarity и шаблон ILIKE с экранированием на каждое слово', () => {
    expect(searchParams('Курильское озеро')).toEqual(['Курильское озеро', '%курильск%', '%озер%']);
    // Знаки шаблона до ILIKE доходят только в запросе без значимых слов (вся строка целиком) — и экранируются.
    expect(searchParams('% _')).toEqual(['% _', '%\\% \\_%']);
  });

  it('четыре запроса ранжируют сперва по hits, потом по похожести; гейты витрины на месте', () => {
    const sql = searchSql(3);
    for (const kind of ['tour', 'place', 'stay', 'route'] as const) {
      expect(sql[kind]).toMatch(/ AS hits\n/);
      expect(sql[kind]).toMatch(/ORDER BY hits DESC, similarity\(/);
      expect(sql[kind]).toContain('ILIKE $4');
      expect(sql[kind]).not.toContain('ILIKE $5');
      expect(sql[kind]).not.toMatch(/\|\| *'%'/);
    }
    expect(sql.tour).toMatch(/ot\.is_active = true AND ot\.is_published = true AND ot\.deleted_at IS NULL/);
    expect(sql.place).toMatch(/p\.is_visible = TRUE AND p\.merged_into_id IS NULL/);
    expect(sql.stay).toMatch(/a\.is_active = true AND a\.moderation_status = 'approved'/);
    expect(sql.route).toMatch(/r\.is_visible = TRUE/);
  });
});
