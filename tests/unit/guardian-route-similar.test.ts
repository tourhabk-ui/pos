/**
 * Похожее название маршрута — подсказка, а не совпадение (#3302, срез 5).
 *
 * Четвёртый вариант запроса из issue — «Вилючинские водопады» — не находил
 * ни места, ни маршрута: поиск идёт по словам, а слова стоят в другом числе.
 * Ответ был «ничего нет» при маршруте «Вилючинский водопад» на витрине.
 *
 * Правило — по образцу слабого совпадения мест: похожее название называется
 * с пометкой «совпадение неточное», данные не прикладываются, человек
 * подтверждает, о нём ли речь. Оценка «Осторожно» или «Не сегодня» при этом
 * не роняется молча — идёт с рамкой неуверенности и с меткой в скобках,
 * которую читает сторож утверждений Кузьмича.
 *
 * Сторож — вызовами на подменённой базе (CLAUDE.md §4: поведение, не текст).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  getGuardianContextDetailed, isSimilarRouteTitle, routeSimilarLines, routesSimilarTo, ROUTE_SIMILAR_MAX,
  type RouteFactsSource,
} from '@/lib/kuzmich/guardian-context';
import { composePlaceInfo, placeInfoForKuzmich, similarRoutesInfoLine, ROUTE_TODAY_POINTER } from '@/lib/kuzmich/place-info-tool';
import { executeKuzmichTool, WEB_NOT_BASE } from '@/lib/kuzmich/core';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';
import { goVerdict, type RouteSignals } from '@/lib/routes/go-verdict';
import { GREEN_BUTTON } from '@/lib/safety/park-permit';

const CARD_ID = 'a0000000-0000-4000-8000-0000000000aa';
const DB_ID = 'b0000000-0000-4000-8000-0000000000bb';
const waterfall: RouteFactsSource = {
  id: CARD_ID, db_id: DB_ID, slug: 'vilyuchinskij-vodopad', title: 'Вилючинский водопад',
  mchs_registration_required: false, park_name: 'Природный парк «Вилючинский»',
};
const PLACE = {
  id: 'place-1', name: 'Вилючинские водопады', description: null, category: null, district: null, is_visible: true,
  location_type: 'waterfall', lat: 52.69, lng: 158.25, aliases: null, active_alerts: [], alert_message: null,
};
const CLOSURE = 'Закрыты маршруты природного парка «Вилючинский»';
const closureAlert = { title: CLOSURE, severity: 2, alert_type: 'park_closure', zonal: false };

interface World {
  places?: unknown[];
  /** Маршруты по точным словам. */
  named?: unknown[] | Error;
  /** Маршруты по основам слов (похожие названия). */
  similar?: unknown[] | Error;
  routeAlerts?: unknown[] | Error;
}
let calls: Array<{ sql: string; params: unknown[] }> = [];
const SIMILAR_SQL_MARK = "translate(kr.title, 'ёЁ', 'еЕ') ILIKE";

function db(w: World = {}) {
  calls = [];
  const reply = (v: unknown[] | Error | undefined, dflt: unknown[] = []) => {
    const x = v ?? dflt;
    return x instanceof Error ? Promise.reject(x) : Promise.resolve({ rows: x });
  };
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    // Тревоги маршрута — первым правилом: их предикат сам читает kamchatka_routes kr.
    if (sql.includes('JOIN ark ON')) return reply(w.routeAlerts);
    if (sql.includes('zone, season, lat')) return reply([{ id: params[0], zone: 'avachinsky', season: null, lat: '52.69', lng: '158.25' }]);
    if (sql.includes(SIMILAR_SQL_MARK)) return reply(w.similar);
    if (sql.includes('FROM kamchatka_routes kr')) return reply(w.named);
    if (sql.includes('FROM places p')) return reply(w.places);
    return Promise.resolve({ rows: [] });
  });
}
const similarCalls = () => calls.filter((c) => c.sql.includes(SIMILAR_SQL_MARK));

const fetchMock = vi.fn();
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.TAVILY_API_KEY = 'test-key';
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ results: [{ title: 'Турагентство', content: 'Водопады' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TAVILY_API_KEY;
});

