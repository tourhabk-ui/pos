/**
 * Нечёткий поиск (владелец 21.11): «дигерен» не находил «Дыгерен-Оленгендэ».
 * Реальный PostgreSQL — tests/integration/mcp-search.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { normRu, fuzzyMatchSql, FUZZY_MIN } from '@/lib/search/fuzzy';
import { routesSearchQuery, placesSearchQuery } from '@/lib/search/geo-query';
import { showRouteFallback } from '@/lib/search/place-route-fallback';

describe('normRu', () => {
  it('и/ы, е/ё/э, й — одна буква; регистр не важен', () => {
    expect(normRu('Дыгерен-Оленгендэ')).toBe(normRu('дигерен-оленгенде'));
    expect(normRu('Ёлка Эйва')).toBe('елка еива');
  });
});

describe('SQL', () => {
  it('нормализация с обеих сторон и порог триграмм для слов от 4 букв', () => {
    const s = fuzzyMatchSql('title', '$5');
    expect(s).toContain("translate(lower(title), 'ёэый', 'ееии')");
    expect(s).toContain('strpos(');
    expect(s).toContain(`word_similarity($5, translate(lower(title), 'ёэый', 'ееии')) >= ${FUZZY_MIN}`);
    expect(s).toContain('char_length($5) >= 4');
  });

  it('маршруты и места: слово запроса уходит нормализованным параметром, предел — последний', () => {
    for (const built of [routesSearchQuery('Дыгерен', 7), placesSearchQuery('Дыгерен', 7)]) {
      expect(built.params.at(-1)).toBe(7);
      expect(built.params.some((p) => typeof p === 'string' && p.startsWith('дигер') && !p.includes('%'))).toBe(true);
      expect(built.sql).toMatch(/word_similarity\(\$3,/);
      expect(built.sql).toMatch(/LIMIT \$4/);
    }
  });
});

describe('вкладка «Места»: маршруты, когда мест нет', () => {
  it('только при запросе, нуле мест, без загрузки и ошибки', () => {
    const base = { kind: 'place', query: 'дигерен', placesCount: 0, loading: false, error: false };
    expect(showRouteFallback(base)).toBe(true);
    expect(showRouteFallback({ ...base, kind: 'route' })).toBe(false);
    expect(showRouteFallback({ ...base, query: '  ' })).toBe(false);
    expect(showRouteFallback({ ...base, placesCount: 2 })).toBe(false);
    expect(showRouteFallback({ ...base, loading: true })).toBe(false);
    expect(showRouteFallback({ ...base, error: true })).toBe(false);
  });
});
