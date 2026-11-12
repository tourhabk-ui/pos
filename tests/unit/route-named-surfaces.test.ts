/**
 * Маршрут каталога без записи места — на остальных поверхностях агента
 * (#3302, срез 3): справка `get_place_info`, документ `fetch("route:…")` и
 * ссылка «Продолжить в Ведаре».
 *
 * После среза 1 страж отвечал о маршруте оценкой на сегодня, а рядом
 * оставалось три места, где о нём молчали:
 *  - `get_place_info("Вилючинский водопад")` — «Места нет в справочнике… ничего
 *    нет»; в чате Кузьмича дальше шёл платный веб-поиск, хотя маршрут с таким
 *    названием лежит в собственном каталоге;
 *  - `fetch("route:vilyuchinskij-vodopad")` — длина, набор высоты и парк, и ни
 *    слова о сегодняшнем дне. Коннекторы, которые зовут только search и
 *    fetch, другого пути к оценке не имеют;
 *  - ссылки на карточку маршрута под ответом не было: она искала только место.
 *
 * Сторож — вызовами на подменённой базе (CLAUDE.md §4: поведение, не текст).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { composePlaceInfo, namedRoutesInfoLines, placeInfoForKuzmich, ROUTE_TODAY_POINTER } from '@/lib/kuzmich/place-info-tool';
import { executeKuzmichTool, WEB_NOT_BASE } from '@/lib/kuzmich/core';
import { routesNamedBy, type RouteFactsSource } from '@/lib/kuzmich/guardian-context';
import { handoffTargetForTool } from '@/lib/mcp/handoff-targets';
import { isSafeTarget } from '@/lib/mcp/handoff';
import { fetchDocument } from '@/lib/mcp/connector-tools';

const CARD_ID = 'a0000000-0000-4000-8000-0000000000aa';
const DB_ID = 'b0000000-0000-4000-8000-0000000000bb';
const waterfall: RouteFactsSource = {
  id: CARD_ID, db_id: DB_ID, slug: 'vilyuchinskij-vodopad', title: 'Вилючинский водопад',
  difficulty: 'easy', distance_km: '1.9', elevation_gain_m: 325, duration_hours: null, season: null,
  hazards: null, equipment: null, mchs_registration_required: false, mchs_phone: null,
  park_name: 'Природный парк «Вилючинский»', description: null,
};
const PLACE = {
  id: 'place-1', name: 'Вилючинский водопад', description: null, category: null, district: null, is_visible: true,
  location_type: 'waterfall', lat: 52.69, lng: 158.25,
};
const CLOSURE = 'Закрыты маршруты природного парка «Вилючинский»';

interface World {
  places?: unknown[];
  notes?: unknown[];
  named?: unknown[] | Error;
  /** Строка маршрута для fetch (v_kamchatka_routes_api). */
  viewRoute?: unknown[];
  routeAlerts?: unknown[] | Error;
}

let calls: Array<{ sql: string; params: unknown[] }> = [];

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
    if (sql.includes('FROM v_kamchatka_routes_api')) return reply(w.viewRoute);
    if (sql.includes('FROM kamchatka_routes kr')) return reply(w.named, [waterfall]);
    if (sql.includes('FROM agent_knowledge')) return reply(w.notes);
    if (sql.includes('FROM places p')) return reply(w.places);
    return Promise.resolve({ rows: [] });
  });
}

const asked = (needle: string) => calls.some((c) => c.sql.includes(needle));
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.TAVILY_API_KEY = 'test-key';
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ results: [{ title: 'Турагентство', content: 'Водопад — лучшее место' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.TAVILY_API_KEY;
});