describe('похоже ли название маршрута на запрос', () => {
  it('другое число и падеж — похоже', () => {
    expect(isSimilarRouteTitle('Вилючинские водопады', 'Вилючинский водопад')).toBe(true);
    expect(isSimilarRouteTitle('к Вилючинскому водопаду', 'Вилючинский водопад')).toBe(true);
    expect(isSimilarRouteTitle('маршрут Вилючинские водопады', 'Вилючинский водопад')).toBe(true);
    expect(isSimilarRouteTitle('Таловские источники', 'Тропа к Таловским источникам')).toBe(true);
  });
  it('каждое слово запроса должно найти своё слово в названии', () => {
    // «Авачинская бухта» — не «Авачинский перевал»: слова «бухта» в названии нет.
    expect(isSimilarRouteTitle('Авачинская бухта', 'Авачинский перевал')).toBe(false);
    expect(isSimilarRouteTitle('Вилючинские водопады зимой', 'Вилючинский водопад')).toBe(false);
    expect(isSimilarRouteTitle('Мутновские водопады', 'Вилючинский водопад')).toBe(false);
  });
  it('запрос из одних общих слов не похож ни на что', () => {
    expect(isSimilarRouteTitle('водопады', 'Вилючинский водопад')).toBe(false);
    expect(isSimilarRouteTitle('вулканы и озёра', 'Вулкан Горелый и озеро')).toBe(false);
    expect(isSimilarRouteTitle('маршруты', 'Вилючинский водопад')).toBe(false);
    expect(isSimilarRouteTitle('', 'Вилючинский водопад')).toBe(false);
  });
});

