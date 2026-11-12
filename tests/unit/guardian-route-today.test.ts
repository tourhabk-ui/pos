/**
 * Маршрут без записи места получает оценку на сегодня, а не «не найдено»
 * (#3302, слово владельца 12.11: «конечно бери это важно»).
 *
 * Проверка 12.11 через MCP: `get_guardian_context("Вилючинский водопад")`
 * отвечал `{"found":false,"places":[]}`. Маршрут опубликован в природном
 * парке, ищется и читается — а инструмент безопасности о сегодняшнем дне по
 * нему молчал: статус считается у мест, записи места с таким названием нет.
 * Оценка у маршрута при этом была — на его карточке («Идти / Осторожно /
 * Не сегодня», lib/routes/go-verdict), и до агента не доходила. При
 * следующем закрытии парка человек получил бы «ничего нет» там, где спросил.
 *
 * Сторож — вызов стража на подменённой базе: что увидит модель и что уйдёт
 * полями (CLAUDE.md §4: поведение, не текст исходника).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  getGuardianContextDetailed, routeNameWords, HIDDEN_RECORD_NOTE,
} from '@/lib/kuzmich/guardian-context';
import { verdictFactLines, VERDICT_DISCLAIMER_RU } from '@/lib/routes/verdict-facts';
import { routeTodayLines, ROUTE_ALERTS_NAMED_MAX } from '@/lib/routes/route-today';
import { goVerdict, type RouteSignals } from '@/lib/routes/go-verdict';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';

const CARD_ID = 'a0000000-0000-4000-8000-0000000000aa';
const DB_ID = 'b0000000-0000-4000-8000-0000000000bb';
const waterfall = {
  id: CARD_ID, db_id: DB_ID, slug: 'vilyuchinskij-vodopad', title: 'Вилючинский водопад',
  difficulty: 'easy', distance_km: '1.9', elevation_gain_m: 325, duration_hours: null, season: null,
  hazards: null, equipment: null, mchs_registration_required: false, mchs_phone: null,
  park_name: 'Природный парк «Вилючинский»', description: null,
};
const CLOSURE = 'Закрыты маршруты природного парка «Вилючинский»';

interface World {
  places?: unknown[];
  named?: unknown[] | Error;
  through?: unknown[];
  /** Упоминания названия в сводках (запрос стража по имени). */
  mentions?: unknown[];
  shape?: unknown[] | Error;
  points?: unknown[];
  routeAlerts?: unknown[] | Error;
  volcanoes?: unknown[] | Error;
  closures?: unknown[] | Error;
}

let calls: Array<{ sql: string; params: unknown[] }> = [];

/** Подмена базы по тексту запроса: запросы стража и сборщика сигналов маршрута. */
function db(w: World = {}) {
  calls = [];
  const reply = (v: unknown[] | Error | undefined, dflt: unknown[] = []) => {
    const x = v ?? dflt;
    return x instanceof Error ? Promise.reject(x) : Promise.resolve({ rows: x });
  };
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    // Сборщик сигналов (lib/routes/collect-signals).
    if (sql.includes('zone, season, lat')) return reply(w.shape, [{ zone: 'avachinsky', season: null, lat: '52.69', lng: '158.25' }]);
    if (sql.includes('SELECT DISTINCT p.zone')) return reply(w.points);
    if (sql.includes('JOIN ark ON')) return reply(w.routeAlerts);
    if (sql.includes('WITH anchor') && sql.includes('FROM volcano_status vs')) return reply(w.volcanoes);
    if (sql.includes('rs.is_open = FALSE')) return reply(w.closures);
    // Страж.
    if (sql.includes('FROM kamchatka_routes kr')) return reply(w.named, [waterfall]);
    if (sql.includes('FROM route_waypoints')) return reply(w.through);
    if (sql.includes('FROM external_alerts')) return reply(w.mentions);
    if (sql.includes('FROM places p')) return reply(w.places);
    return Promise.resolve({ rows: [] });
  });
}