describe('get_place_info: места нет, маршрут каталога есть', () => {
  it('MCP: маршрут назван с фактами и указателем на оценку дня, а не «ничего нет»', async () => {
    db();
    const text = await executeKuzmichTool('get_place_info', { name: 'Вилючинский водопад' }, { surface: 'mcp' });
    expect(text).toContain('Места «Вилючинский водопад» в справочнике не нашлось — тип, координаты и опасности места по этому названию неизвестны.');
    expect(text).toContain('В каталоге Ведара есть маршрут с этими словами в названии — данные из базы:');
    expect(text).toContain('«Вилючинский водопад»: дистанция 1.9 км · набор высоты 325 м · сложность easy. Охраняемая территория: Природный парк «Вилючинский»');
    expect(text).toContain(ROUTE_TODAY_POINTER);
    expect(text).not.toContain('Места нет в справочнике платформы');
    expect(text).not.toContain('уточните точное название');
    // На MCP ссылки в тексте нет — своя ссылка «Продолжить в Ведаре».
    expect(text).not.toContain('Страница маршрута на сайте');
    // Справка об оценке дня не говорит и сигналы маршрута не собирает.
    expect(text).not.toContain('Оценка маршрута на сегодня —');
    expect(asked('zone, season, lat')).toBe(false);
  });

  it('чат: ссылка на карточку маршрута есть, платный веб-поиск не зовётся — маршрут в своём каталоге', async () => {
    db();
    const text = await executeKuzmichTool('get_place_info', { name: 'Вилючинский водопад' });
    expect(text).toContain('Страница маршрута на сайте: https://vedarai.ru/routes/vilyuchinskij-vodopad');
    expect(text.startsWith(WEB_NOT_BASE)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('место есть — ответ о месте: каталог маршрутов по названию не спрашивается', async () => {
    db({ places: [PLACE] });
    const text = await placeInfoForKuzmich('Вилючинский водопад');
    expect(text).toContain('Вилючинский водопад');
    expect(text).not.toContain('В каталоге Ведара есть маршрут');
    expect(asked('FROM kamchatka_routes kr')).toBe(false);
  });

  it('ни места, ни маршрута — прежнее честное «места нет» на MCP', async () => {
    db({ named: [] });
    const text = await executeKuzmichTool('get_place_info', { name: 'Озеро Х' }, { surface: 'mcp' });
    expect(text).toMatch(/Места нет в справочнике платформы/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('каталог маршрутов не прочитался — маршрут не выдуман, отказ в логе; ответ — «места нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db({ named: new Error('boom') });
    const text = await executeKuzmichTool('get_place_info', { name: 'Вилючинский водопад' }, { surface: 'mcp' });
    expect(text).toMatch(/Места нет в справочнике платформы/);
    expect(err.mock.calls.flat().join(' ')).toContain('маршруты по названию не прочитаны');
  });

  it('два маршрута — сказано, сколько их; у каждого своя строка', () => {
    const winter = { ...waterfall, id: 'card-2', slug: 'vodopad-zima', title: 'Вилючинский водопад (зимний)' };
    const lines = namedRoutesInfoLines([waterfall, winter], { pageLinks: true });
    expect(lines[0]).toBe('В каталоге Ведара есть маршруты с этими словами в названии (2) — данные из базы:');
    expect(lines.filter((l) => l.startsWith('Страница маршрута на сайте: '))).toEqual([
      'Страница маршрута на сайте: https://vedarai.ru/routes/vilyuchinskij-vodopad',
      'Страница маршрута на сайте: https://vedarai.ru/routes/vodopad-zima',
    ]);
    expect(lines.at(-1)).toBe(ROUTE_TODAY_POINTER);
    expect(namedRoutesInfoLines([])).toEqual([]);
  });

  it('заметка Кузьмича и маршрут — названы оба; «только заметка» не говорится', () => {
    const text = composePlaceInfo('Вилючинский водопад', [], [{ title: 'Вилючинский водопад', compiled_truth: 'Зимой замерзает.' }], { namedRoutes: [waterfall] });
    expect(text).toContain('В каталоге Ведара есть маршрут с этими словами в названии');
    expect(text).toContain('Заметка Кузьмича «Вилючинский водопад»: Зимой замерзает.');
    expect(text).not.toContain('Ниже только заметка Кузьмича');
  });

  it('у найденного места маршруты по названию в справку не подмешиваются', () => {
    const text = composePlaceInfo('Вилючинский водопад', [PLACE], [], { namedRoutes: [waterfall] });
    expect(text).not.toContain('В каталоге Ведара есть маршрут');
  });
});

describe('одна мера «маршрут назван запросом» — для текста и для ссылки', () => {
  it('routesNamedBy: только сильное совпадение и только строки с id базы', async () => {
    db({ named: [waterfall, { ...waterfall, id: 'card-x', db_id: null, title: 'Вилючинский водопад (копия без id)' }] });
    expect((await routesNamedBy('Вилючинский водопад'))?.map((r) => r.id)).toEqual([CARD_ID]);
    db({ named: new Error('boom') });
    expect(await routesNamedBy('Вилючинский водопад')).toBeNull();
    expect(await routesNamedBy('   ')).toEqual([]);
  });
});

describe('ссылка «Продолжить в Ведаре» ведёт на карточку маршрута', () => {
  it('места нет, маршрут один — его карточка по slug; цель проходит белый список', async () => {
    for (const [tool, args] of [['get_guardian_context', { place: 'Вилючинский водопад' }], ['get_place_info', { name: 'Вилючинский водопад' }]] as const) {
      db();
      const target = await handoffTargetForTool(tool, args);
      expect(target, tool).toEqual({ targetType: 'place', targetPath: '/routes/vilyuchinskij-vodopad' });
      expect(isSafeTarget(target!)).toBe(true);
    }
  });

  it('у маршрута без slug — по id карточки, не по id строки', async () => {
    db({ named: [{ ...waterfall, slug: null }] });
    expect(await handoffTargetForTool('get_guardian_context', { place: 'Вилючинский водопад' }))
      .toEqual({ targetType: 'place', targetPath: `/routes/${CARD_ID}` });
  });

  it('маршрутов несколько — ссылки нет: она выбрала бы один за человека', async () => {
    db({ named: [waterfall, { ...waterfall, id: 'card-2', db_id: 'db-2', slug: 'vodopad-zima', title: 'Вилючинский водопад (зимний)' }] });
    expect(await handoffTargetForTool('get_guardian_context', { place: 'Вилючинский водопад' })).toBeNull();
  });

  it('место есть — ссылка на место, как прежде; каталог маршрутов не спрашивается', async () => {
    db({ places: [{ id: 'place-1' }] });
    expect(await handoffTargetForTool('get_guardian_context', { place: 'Вилючинский водопад' }))
      .toEqual({ targetType: 'place', targetPath: '/places/place-1' });
    expect(asked('FROM kamchatka_routes kr')).toBe(false);
  });

  it('ни места, ни маршрута — ссылки нет', async () => {
    db({ named: [] });
    expect(await handoffTargetForTool('get_place_info', { name: 'Озеро Х' })).toBeNull();
  });
});

describe('fetch("route:…"): оценка на день с датой', () => {
  const viewRoute = {
    db_id: DB_ID, key: 'vilyuchinskij-vodopad', title: 'Вилючинский водопад', description: 'Тропа идёт вдоль ручья к водопаду.',
    difficulty: 'easy', distance_km: '1.9', duration_hours: null, duration_days: null, elevation_gain_m: 325, season: null,
    route_type: null, hazards: null, equipment: null, mchs_registration_required: null,
    park_name: 'Природный парк «Вилючинский»', zone: 'avachinsky',
  };

  it('парк закрыт: в документе «Не сегодня» с датой по Камчатке, раньше описания; оценка считана по id строки', async () => {
    // 12.11 21:00 UTC — на Камчатке уже 13 ноября.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T21:00:00Z') });
    db({ viewRoute: [viewRoute], routeAlerts: [{ title: CLOSURE, severity: 2, alert_type: 'park_closure', zonal: false }] });
    const doc = await fetchDocument('route:vilyuchinskij-vodopad', 'https://vedarai.ru');

    expect(doc.text).toContain('Обстановка по маршруту на 13.11 (по Камчатке; позже этой даты — спросите заново, инструмент get_guardian_context):');
    expect(doc.text).toContain(`Оценка маршрута на сегодня — «Не сегодня»: МЧС: ${CLOSURE}.`);
    expect(doc.text).toContain(`Предупреждения: ${CLOSURE}.`);
    expect(doc.text.indexOf('Оценка маршрута на сегодня')).toBeLessThan(doc.text.indexOf('Тропа идёт вдоль ручья'));
    expect(doc.text).toContain('Экстренный вызов на Камчатке — 112.');
    expect(doc.metadata).toMatchObject({ kind: 'route', today: 'no', today_code: 'alert_ban', today_date: '2026-11-13' });
    expect(calls.find((c) => c.sql.includes('zone, season, lat'))?.params).toEqual([DB_ID]);
  });

  it('спокойный день — «Идти» и «не гарантия безопасности»; сбой чтения предупреждений — «Осторожно», не «Идти»', async () => {
    db({ viewRoute: [viewRoute] });
    const calm = await fetchDocument('route:vilyuchinskij-vodopad', 'https://vedarai.ru');
    expect(calm.text).toContain('Оценка маршрута на сегодня — «Идти»');
    expect(calm.text).toContain('Это не гарантия безопасности.');
    expect(calm.metadata).toMatchObject({ today: 'go', today_code: 'clear' });

    db({ viewRoute: [viewRoute], routeAlerts: Object.assign(new Error('boom'), { code: '57014' }) });
    const blind = await fetchDocument('route:vilyuchinskij-vodopad', 'https://vedarai.ru');
    expect(blind.text).toContain('Оценка маршрута на сегодня — «Осторожно»: Данных мало: не знаем предупреждения.');
    expect(blind.text).toContain('Предупреждения: не смогли узнать.');
    expect(blind.metadata).toMatchObject({ today: 'caution', today_code: 'signals_unknown' });
  });
});