describe('чтение похожих названий', () => {
  it('в базу уходят шаблоны слов, а не сырой запрос; строки сверяются по основам', async () => {
    db({ similar: [waterfall, { ...waterfall, id: 'x', db_id: 'y', title: 'Тропа вдоль Вилючинского водопровода' }] });
    const rows = await routesSimilarTo('Вилючинские водопады');
    expect(similarCalls()).toHaveLength(1);
    expect(similarCalls()[0]!.params).toEqual(['%вилючинс%', '%водоп%']);
    // «водопровод» — не «водопад»: шаблон SQL шире правила, сверка его отсекает.
    expect(rows?.map((r) => r.title)).toEqual(['Вилючинский водопад']);
    expect(isSimilarRouteTitle('Вилючинские водопады', 'Тропа вдоль Вилючинского водопровода')).toBe(false);
  });
  it('не больше трёх названий; строка без id базы в подсказку не идёт', async () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...waterfall, id: `c${n}`, db_id: `d${n}`, title: `Вилючинский водопад ${n}` }));
    db({ similar: [{ ...waterfall, db_id: null }, ...many] });
    const rows = await routesSimilarTo('Вилючинские водопады');
    expect(rows).toHaveLength(ROUTE_SIMILAR_MAX);
    expect(rows?.every((r) => Boolean(r.db_id))).toBe(true);
  });
  it('одни короткие или одни общие слова — база не спрашивается', async () => {
    db({ similar: [waterfall] });
    expect(await routesSimilarTo('мыс юг')).toEqual([]);
    // Короткие слова по основе не сходятся ни с чем, кроме самих себя, — это уже нашёл бы поиск по точным словам.
    expect(await routesSimilarTo('мыс Лот')).toEqual([]);
    expect(await routesSimilarTo('Три Зуба')).toEqual([]);
    expect(await routesSimilarTo('   ')).toEqual([]);
    expect(await routesSimilarTo('водопады')).toEqual([]);
    expect(await routesSimilarTo('маршруты к вулканам и озёрам')).toEqual([]);
    expect(similarCalls()).toHaveLength(0);
    // Страж с запросом из общих слов за похожими названиями не ходит;
    // «вулканы» — и за точными (kuzmich-route-facts держит это отдельно).
    await getGuardianContextDetailed('водопады');
    expect(similarCalls()).toHaveLength(0);
    db({ similar: [waterfall] });
    await getGuardianContextDetailed('вулканы');
    expect(calls.filter((c) => c.sql.includes('FROM kamchatka_routes kr'))).toHaveLength(0);
  });
  it('отказ базы — null и запись в лог, а не «похожих нет»', async () => {
    db({ similar: new Error('boom') });
    expect(await routesSimilarTo('Вилючинские водопады')).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('страж: похожее название — с пометкой, без приложенных данных', () => {
  it('спокойный день: маршрут назван подсказкой, оценки, данных и условий посещения нет', async () => {
    db({ similar: [waterfall] });
    const d = await getGuardianContextDetailed('Вилючинские водопады');
    expect(d.text).toContain('Ни места, ни маршрута с названием «Вилючинские водопады» в справочнике Ведара не нашлось');
    expect(d.text).toContain('Это НЕ значит, что там безопасно.');
    expect(d.text).toContain('(!) Похожее название в каталоге Ведара — маршрут «Вилючинский водопад»: совпадение с запросом «Вилючинские водопады» неточное, данные этого маршрута не приложены.');
    expect(d.text).toContain('Уточни у пользователя, о нём ли речь, и спроси по точному названию.');
    // Ничего, что утверждало бы факты о маршруте: ни оценки, ни данных, ни разрешения.
    expect(d.text).not.toContain('Оценка маршрута на сегодня —');
    expect(d.text).not.toContain('Маршрут каталога «Вилючинский водопад»');
    expect(d.text).not.toContain('Данные маршрута из базы');
    expect(d.text).not.toContain('Условия посещения');
    expect(d.text).not.toContain(GREEN_BUTTON.name);
    expect(d.text).not.toContain('Но у маршрута с похожим названием');
    expect(d.text).not.toMatch(/\[(НЕ СЕГОДНЯ|ОСТОРОЖНО)\]/);
    expect(d.found).toBe(false);
    expect(d.places).toEqual([]);
    expect(d.routes).toEqual([{
      id: CARD_ID, title: 'Вилючинский водопад', url: 'https://vedarai.ru/routes/vilyuchinskij-vodopad',
      today: 'go', code: 'clear', reason: 'Предупреждений и опасных кодов на маршруте нет',
      unknown: [], alerts: [], park_name: 'Природный парк «Вилючинский»', match: 'low',
    }]);
  });

  it('у похожего маршрута запрет — он не теряется: строка с рамкой неуверенности и меткой', async () => {
    db({ similar: [waterfall], routeAlerts: [closureAlert] });
    const d = await getGuardianContextDetailed('Вилючинские водопады');
    expect(d.text).toContain('(!) Похожее название в каталоге Ведара — маршрут «Вилючинский водопад»');
    expect(d.text).toContain(`Но у маршрута с похожим названием «Вилючинский водопад» [НЕ СЕГОДНЯ] оценка на сегодня — «Не сегодня»: МЧС: ${CLOSURE}. Уточни, о нём ли речь.`);
    expect(d.routes[0]).toMatchObject({ match: 'low', today: 'no', code: 'alert_ban', alerts: [CLOSURE] });
    // Сторож утверждений Кузьмича читает метку: «можно идти» получает поправку.
    const guard = guardSafetyClaims('К водопадам сегодня можно идти.', [
      { name: 'get_guardian_context', args: {}, producedData: true, output: d.text },
    ]);
    expect(guard.verdict).toBe('contradicted');
  });

  it('сигналы похожего маршрута не прочитались — «Осторожно» тоже называется', async () => {
    db({ similar: [waterfall], routeAlerts: new Error('boom') });
    const d = await getGuardianContextDetailed('Вилючинские водопады');
    expect(d.text).toMatch(/Но у маршрута с похожим названием «Вилючинский водопад» \[ОСТОРОЖНО\] оценка на сегодня — «Осторожно»: /);
    expect(d.routes[0]).toMatchObject({ match: 'low', today: 'caution', alerts: null });
  });

  it('маршрут по точным словам есть — похожие не спрашиваются, совпадение сильное', async () => {
    db({ named: [{ ...waterfall, difficulty: 'easy' }], similar: [{ ...waterfall, id: 'other', db_id: 'other', title: 'Вилючинский водопад зимний' }] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(similarCalls()).toHaveLength(0);
    expect(d.text).toContain('Маршрут каталога «Вилючинский водопад»');
    expect(d.text).not.toContain('(!) Похожее название');
    expect(d.routes.map((r) => r.match)).toEqual(['high']);
  });

  it('маршрут по точным словам есть, но совпадение слабое — его данные идут своей строкой, подсказки о нём нет', async () => {
    // «лючинский» стоит внутри слова названия: поиск по словам находит, сильным совпадение не считается.
    db({ named: [{ ...waterfall, distance_km: '1.9' }], similar: [waterfall] });
    const d = await getGuardianContextDetailed('Лючинский водопад');
    expect(similarCalls()).toHaveLength(0);
    expect(d.routes).toEqual([]);
    expect(d.text).toContain('Вилючинский водопад');
    expect(d.text).not.toContain('(!) Похожее название');
    expect(d.text).not.toContain('данные этого маршрута не приложены');
  });

  it('есть видимое место с сильным совпадением — ответ о месте, похожие маршруты не спрашиваются', async () => {
    db({ places: [PLACE], similar: [waterfall] });
    const d = await getGuardianContextDetailed('Вилючинские водопады');
    expect(similarCalls()).toHaveLength(0);
    expect(d.found).toBe(true);
    expect(d.routes).toEqual([]);
    expect(d.text).not.toContain('(!) Похожее название');
  });

  it('каталог маршрутов не прочитался — второй раз по основам не спрашиваем', async () => {
    db({ named: new Error('boom'), similar: [waterfall] });
    const d = await getGuardianContextDetailed('Вилючинские водопады');
    expect(similarCalls()).toHaveLength(0);
    expect(d.routes).toEqual([]);
  });

  it('похожих нет или их чтение отказало — ответ пустой, как прежде, а не выдуманный', async () => {
    db({ similar: [] });
    expect(await getGuardianContextDetailed('Вилючинские водопады')).toEqual({ text: '', found: false, places: [], routes: [] });
    db({ similar: new Error('boom') });
    expect(await getGuardianContextDetailed('Вилючинские водопады')).toEqual({ text: '', found: false, places: [], routes: [] });
    expect(errors).toHaveBeenCalled();
  });
});

describe('строки о похожем маршруте', () => {
  const today = (signals: RouteSignals) => ({ verdict: goVerdict(signals), signals });
  const calm: RouteSignals = { alerts: [], volcanoes: [], inSeason: null, weather: null, closures: [] };

  it('«Идти» — одна строка-подсказка: о безопасности похожего маршрута ничего не утверждается', () => {
    const lines = routeSimilarLines('Вилючинские водопады', waterfall, today(calm));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/Идти|можно|безопасн/i);
  });
  it('причина оценки не кончается двумя точками', () => {
    const lines = routeSimilarLines('Вилючинские водопады', waterfall, today({ ...calm, alerts: [{ title: 'Парк закрыт.', severity: 2, type: 'park_closure', zonal: false }] }));
    expect(lines[1]).toContain('«Не сегодня»: МЧС: Парк закрыт. Уточни, о нём ли речь.');
    expect(lines[1]).not.toContain('..');
  });
});

describe('справка get_place_info: похожее название — подсказкой', () => {
  it('MCP: ни места, ни маршрута по точным словам — названо похожее, данные не приложены', async () => {
    db({ similar: [waterfall] });
    const text = await executeKuzmichTool('get_place_info', { name: 'Вилючинские водопады' }, { surface: 'mcp' });
    expect(text).toContain('Ни места, ни маршрута с названием «Вилючинские водопады» в справочнике не нашлось');
    expect(text).toContain(similarRoutesInfoLine(['Вилючинский водопад']));
    expect(text).toContain('Похожие названия маршрутов в каталоге Ведара: «Вилючинский водопад» — совпадение с запросом неточное, данные этих маршрутов не приложены.');
    expect(text).toContain('Уточни у пользователя, о каком маршруте речь, и спроси по точному названию.');
    expect(text).toContain(ROUTE_TODAY_POINTER);
    expect(text).not.toContain('дистанция');
    expect(text).not.toContain('Условия посещения');
    expect(text).not.toContain('В каталоге Ведара есть маршрут с этими словами');
  });
  it('чат: платный веб-поиск не зовётся — похожее название есть в своём каталоге', async () => {
    db({ similar: [waterfall] });
    const text = await executeKuzmichTool('get_place_info', { name: 'Вилючинские водопады' });
    expect(text.startsWith(WEB_NOT_BASE)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain('«Вилючинский водопад»');
  });
  it('маршрут по точным словам есть или место найдено — похожие не спрашиваются', async () => {
    db({ named: [waterfall], similar: [waterfall] });
    await placeInfoForKuzmich('Вилючинский водопад');
    expect(similarCalls()).toHaveLength(0);
    db({ places: [PLACE], similar: [waterfall] });
    await placeInfoForKuzmich('Вилючинские водопады');
    expect(similarCalls()).toHaveLength(0);
  });
  it('похожих нет — справка пустая, как прежде (в чате дальше идёт веб-поиск)', async () => {
    db({ similar: [] });
    expect(await placeInfoForKuzmich('Вилючинские водопады')).toBeNull();
  });
  it('названный маршрут главнее подсказки: похожие названия рядом с ним не печатаются', () => {
    const text = composePlaceInfo('Вилючинский водопад', [], [], { namedRoutes: [waterfall], similarRouteTitles: ['Другой маршрут'] });
    expect(text).toContain('В каталоге Ведара есть маршрут с этими словами в названии');
    expect(text).not.toContain('Похожие названия маршрутов');
  });
  it('у найденного места подсказки нет; при одной заметке Кузьмича — есть, рядом с ней', () => {
    const withPlace = composePlaceInfo('Вилючинские водопады', [PLACE], [], { similarRouteTitles: ['Вилючинский водопад'] });
    expect(withPlace).not.toContain('Похожие названия маршрутов');
    const withNote = composePlaceInfo('Вилючинские водопады', [], [{ title: 'Вилючинские водопады', compiled_truth: 'Заметка.' }], {
      similarRouteTitles: ['Вилючинский водопад'],
    });
    expect(withNote).toContain('Ниже только заметка Кузьмича');
    expect(withNote).toContain(similarRoutesInfoLine(['Вилючинский водопад']));
  });
});