const closureAlert = { title: CLOSURE, severity: 2, alert_type: 'park_closure', zonal: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('места нет, маршрут каталога есть — оценка на сегодня (#3302)', () => {
  it('парк закрыт: «Не сегодня» с причиной и фактами, а не «уточни название»', async () => {
    db({ routeAlerts: [closureAlert] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');

    expect(d.text).toContain('В каталоге Ведара есть маршрут «Вилючинский водопад» — ниже его оценка на сегодня и данные из базы.');
    expect(d.text).not.toContain('уточни точное название места');
    expect(d.text).toContain('Маршрут каталога «Вилючинский водопад» [НЕ СЕГОДНЯ]');
    expect(d.text).toContain(`Оценка маршрута на сегодня — «Не сегодня»: МЧС: ${CLOSURE}. Правило то же, что на карточке маршрута.`);
    expect(d.text).toContain(`Предупреждения: ${CLOSURE}.`);
    expect(d.text).toContain('Закрытые точки: администратор не отмечал.');
    expect(d.text).toContain(VERDICT_DISCLAIMER_RU);
    // Факты маршрута — в его блоке, вместе с парком.
    expect(d.text).toContain('Данные маршрута из базы Ведара: дистанция 1.9 км · набор высоты 325 м · сложность easy. Охраняемая территория: Природный парк «Вилючинский»');
    expect(d.text).toContain('Регистрация в МЧС по этому маршруту в базе не записана — это не значит, что она не нужна.');

    // Оценка стоит раньше данных маршрута: безопасность важнее описания.
    expect(d.text.indexOf('Оценка маршрута на сегодня')).toBeLessThan(d.text.indexOf('Данные маршрута из базы Ведара'));
  });

  it('поля: места нет (found=false), маршрут — в routes с оценкой, причиной и предупреждениями', async () => {
    db({ routeAlerts: [closureAlert] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.found).toBe(false);
    expect(d.places).toEqual([]);
    expect(d.routes).toEqual([{
      id: CARD_ID,
      title: 'Вилючинский водопад',
      url: 'https://vedarai.ru/routes/vilyuchinskij-vodopad',
      today: 'no',
      code: 'alert_ban',
      reason: `МЧС: ${CLOSURE}`,
      unknown: [],
      alerts: [CLOSURE],
      park_name: 'Природный парк «Вилючинский»',
    }]);
  });

  it('спокойный день: «Идти» без метки в скобках, с фактами и словами «не гарантия безопасности»', async () => {
    db();
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).toContain('Маршрут каталога «Вилючинский водопад»\n');
    expect(d.text).not.toMatch(/Маршрут каталога «Вилючинский водопад» \[/);
    expect(d.text).toContain('Оценка маршрута на сегодня — «Идти»: Предупреждений и опасных кодов на маршруте нет.');
    expect(d.text).toContain('Предупреждения: действующих нет.');
    expect(d.text).toContain('Вулканы на маршруте: в 25 км нет.');
    // «Нет закрытых» читалось бы как проверка точек — её никто не делал.
    expect(d.text).toContain('Закрытые точки: администратор не отмечал.');
    expect(d.text).toContain(`Это не гарантия безопасности. ${VERDICT_DISCLAIMER_RU}`);
    expect(d.routes[0]).toMatchObject({ today: 'go', code: 'clear', unknown: [], alerts: [] });
  });

  it('предупреждения не прочитались — «Осторожно: данных мало», а не «Идти»; alerts = null, не []', async () => {
    db({ routeAlerts: Object.assign(new Error('boom'), { code: '57014' }) });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).toContain('Маршрут каталога «Вилючинский водопад» [ОСТОРОЖНО]');
    expect(d.text).toContain('Оценка маршрута на сегодня — «Осторожно»: Данных мало: не знаем предупреждения.');
    expect(d.text).toContain('Предупреждения: не смогли узнать.');
    expect(d.routes[0]).toMatchObject({ today: 'caution', code: 'signals_unknown', unknown: ['предупреждения'], alerts: null });
  });

  it('строка маршрута в базе не нашлась при сборе сигналов — всё «не смогли узнать», оценка «Осторожно»', async () => {
    db({ shape: [] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.routes[0]).toMatchObject({
      today: 'caution', code: 'signals_unknown',
      unknown: ['предупреждения', 'вулканы на маршруте', 'закрытые точки'], alerts: null,
    });
    expect(d.text).toContain('[ОСТОРОЖНО]');
  });

  it('закрытая точка пути: «Не сегодня — Закрыто: …» с причиной точки', async () => {
    db({ closures: [{ name: 'Кордон Вилючинский', reason: 'закрыт до 20 ноября' }] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).toContain('Оценка маршрута на сегодня — «Не сегодня»: Закрыто: Кордон Вилючинский — закрыт до 20 ноября.');
    expect(d.text).toContain('Закрытые точки: Кордон Вилючинский — закрыт до 20 ноября.');
    expect(d.routes[0]).toMatchObject({ today: 'no', code: 'point_closed' });
  });

  it('оценка считается по id строки маршрута (на нём путевые точки), а не по id карточки', async () => {
    db();
    await getGuardianContextDetailed('Вилючинский водопад');
    const shape = calls.find((c) => c.sql.includes('zone, season, lat'));
    const closures = calls.find((c) => c.sql.includes('rs.is_open = FALSE'));
    expect(shape?.params).toEqual([DB_ID]);
    expect(closures?.params).toEqual([DB_ID]);
  });

  it('«маршрут Вилючинский водопад»: слово «маршрут» в названии не ищется — маршрут найден', async () => {
    db();
    const d = await getGuardianContextDetailed('маршрут Вилючинский водопад');
    const named = calls.find((c) => c.sql.includes('FROM kamchatka_routes kr'));
    expect(named?.params).toEqual(['%вилючинский%', '%водопад%']);
    expect(d.routes.map((r) => r.title)).toEqual(['Вилючинский водопад']);
    expect(routeNameWords('Маршруты к Вилючинскому водопаду')).toEqual(['вилючинскому', 'водопаду']);
    // Слово внутри названия не трогается: отброшено только само «маршрут».
    expect(routeNameWords('Маршрутный лист')).toEqual(['маршрутный', 'лист']);
  });

  it('в чате — ссылка на карточку маршрута; на MCP ссылки в тексте нет, адрес — полем', async () => {
    db();
    const chat = await getGuardianContextDetailed('Вилючинский водопад', { pageLinks: true });
    expect(chat.text).toContain('Страница маршрута на сайте: https://vedarai.ru/routes/vilyuchinskij-vodopad');
    db();
    const mcp = await getGuardianContextDetailed('Вилючинский водопад');
    expect(mcp.text).not.toContain('Страница маршрута на сайте');
    expect(mcp.routes[0]?.url).toBe('https://vedarai.ru/routes/vilyuchinskij-vodopad');
  });

  it('у маршрута без slug адрес — по id карточки, не по id строки', async () => {
    db({ named: [{ ...waterfall, slug: null }] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.routes[0]?.url).toBe(`https://vedarai.ru/routes/${CARD_ID}`);
  });

  it('маршрут назван один раз: в общий список «Маршруты каталога к этому месту» он второй раз не идёт', async () => {
    db();
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).not.toContain('Маршруты каталога к этому месту');
    // Название стоит трижды: в «Места «…» не нашлось», во вступлении и в заголовке блока.
    expect(d.text.split('«Вилючинский водопад»').length - 1).toBe(3);
    expect(d.text.split('Данные маршрута из базы Ведара').length - 1).toBe(1);
  });

  it('два маршрута с этим названием — у каждого свой блок и своя оценка по своему id', async () => {
    const winter = { ...waterfall, id: 'card-2', db_id: 'db-2', slug: 'vilyuchinskij-vodopad-zima', title: 'Вилючинский водопад (зимний)' };
    db({ named: [waterfall, winter] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.routes.map((r) => r.id)).toEqual([CARD_ID, 'card-2']);
    const asked = calls.filter((c) => c.sql.includes('zone, season, lat')).map((c) => c.params[0]);
    expect(asked.sort()).toEqual([DB_ID, 'db-2'].sort());
    expect(d.text).toContain('Маршрут каталога «Вилючинский водопад (зимний)»');
    // «С таким названием» про два маршрута было бы неправдой — сказано, сколько их.
    expect(d.text).toContain('В каталоге Ведара есть маршруты со словами «Вилючинский водопад» в названии (2) — ниже оценка каждого на сегодня и данные из базы.');
    expect(d.text).not.toContain('Показано не больше');
  });

  it('название совпало не целиком — не «маршрут с таким названием», а «со словами в названии»', async () => {
    db({ named: [{ ...waterfall, title: 'Вилючинский водопад и перевал' }] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).toContain('В каталоге Ведара есть маршрут со словами «Вилючинский водопад» в названии — ниже его оценка на сегодня и данные из базы.');
  });

  it('поиск отдал предел — сказано, что показано не больше четырёх, а не обрезано молча', async () => {
    const four = [1, 2, 3, 4].map((n) => ({ ...waterfall, id: `card-${n}`, db_id: `db-${n}`, slug: `kolco-${n}`, title: `Кольцо ${n}` }));
    db({ named: four });
    const d = await getGuardianContextDetailed('кольцо');
    expect(d.routes).toHaveLength(4);
    expect(d.text).toContain('в названии (4) — ниже оценка каждого на сегодня и данные из базы. Показано не больше 4: если нужного маршрута среди них нет, уточни название.');
  });

  it('предупреждение, названное в блоке маршрута, ниже упоминанием не повторяется', async () => {
    db({
      routeAlerts: [closureAlert],
      mentions: [{ title: CLOSURE, severity: 2, description: 'Вилючинский водопад закрыт.', source_url: null, external_id: 'mintur-1' }],
    });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text.split(CLOSURE).length - 1).toBe(2); // причина оценки и строка «Предупреждения»
  });

  it(`предупреждений больше ${ROUTE_ALERTS_NAMED_MAX}: названы первые, остальные — числом, не молча`, async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `Предупреждение ${i + 1}`, severity: 1, alert_type: 'weather', zonal: true }));
    db({ routeAlerts: many });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).toContain('Предупреждения: Предупреждение 1 · Предупреждение 2 · Предупреждение 3 · Предупреждение 4 · Предупреждение 5 · и ещё 3.');
    // Полями — все восемь: срез только в тексте.
    expect(d.routes[0]?.alerts).toHaveLength(8);
  });

  it('маршруты по названию не прочитались — оценки нет, сказано «проверить не удалось», а не «маршрутов нет»', async () => {
    db({ named: new Error('boom'), mentions: [{ title: 'Сводка', severity: 1, description: 'Вилючинский водопад упомянут.', source_url: null, external_id: 'x' }] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.routes).toEqual([]);
    expect(d.text).toContain('Маршруты к этому месту проверить не удалось — не говори, что их нет.');
  });
});

describe('когда ответ — о месте, а когда — о маршруте', () => {
  const PLACE = {
    id: 'place-1', is_visible: true, name: 'Вилючинский водопад', location_type: 'waterfall', description: null,
    lat: 52.69, lng: 158.25, recommender_status: 'green', status_updated_at: new Date(Date.now() - 600_000).toISOString(),
    hazard_types: [], profile_source: null, aliases: null,
  };

  it('видимое место с таким названием есть — ответ о месте: блока маршрута нет, routes пуст, факты маршрута — списком', async () => {
    db({ places: [PLACE] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.found).toBe(true);
    expect(d.routes).toEqual([]);
    expect(d.text).not.toContain('Маршрут каталога «');
    expect(d.text).not.toContain('Оценка маршрута на сегодня');
    expect(d.text).toContain('Маршруты каталога к этому месту — данные из базы Ведара:');
    // Сигналы маршрута не собирались вовсе: лишних запросов на живом пути нет.
    expect(calls.some((c) => c.sql.includes('zone, season, lat'))).toBe(false);
  });

  it('скрытая запись с таким названием цвета не даёт — маршрут получает оценку, иначе о дне не сказано бы ничего', async () => {
    db({ places: [{ ...PLACE, is_visible: false }], routeAlerts: [closureAlert] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.text).toContain(HIDDEN_RECORD_NOTE);
    // Связка между скрытой записью и блоком маршрута: дальше речь уже не о месте.
    const intro = 'В каталоге Ведара есть маршрут «Вилючинский водопад» — ниже его оценка на сегодня и данные из базы.';
    expect(d.text).toContain(intro);
    expect(d.text.indexOf(HIDDEN_RECORD_NOTE)).toBeLessThan(d.text.indexOf(intro));
    expect(d.text).toContain('Маршрут каталога «Вилючинский водопад» [НЕ СЕГОДНЯ]');
    expect(d.routes[0]?.today).toBe('no');
  });

  it('место совпало неточно (другое место) — его данные не приложены, а маршрут с точным названием оценён', async () => {
    // «Южно-Камчатский транзит» подставлен псевдонимом к другому месту: имя места запрос не покрывает.
    const other = { ...PLACE, id: 'place-2', name: 'Кордон', aliases: ['Южный транзитный кордон камчатский'] };
    const transit = { ...waterfall, id: 'card-t', db_id: 'db-t', slug: 'visitkamchatka-ukp-tranzit', title: 'Южно-Камчатский: транзитный', park_name: 'Южно-Камчатский' };
    db({ places: [other], named: [transit] });
    const d = await getGuardianContextDetailed('Южно-Камчатский: транзитный');
    expect(d.text).toContain('неточное совпадение по названию');
    expect(d.text).toContain('Маршрут каталога «Южно-Камчатский: транзитный»');
    expect(d.routes.map((r) => r.id)).toEqual(['card-t']);
  });

  it('маршрут без id строки (не из поиска по названию) предметом не становится', async () => {
    db({ named: [{ ...waterfall, db_id: null }] });
    const d = await getGuardianContextDetailed('Вилючинский водопад');
    expect(d.routes).toEqual([]);
    expect(d.text).toContain('Маршруты каталога к этому месту — данные из базы Ведара:');
  });

  it('ничего не нашлось — пустой ответ с пустыми списками, как прежде', async () => {
    db({ named: [] });
    const d = await getGuardianContextDetailed('Несуществующее место');
    expect(d).toEqual({ text: '', found: false, places: [], routes: [] });
  });
});

describe('слова оценки — одни на карточку и на ответ агенту', () => {
  const signals = (over: Partial<RouteSignals>): RouteSignals => ({
    alerts: [], volcanoes: [], inSeason: null, weather: null, closures: [], ...over,
  });

  it('незнание и пустой список выглядят по-разному', () => {
    const unknown = verdictFactLines(signals({ alerts: null, volcanoes: null, closures: null }));
    expect(unknown.map((f) => f.value)).toEqual(['не смогли узнать', 'не смогли узнать', 'не смогли узнать']);
    expect(unknown.every((f) => f.dim)).toBe(true);
    const empty = verdictFactLines(signals({}));
    expect(empty.map((f) => f.value)).toEqual(['действующих нет', 'в 25 км нет', 'администратор не отмечал']);
    expect(empty.some((f) => f.dim)).toBe(false);
  });

  it('без предела названы все предупреждения (карточка); с пределом — остаток числом', () => {
    const alerts = ['а', 'б', 'в'].map((title) => ({ title, severity: 1 }));
    expect(verdictFactLines(signals({ alerts }))[0]?.value).toBe('а · б · в');
    expect(verdictFactLines(signals({ alerts }), { maxAlerts: 2 })[0]?.value).toBe('а · б · и ещё 1');
    expect(verdictFactLines(signals({ alerts }), { maxAlerts: 3 })[0]?.value).toBe('а · б · в');
  });

  it('сезон назван, только когда он записан; код вулкана — словом', () => {
    expect(verdictFactLines(signals({})).map((f) => f.label)).not.toContain('Сезон');
    expect(verdictFactLines(signals({ inSeason: false })).at(-1)).toMatchObject({ label: 'Сезон', value: 'маршрут вне сезона' });
    expect(verdictFactLines(signals({ volcanoes: [{ name: 'Мутновский', acc: 'orange' }] }))[1]?.value).toBe('Мутновский — оранжевый');
  });

  it('причина со своим знаком в конце второй точки не получает', () => {
    const s = signals({ alerts: [{ title: 'Сход лавин! Выход запрещён.', severity: 2, zonal: false }] });
    const lines = routeTodayLines({ verdict: goVerdict(s), signals: s });
    expect(lines[0]).toContain('«Не сегодня»: МЧС: Сход лавин! Выход запрещён. Правило то же');
    expect(lines.join('\n')).not.toContain('..');
  });
});

describe('сторож утверждений Кузьмича читает оценку маршрута', () => {
  const run = (output: string) => [{ name: 'get_guardian_context', args: {}, producedData: true, output }];

  it('«можно идти» при [НЕ СЕГОДНЯ] и при [ОСТОРОЖНО] — вопреки данным, с поправкой', () => {
    for (const mark of ['НЕ СЕГОДНЯ', 'ОСТОРОЖНО']) {
      const r = guardSafetyClaims('К водопаду сегодня можно идти.', run(`Маршрут каталога «Вилючинский водопад» [${mark}]\nОценка маршрута на сегодня — …`));
      expect(r.verdict, mark).toBe('contradicted');
      expect(r.text).toContain('Поправка');
    }
  });

  it('«можно идти» при оценке «Идти» (метки нет) — опирается на данные', () => {
    const r = guardSafetyClaims('К водопаду сегодня можно идти.', run('Маршрут каталога «Вилючинский водопад»\nОценка маршрута на сегодня — «Идти»: Предупреждений и опасных кодов на маршруте нет.'));
    expect(r.verdict).toBe('backed');
  });

  it('закрытое место: «[ЗАКРЫТО]» и «[ЖЁЛТЫЙ — ЗАКРЫТО]» тоже не дают сказать «безопасно»', () => {
    for (const header of ['Долина гейзеров (долина) [ЗАКРЫТО]', 'Вулкан Авачинский (вулкан) [ЖЁЛТЫЙ — ЗАКРЫТО]', 'Вулкан Авачинский (вулкан) [ЗЕЛЁНЫЙ — ЗАКРЫТО]']) {
      const r = guardSafetyClaims('Там сейчас безопасно.', run(header));
      expect(r.verdict, header).toBe('contradicted');
    }
  });

  it('зелёное открытое место поправки не получает', () => {
    const r = guardSafetyClaims('Там сейчас безопасно.', run('Гора Замок (гора) [ЗЕЛЁНЫЙ]\nЗЕЛЁНЫЙ значит: активных предупреждений по месту не найдено.'));
    expect(r.verdict).toBe('backed');
  });
});
