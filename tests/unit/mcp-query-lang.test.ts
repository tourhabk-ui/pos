/**
 * Сторож lib/mcp/query-lang: английский и китайский запрос к читающим
 * инструментам MCP переводится в русские слова словаря до поиска в базе.
 * Запросы — те, что 17.10 на живом /api/mcp дали «нет в справочнике» или
 * пустой список (прогон 50 вопросов: zh 0/10, en 10/15).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectQueryLang, localizeQuery, localizeToolArgs, langNote } from '@/lib/mcp/query-lang';
import { searchTerms } from '@/lib/mcp/search-terms';

describe('detectQueryLang', () => {
  it('по письменности', () => {
    expect(detectQueryLang('观熊')).toBe('zh');
    expect(detectQueryLang('Mutnovsky')).toBe('en');
    expect(detectQueryLang('Мутновский')).toBe('ru');
    expect(detectQueryLang('123')).toBe('other');
  });
});

describe('localizeQuery — провалы прогона 17.10', () => {
  const cases: Array<[string, string]> = [
    ['Mutnovsky', 'Мутновский'],
    ['Avachinsky', 'Авачинский'],
    ['Avacha Bay', 'Авачинская бухта'],
    ['Gorely', 'Горелый'],
    ['Klyuchevskoy', 'Ключевская'],
    ['Valley of Geysers helicopter', 'Долина гейзеров вертолёт'],
    ['hiking and hot springs', 'трекинг and термальные источники'],
    ['间歇泉谷', 'Долина гейзеров'],
    ['彼得罗巴甫洛夫斯克', 'Петропавловск-Камчатский'],
    ['克柳切夫', 'Ключевская'],
    ['帕拉通卡', 'Паратунка'],
    ['火山', 'вулкан'],
    ['钓鱼', 'рыбалка'],
    ['观熊', 'медведи'],
    ['穆特诺夫斯基', 'Мутновский'],
  ];
  for (const [q, ru] of cases) {
    it(`${q} → ${ru}`, () => expect(localizeQuery(q).text).toBe(ru));
  }

  it('китайская фраза без пробелов: слова словаря, служебные иероглифы отброшены', () => {
    expect(localizeQuery('堪察加 火山 旅游').text).toBe('Камчатка вулкан тур');
    expect(localizeQuery('火山和熊').text).toBe('вулкан медведи');
    expect(localizeQuery('接送 火山').text).toBe('трансфер вулкан');
  });

  it('русское не трогается, незнакомое остаётся как было', () => {
    expect(localizeQuery('Долина гейзеров')).toEqual({ text: 'Долина гейзеров', lang: 'ru', mapped: [] });
    expect(localizeQuery('Zzyzx').text).toBe('Zzyzx');
    expect(localizeQuery('什么').text).toBe('什么');
  });

  it('китайский запрос даёт непустой русский поиск у search (раньше results: [])', () => {
    expect(searchTerms(localizeQuery('观熊').text)).toEqual(['медве']);
    expect(searchTerms(localizeQuery('堪察加 火山 旅游').text)).toEqual(['камчат', 'вулк', 'тур']);
  });
});

describe('localizeToolArgs', () => {
  it('переводит поля читающих инструментов', () => {
    expect(localizeToolArgs('get_weather', { place: 'Mutnovsky' }).args).toEqual({ place: 'Мутновский' });
    expect(localizeToolArgs('get_place_info', { name: 'Avacha Bay' }).args).toEqual({ name: 'Авачинская бухта' });
    expect(localizeToolArgs('search_transfers', { place: 'Gorely' }).args).toEqual({ place: 'Горелый' });
    expect(localizeToolArgs('get_tours', { activity_type: '钓鱼' }).args).toEqual({ activity_type: 'рыбалка' });
    expect(localizeToolArgs('make_trip_plan', { days: '7', interests: '火山和熊' }).args).toEqual({ days: '7', interests: 'вулкан медведи' });
  });

  it('пишущие инструменты не трогает: там имя и телефон человека', () => {
    const args = { name: 'John', phone: '+1 555', comment: 'volcano' };
    expect(localizeToolArgs('create_lead', args)).toEqual({ args, lang: 'ru', mapped: [] });
  });

  it('пометка о языке — только для en/zh и без выдуманных фактов', () => {
    const r = localizeToolArgs('get_volcano_status', { volcano: '克柳切夫' });
    expect(r.lang).toBe('zh');
    const note = langNote(r.lang, r.mapped);
    expect(note).toContain('Chinese (zh)');
    expect(note).toContain('克柳切夫 → Ключевская');
    expect(note).toContain('do not add facts');
    expect(langNote('ru', [])).toBe('');
  });
});

// Ранг тура: «Долина гейзеров» — вертолётный тур, а не «Малая Долина гейзеров».
const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
  transaction: vi.fn(),
}));

describe('resolveTourByQuery — ранг и запасной поиск по словам', () => {
  beforeEach(() => poolQueryMock.mockReset());

  it('начало названия выше вхождения; длина названия и цена продавца не выбирают (29.10)', async () => {
    const { resolveTourByQuery } = await import('@/lib/kuzmich/tour-availability-tool');
    // Ранг считает база; резолвер берёт лучший. Строка с рангом 2 («Малая
    // Долина гейзеров») другой компании исход не делает неоднозначным.
    // Поиск продавца по имени (29.10) продавца не находит — пусто.
    poolQueryMock.mockImplementation(async (sql: string) => ({ rows: /FROM partners p/.test(sql) ? [] : [
      { id: 31, title: 'Дачные источники (Малая Долина гейзеров)', operator_id: 'b', rank: 2 },
      { id: 54, title: 'Долина гейзеров (вертолёт)', operator_id: 'a', rank: 1 },
    ] }));
    const t = await resolveTourByQuery('Долина гейзеров');
    expect(t?.id).toBe(54);
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toMatch(/WHEN translate\(ot\.title, 'Ёё', 'Ее'\) ILIKE \$3 THEN 1 WHEN translate\(ot\.title, 'Ёё', 'Ее'\) ILIKE \$1 THEN 2/);
    expect(sql).not.toMatch(/length\(ot\.title\)|base_price ASC/);
    expect(params).toEqual(['%Долина гейзеров%', 'Долина гейзеров', 'Долина гейзеров%']);
  });

  // Запрос по основам узнаётся по отметкам совпадений (stem_hits); фраза и
  // поиск продавца по имени (29.10) отвечают пусто.
  const byStems = (rows: unknown[]) => async (sql: string) => ({ rows: /stem_hits/.test(sql) ? rows : [] });

  it('фраза целиком не нашлась → по основам слов (Avachinsky ascent после перевода)', async () => {
    const { resolveTourByQuery } = await import('@/lib/kuzmich/tour-availability-tool');
    poolQueryMock.mockImplementation(byStems([{ id: 62, title: 'Восхождение на Авачинский вулкан', stem_hits: [true, true] }]));
    const t = await resolveTourByQuery(localizeQuery('Avachinsky ascent').text);
    expect(t?.id).toBe(62);
    const [, params] = poolQueryMock.mock.calls.find(([sql]) => /stem_hits/.test(sql)) ?? [];
    expect(params).toEqual(['%авачинск%', '%восхожден%']);
  });

  it('по основам совпала только часть слов — тур «не найден» как один (ловушка 29.10, name-search)', async () => {
    // «Авачинский перевал» несёт «авачинск», но не «восхожден»: частичное
    // совпадение старый вход «один тур» за найденный не выдаёт.
    const { resolveTourByQuery } = await import('@/lib/kuzmich/tour-availability-tool');
    poolQueryMock.mockImplementation(byStems([{ id: 62, title: 'Авачинский перевал', stem_hits: [true, false] }]));
    expect(await resolveTourByQuery(localizeQuery('Avachinsky ascent').text)).toBeNull();
  });

  it('одно слово без совпадений — запроса по основам нет, «тура нет»', async () => {
    const { resolveTourByQuery } = await import('@/lib/kuzmich/tour-availability-tool');
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await resolveTourByQuery('несуществующее')).toBeNull();
    expect(poolQueryMock.mock.calls.some(([sql]) => /stem_hits/.test(sql))).toBe(false);
  });
});
