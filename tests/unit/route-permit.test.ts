/**
 * Условия посещения территории в ответе о маршруте (#3302, срез 4).
 *
 * На карточке маршрута «Вилючинский водопад» блок «Разрешение на посещение
 * парка» есть. Кузьмичу и ИИ-агенту о том же маршруте говорилось одно слово —
 * «Охраняемая территория: …»: что туда нужно разрешение и где его берут, из
 * чата не узнать.
 *
 * Что держит сторож:
 *  - правило одно на карточку и на ответ (permitRuleFor), порядок проверок —
 *    часть правила;
 *  - способы КГБУ называются, только когда справочник ведёт территорию на
 *    страницу условий КГБУ; у Командорских островов «Зелёной кнопки» нет;
 *  - «не записано», «подходят несколько» и «не прочиталось» — разные слова, и
 *    ни одно не читается как «разрешение не нужно»;
 *  - где правило отвечает по названию, справочник не спрашивается.
 *
 * Вызовами на подменённой базе (CLAUDE.md §4: поведение, не текст исходника).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  isKgbuPermitPage, kgbuChannelLines, loadParkLookup, permitCaseKey, permitLinesForRoutes, permitNeedsLookup,
  routePermitCase, routePermitCaseFor, routePermitLines, FREE_VISIT_NOTE_RU, PERMIT_NOT_MCHS_RU,
  type ParkLookup, type ParkPermitRecord,
} from '@/lib/parks/route-permit';
import {
  permitRuleFor, FEDERAL_PERMIT_UNKNOWN_RU, KRONOKI_ORDER_RU, KRONOKI_REQUESTS, PARK_PERMIT_CHANNELS,
  PARK_PERMIT_SOURCE, GREEN_BUTTON,
} from '@/lib/safety/park-permit';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { fetchDocument } from '@/lib/mcp/connector-tools';
import { getGuardianContextDetailed, type RouteFactsSource } from '@/lib/kuzmich/guardian-context';

const VIL_ROW = {
  slug: 'vilyuchinsky', display_name: 'Природный парк «Вилючинский»',
  permit_url: 'https://www.vulcanikamchatki.ru/v_pomow_gostyu/usloviya_poseweniya/',
  permit_email: 'visit@park-vulcany.ru', permit_office_address: 'город Елизово, улица Завойко, 33',
  permit_office_hours: null, permit_gosuslugi_url: 'https://gosuslugi41.ru/pgu/volcano_info.htm', permit_online_url: null,
};
const KOM_ROW = {
  slug: 'komandorskiy', display_name: 'Национальный парк «Командорские острова»',
  permit_url: null, permit_email: 'ostrova.ohrana@gmail.com',
  permit_office_address: 'село Никольское, ул. 50 лет Октября, 31 — отдел охраны национального парка',
  permit_office_hours: 'пн–пт 9:00–18:00, обед 13:00–14:00', permit_gosuslugi_url: null, permit_online_url: null,
};
const record = (r: typeof VIL_ROW | typeof KOM_ROW): ParkPermitRecord => ({
  slug: r.slug, displayName: r.display_name, permitUrl: r.permit_url, email: r.permit_email,
  officeAddress: r.permit_office_address, officeHours: r.permit_office_hours,
  gosuslugiUrl: r.permit_gosuslugi_url, onlineUrl: r.permit_online_url,
});
const one = (r: typeof VIL_ROW | typeof KOM_ROW): ParkLookup => ({ state: 'one', park: record(r) });

const CARD_ID = 'a0000000-0000-4000-8000-0000000000aa';
const DB_ID = 'b0000000-0000-4000-8000-0000000000bb';
const waterfall: RouteFactsSource = {
  id: CARD_ID, db_id: DB_ID, slug: 'vilyuchinskij-vodopad', title: 'Вилючинский водопад',
  difficulty: 'easy', distance_km: '1.9', elevation_gain_m: 325, duration_hours: null, season: null,
  hazards: null, equipment: null, mchs_registration_required: false, mchs_phone: null,
  park_name: 'Природный парк «Вилючинский»', description: null,
};

interface World {
  named?: unknown[];
  viewRoute?: unknown[];
  parks?: unknown[] | Error;
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
    // Тревоги маршрута — раньше остальных: их предикат сам читает kamchatka_routes kr
    // и справочник парков. Чтение условий посещения узнаётся по своей колонке.
    if (sql.includes('JOIN ark ON')) return reply([]);
    if (sql.includes('permit_gosuslugi_url')) return reply(w.parks, [VIL_ROW]);
    if (sql.includes('zone, season, lat')) return reply([{ id: params[0], zone: 'avachinsky', season: null, lat: '52.69', lng: '158.25' }]);
    if (sql.includes('FROM v_kamchatka_routes_api')) return reply(w.viewRoute);
    if (sql.includes('FROM kamchatka_routes kr')) return reply(w.named, [waterfall]);
    return Promise.resolve({ rows: [] });
  });
}
const parkCalls = () => calls.filter((c) => c.sql.includes('permit_gosuslugi_url'));

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('правило разрешения — одно на карточку и на ответ, порядок проверок важен', () => {
  it('Вачкажец: разрешение не предусмотрено, хотя у маршрута записана территория', () => {
    expect(permitRuleFor({ title: 'Горный массив Вачкажец (лыжный)', parkName: 'Вачкажец' }).kind).toBe('no_permit');
  });
  it('Курильское озеро — заявка Кроноцкому заповеднику, а не оговорка о федеральном парке', () => {
    const rule = permitRuleFor({ title: 'Курильское озеро', parkName: 'Южно-Камчатский заказник федерального значения' });
    expect(rule.kind).toBe('kronoki');
  });
  it('Авачинский перевал — зона свободного посещения внутри парка', () => {
    expect(permitRuleFor({ title: 'Авачинский перевал', parkName: 'Природный парк «Налычево»' }).kind).toBe('free_visit');
  });
  it('парк, ушедший в федеральное ведение, — оговорка названа', () => {
    const rule = permitRuleFor({ title: 'Вулкан Горелый', parkName: 'Южно-Камчатский' });
    expect(rule).toMatchObject({ kind: 'park', federal: { match: 'южно-камчат' } });
  });
  it('обычный парк и маршрут без территории — правило по названию ничего не решает', () => {
    expect(permitRuleFor({ title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' })).toEqual({ kind: 'park', federal: null });
    expect(permitRuleFor({ title: 'Тропа', parkName: null })).toEqual({ kind: 'park', federal: null });
  });
});

describe('случай маршрута: справочник решает, чьи это условия', () => {
  const vil = { title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' };

  it('справочник ведёт на страницу условий КГБУ — способы КГБУ', () => {
    expect(routePermitCase(vil, one(VIL_ROW))).toMatchObject({ kind: 'kgbu', park: { slug: 'vilyuchinsky' } });
  });
  it('страница условий узнаётся без схемы, www и хвостового слэша — и только она', () => {
    expect(isKgbuPermitPage('http://vulcanikamchatki.ru/v_pomow_gostyu/usloviya_poseweniya')).toBe(true);
    expect(isKgbuPermitPage(PARK_PERMIT_SOURCE.url)).toBe(true);
    // Новость на том же сайте — не страница условий: по хосту ведомство не выводится.
    expect(isKgbuPermitPage('https://vulcanikamchatki.ru/novosti/20222029/')).toBe(false);
    expect(isKgbuPermitPage('https://vulcanikamchatki.ru/territoriya/klaster_kol/rules/')).toBe(false);
    expect(isKgbuPermitPage(null)).toBe(false);
  });
  it('своя запись территории (Командорские острова) — «Зелёной кнопки» в ответе нет', () => {
    const c = routePermitCase({ title: 'Остров Беринга', parkName: 'Командорские острова' }, one(KOM_ROW));
    expect(c.kind).toBe('recorded');
    const text = routePermitLines(c).join('\n');
    expect(text).toContain('Национальный парк «Командорские острова»');
    expect(text).toContain('офис — село Никольское, ул. 50 лет Октября, 31 — отдел охраны национального парка (пн–пт 9:00–18:00, обед 13:00–14:00)');
    expect(text).toContain('почта — ostrova.ohrana@gmail.com');
    expect(text).not.toContain(GREEN_BUTTON.name);
    expect(text).not.toContain('Госуслуги41');
    expect(text).not.toContain('страница условий');
    // Требование разрешения справочником не утверждается.
    expect(text).toContain('Нужно ли разрешение именно на этом маршруте, справочник Ведара не говорит');
  });
  it('строка есть, условий в ней нет — «не записаны», как и без строки', () => {
    // Часы без адреса — не канал: одних часов работы мало, чтобы куда-то прийти.
    const empty = { ...KOM_ROW, permit_email: null, permit_office_address: null, permit_office_hours: 'пн–пт' };
    expect(routePermitCase(vil, one(empty)).kind).toBe('unrecorded');
    expect(routePermitCase(vil, { state: 'none' })).toEqual({ kind: 'unrecorded', territory: 'Природный парк «Вилючинский»' });
  });
  it('три разных незнания — три разных ответа, и ни один не «разрешение не нужно»', () => {
    const unrecorded = routePermitLines(routePermitCase(vil, { state: 'none' })).join('\n');
    const ambiguous = routePermitLines(routePermitCase(vil, { state: 'many', names: ['А', 'Б'] })).join('\n');
    const unread = routePermitLines(routePermitCase(vil, { state: 'failed' })).join('\n');
    expect(unrecorded).toContain('в базе Ведара не записаны — это не значит, что разрешение не нужно');
    expect(ambiguous).toContain('подходят несколько записей (А; Б)');
    expect(unread).toContain('прочитать не удалось — это не значит, что разрешение не нужно');
    expect(new Set([unrecorded, ambiguous, unread]).size).toBe(3);
    for (const t of [unrecorded, ambiguous, unread]) {
      expect(t).not.toMatch(/не требуется/);
      expect(t).not.toContain(GREEN_BUTTON.name);
    }
    // Справочник не спросили вовсе — тоже «не прочитали», а не «не записано».
    expect(routePermitCase(vil, null).kind).toBe('unread');
  });
  it('у маршрута нет территории — об условиях посещения не говорится ничего', () => {
    const c = routePermitCase({ title: 'Тропа', parkName: '  ' }, null);
    expect(c).toEqual({ kind: 'none' });
    expect(routePermitLines(c)).toEqual([]);
    expect(permitCaseKey(c)).toBeNull();
  });
  it('правило по названию сильнее справочника: Вачкажец и Курильское озеро', () => {
    expect(routePermitCase({ title: 'Вачкажец', parkName: 'Вачкажец' }, one(VIL_ROW)).kind).toBe('no_permit');
    expect(routePermitCase({ title: 'Курильское озеро', parkName: null }, one(VIL_ROW)).kind).toBe('kronoki');
    expect(routePermitCase({ title: 'Авачинский перевал', parkName: 'Налычево' }, one(VIL_ROW)).kind).toBe('free_visit');
    expect(routePermitCase({ title: 'Вулкан Горелый', parkName: 'Южно-Камчатский' }, one(VIL_ROW)).kind).toBe('federal');
  });
});

describe('слова условий', () => {
  it('парк КГБУ: посещение по разрешению, все способы и источник названы', () => {
    const lines = routePermitLines(routePermitCase({ title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' }, one(VIL_ROW)));
    expect(lines[0]).toBe(
      `Условия посещения — Природный парк «Вилючинский»: посещение — по разрешению ${PARK_PERMIT_SOURCE.authority} `
      + `(${PARK_PERMIT_SOURCE.asOf}). Страница условий: ${PARK_PERMIT_SOURCE.url}`,
    );
    expect(lines[1]).toBe('Способы получить разрешение:');
    expect(lines.slice(2, 2 + PARK_PERMIT_CHANNELS.length)).toEqual(kgbuChannelLines());
    // Зона свободного посещения названа: правило узнаёт её только по названию маршрута.
    expect(lines.at(-2)).toBe(FREE_VISIT_NOTE_RU);
    expect(FREE_VISIT_NOTE_RU).toContain('Авачинский перевал');
    expect(lines.at(-1)).toBe(PERMIT_NOT_MCHS_RU);
    const text = lines.join('\n');
    for (const c of PARK_PERMIT_CHANNELS) expect(text).toContain(c.title);
    expect(text).toContain(GREEN_BUTTON.androidUrl);
    expect(text).toContain('https://gosuslugi41.ru/pgu/volcano_info.htm');
    expect(text).toContain('visit@park-vulcany.ru');
  });
  it('ссылка в строке способа не кончается знаком препинания', () => {
    for (const line of [...kgbuChannelLines(), ...routePermitLines(routePermitCase({ title: 'Вачкажец' }, null))]) {
      for (const url of line.match(/https?:\/\/\S+/g) ?? []) expect(url).not.toMatch(/[.,;:)]$/);
    }
  });
  it('Кроноцкий заповедник: порядок словами карточки, страница заявок, без способов КГБУ', () => {
    const text = routePermitLines(routePermitCase({ title: 'Курильское озеро', parkName: null }, null)).join('\n');
    expect(text).toContain('Южно-Камчатский федеральный заказник');
    expect(text).toContain(KRONOKI_ORDER_RU);
    expect(text).toContain(`Страница заявок: ${KRONOKI_REQUESTS.url}`);
    expect(text).not.toContain(GREEN_BUTTON.name);
    expect(text).toContain(PERMIT_NOT_MCHS_RU);
  });
  it('федеральный парк: сказано, что порядок не объявлен, и способы названы прежними', () => {
    const lines = routePermitLines(routePermitCase({ title: 'Вулкан Горелый', parkName: 'Южно-Камчатский' }, null));
    expect(lines[0]).toContain('«Южно-Камчатский» — часть национального парка «Вулканы Камчатки» в ведении Минприроды России');
    expect(lines[0]).toContain(FEDERAL_PERMIT_UNKNOWN_RU);
    expect(lines[1]).toBe(`Способы, которыми разрешение выдавал ${PARK_PERMIT_SOURCE.authority} (${PARK_PERMIT_SOURCE.asOf}):`);
    expect(lines.join('\n')).not.toContain('Способы получить разрешение:');
    expect(lines.slice(2, 2 + PARK_PERMIT_CHANNELS.length)).toEqual(kgbuChannelLines());
  });
  it('Вачкажец и свободная зона: «не требуется» с названным основанием', () => {
    const vach = routePermitLines(routePermitCase({ title: 'Горный массив Вачкажец', parkName: 'Вачкажец' }, null));
    expect(vach).toHaveLength(1);
    expect(vach[0]).toContain('Разрешение на посещение не требуется — памятник природы «Горный массив Вачкажец»');
    expect(vach[0]).toContain('Минприроды Камчатского края и Служба по охране животного мира, 2019 и 2023');
    const free = routePermitLines(routePermitCase({ title: 'Авачинский перевал', parkName: 'Налычево' }, null));
    expect(free).toEqual([
      `Разрешение парка не требуется — это зона свободного посещения (${PARK_PERMIT_SOURCE.authority}, ${PARK_PERMIT_SOURCE.asOf}).`,
    ]);
  });
});

describe('чтение справочника', () => {
  it('одна строка, нет строки, две строки', async () => {
    db({ parks: [VIL_ROW] });
    expect(await loadParkLookup('Природный парк «Вилючинский»')).toEqual(one(VIL_ROW));
    expect(parkCalls()[0]?.params).toEqual(['Природный парк «Вилючинский»']);
    db({ parks: [] });
    expect(await loadParkLookup('Голубые озёра')).toEqual({ state: 'none' });
    db({ parks: [VIL_ROW, KOM_ROW] });
    expect(await loadParkLookup('Парк')).toEqual({
      state: 'many', names: ['Природный парк «Вилючинский»', 'Национальный парк «Командорские острова»'],
    });
  });
  it('пробелы в поле справочника — не записанный канал', async () => {
    db({ parks: [{ ...KOM_ROW, permit_email: '  ', permit_office_address: '', permit_url: ' ' }] });
    const lookup = await loadParkLookup('Командорские острова');
    expect(lookup).toMatchObject({ state: 'one', park: { email: null, officeAddress: null, permitUrl: null } });
    expect(routePermitCase({ title: 'Остров Беринга', parkName: 'Командорские острова' }, lookup).kind).toBe('unrecorded');
  });
  it('отказ базы — «не прочиталось» с записью в лог, а не «не записано»', async () => {
    db({ parks: Object.assign(new Error('relation "parks" does not exist'), { code: '42P01' }) });
    expect(await loadParkLookup('Налычево')).toEqual({ state: 'failed' });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.join(' '))).toContain('sqlstate=42P01');
    const c = await routePermitCaseFor({ title: 'Тропа', park_name: 'Налычево' });
    expect(c).toEqual({ kind: 'unread', territory: 'Налычево' });
  });
  it('где правило отвечает по названию или территории нет — справочник не спрашивается', async () => {
    db();
    for (const r of [
      { title: 'Горный массив Вачкажец', park_name: 'Вачкажец' },
      { title: 'Курильское озеро', park_name: null },
      { title: 'Авачинский перевал', park_name: 'Налычево' },
      { title: 'Вулкан Горелый', park_name: 'Южно-Камчатский' },
      { title: 'Тропа', park_name: null },
    ]) {
      expect(permitNeedsLookup({ title: r.title, parkName: r.park_name })).toBe(false);
      await routePermitCaseFor(r);
    }
    expect(parkCalls()).toHaveLength(0);
    expect(permitNeedsLookup({ title: 'Вилючинский водопад', parkName: 'Природный парк «Вилючинский»' })).toBe(true);
    await routePermitCaseFor({ title: 'Вилючинский водопад', park_name: 'Природный парк «Вилючинский»' });
    expect(parkCalls()).toHaveLength(1);
  });
});

describe('несколько маршрутов одного ответа', () => {
  it('второй маршрут той же территории — отсылка, а не второй длинный блок', () => {
    const kgbu = routePermitCase({ title: 'А', parkName: 'Вилючинский' }, one(VIL_ROW));
    const none = routePermitCase({ title: 'Б', parkName: null }, null);
    const out = permitLinesForRoutes([{ title: 'Первый' }, { title: 'Без парка' }, { title: 'Второй' }], [kgbu, none, kgbu]);
    expect(out[0]).toEqual(routePermitLines(kgbu));
    expect(out[1]).toEqual([]);
    expect(out[2]).toEqual(['Условия посещения территории — те же, что у маршрута «Первый» выше.']);
  });
  it('короткий случай повторяется как есть; разные территории не склеиваются', () => {
    const free = routePermitCase({ title: 'Авачинский перевал' }, null);
    const kom = routePermitCase({ title: 'Б', parkName: 'Командорские' }, one(KOM_ROW));
    const kgbu = routePermitCase({ title: 'А', parkName: 'Вилючинский' }, one(VIL_ROW));
    const out = permitLinesForRoutes([{ title: '1' }, { title: '2' }, { title: '3' }, { title: '4' }], [free, free, kom, kgbu]);
    expect(out[1]).toEqual(routePermitLines(free));
    expect(out[2]).toEqual(routePermitLines(kom));
    expect(out[3]).toEqual(routePermitLines(kgbu));
  });
});

describe('ответы агенту о маршруте называют условия посещения', () => {
  it('страж: блок маршрута «Вилючинский водопад» несёт разрешение парка и способы', async () => {
    db();
    const { text } = await getGuardianContextDetailed('Вилючинский водопад');
    expect(text).toContain('Маршрут каталога «Вилючинский водопад»');
    expect(text).toContain(`посещение — по разрешению ${PARK_PERMIT_SOURCE.authority}`);
    expect(text).toContain(`— «${GREEN_BUTTON.name}»:`);
    expect(text).toContain(PERMIT_NOT_MCHS_RU);
    // Условия стоят после данных маршрута и строки о регистрации в МЧС.
    expect(text.indexOf('Условия посещения —')).toBeGreaterThan(text.indexOf('Регистрация в МЧС по этому маршруту'));
    expect(parkCalls()).toHaveLength(1);
  });
  it('страж: справочник не ответил — оценка дня на месте, а об условиях сказано «не удалось»', async () => {
    db({ parks: new Error('boom') });
    const { text } = await getGuardianContextDetailed('Вилючинский водопад');
    expect(text).toContain('Оценка маршрута на сегодня —');
    expect(text).toContain('Условия посещения территории «Природный парк «Вилючинский»» прочитать не удалось');
    expect(text).not.toContain(GREEN_BUTTON.name);
  });
  it('справка о месте: маршрут вместо места называет условия посещения', async () => {
    db();
    const text = await executeKuzmichTool('get_place_info', { name: 'Вилючинский водопад' }, { surface: 'mcp' });
    expect(text).toContain('В каталоге Ведара есть маршрут с этими словами в названии');
    expect(text).toContain(`посещение — по разрешению ${PARK_PERMIT_SOURCE.authority}`);
    expect(text).toContain('— Портал Госуслуги41:');
  });
  it('fetch маршрута: условия посещения стоят рядом с названием территории', async () => {
    db({ viewRoute: [{
      db_id: DB_ID, key: 'vilyuchinskij-vodopad', title: 'Вилючинский водопад', description: null, difficulty: 'easy',
      distance_km: '1.9', duration_hours: null, duration_days: null, elevation_gain_m: 325, season: null, route_type: null,
      hazards: null, equipment: null, mchs_registration_required: false, park_name: 'Природный парк «Вилючинский»', zone: 'south',
    }] });
    const doc = await fetchDocument('route:vilyuchinskij-vodopad', 'https://vedarai.ru');
    expect(doc.text).toContain('Охраняемая территория: Природный парк «Вилючинский»');
    expect(doc.text).toContain(`посещение — по разрешению ${PARK_PERMIT_SOURCE.authority}`);
    expect(doc.text.indexOf('Условия посещения —')).toBeGreaterThan(doc.text.indexOf('Охраняемая территория:'));
    expect(doc.text.indexOf('Экстренный вызов на Камчатке — 112.')).toBeGreaterThan(doc.text.indexOf(PERMIT_NOT_MCHS_RU));
  });
  it('fetch маршрута без территории: строк об условиях нет', async () => {
    db({ viewRoute: [{
      db_id: DB_ID, key: 'tropa', title: 'Тропа', description: null, difficulty: null, distance_km: null, duration_hours: null,
      duration_days: null, elevation_gain_m: null, season: null, route_type: null, hazards: null, equipment: null,
      mchs_registration_required: false, park_name: null, zone: null,
    }] });
    const doc = await fetchDocument('route:tropa', 'https://vedarai.ru');
    expect(doc.text).not.toContain('Условия посещения');
    expect(doc.text).not.toContain('азрешени');
    expect(parkCalls()).toHaveLength(0);
  });
});
