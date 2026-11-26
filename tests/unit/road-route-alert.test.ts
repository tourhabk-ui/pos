/**
 * Дорожное ограничение, которое называет дорогу маршрута, доходит до этого
 * маршрута (#3858, разбор очереди 26.11).
 *
 * 26.11 Турпортал края закрыл проезд по автозимнику Анавгай — Палана, а страж
 * о маршруте «Зимник Анавгай - Тигиль» отвечал «Идти: предупреждений и опасных
 * кодов на маршруте нет». Сёл Тигиль и Палана в каталоге мест нет, привязка по
 * координате не нашлась, и ограничение не дошло ни до кого.
 *
 * Здесь судится поведение: правило по настоящим заголовкам ленты, затем
 * сборщик сигналов на подменённой базе и оценка, которую получает маршрут.
 * Исполнение на настоящем PostgreSQL — tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { roadAlertNamesRoute, routePlaceStems, routeRoadKind } from '@/lib/safety/road-route-alert';
import { collectRouteSignals, ROAD_ALERTS_FOR_ROUTE_SQL, type QueryFn } from '@/lib/routes/collect-signals';
import { goVerdict, CLEAR_REASON, CLEAR_WITH_ALERTS_REASON } from '@/lib/routes/go-verdict';

const ZIMNIK = 'Зимник Анавгай - Тигиль';
// Заголовки ленты 26.11 (дайджест #3858), дословно.
const CLOSED_TIGIL = 'Временно закрыт проезд для легкового транспорта на участке с 230-го по 435-й км автозимника, между селом Тигиль и посёлком Палана';
const LIMITED_ANAVGAI = 'Временно ограничено движение для легкового транспорта на участке автозимника «Анавгай — Палана»';
const BLIZZARD = 'Проезд закрыт в связи с ограниченной видимостью, снежными осадками, сильным ветром и метелью';

describe('правило: тревога называет дорогу маршрута', () => {
  it('маршрут-зимник — дорога; тропа и вулкан — нет', () => {
    expect(routeRoadKind(ZIMNIK)).toBe('зимник');
    expect(routeRoadKind('Вулкан Горелый')).toBeNull();
    expect(routeRoadKind('Дорога к Вилючинскому водопаду')).toBeNull();
    expect(routeRoadKind(null)).toBeNull();
  });

  it('места маршрута берутся из названия без рода дороги', () => {
    expect(routePlaceStems(ZIMNIK)).toEqual(['анавг', 'тиги']);
    // Род дороги в любом падеже — не место: иначе «зимн» совпало бы с любым зимником.
    expect(routePlaceStems('По автозимнику Анавгай — Тигиль')).toEqual(['анавг', 'тиги']);
    expect(roadAlertNamesRoute('По автозимнику Анавгай — Тигиль', 'road_closure', 'Закрыт автозимник Оссора — Тиличики')).toBe(false);
  });

  it('заголовки ленты 26.11: два называют дорогу маршрута, метель без места — нет', () => {
    expect(roadAlertNamesRoute(ZIMNIK, 'road_closure', CLOSED_TIGIL)).toBe(true);
    expect(roadAlertNamesRoute(ZIMNIK, 'road_closure', LIMITED_ANAVGAI)).toBe(true);
    expect(roadAlertNamesRoute(ZIMNIK, 'road_closure', BLIZZARD)).toBe(false);
  });

  it('место в другом падеже узнаётся', () => {
    expect(roadAlertNamesRoute(ZIMNIK, 'road_closure', 'Закрыт автозимник до Тигиля')).toBe(true);
  });

  it('другая дорога или другой род — не про этот маршрут', () => {
    // Тот же Тигиль, но не зимник: дорога маршрута не названа.
    expect(roadAlertNamesRoute(ZIMNIK, 'road_closure', 'В Тигиле перекрыта улица Партизанская')).toBe(false);
    // Зимник, но другой: ни одного места маршрута.
    expect(roadAlertNamesRoute(ZIMNIK, 'road_closure', 'Закрыт автозимник Оссора — Тиличики')).toBe(false);
    // Тот же текст, но род тревоги не дорожный.
    expect(roadAlertNamesRoute(ZIMNIK, 'weather', CLOSED_TIGIL)).toBe(false);
    // Маршрут не дорога — правило его не трогает.
    expect(roadAlertNamesRoute('Озеро Паланское', 'road_closure', CLOSED_TIGIL)).toBe(false);
  });
});

/** Подменённая база: строка маршрута, тревоги по зоне и дорожные ограничения — отдельно. */
function stub(opts: {
  title: string | null;
  zonal?: Array<{ title: string; severity: number; alert_type: string; zonal: boolean }>;
  road?: Array<{ title: string; severity: number; alert_type: string }>;
  failRoad?: boolean;
}): { q: QueryFn; calls: string[] } {
  const calls: string[] = [];
  const q = (async (sql: string) => {
    calls.push(sql);
    if (sql === ROAD_ALERTS_FOR_ROUTE_SQL) {
      if (opts.failRoad) throw Object.assign(new Error('база отказала'), { code: '57014' });
      return { rows: opts.road ?? [] };
    }
    if (sql.includes('external_alerts')) return { rows: opts.zonal ?? [] };
    if (sql.includes('FROM kamchatka_routes')) {
      return { rows: [{ id: 'r1', zone: 'northern', season: 'зима', lat: '57.0', lng: '158.0', title: opts.title }] };
    }
    return { rows: [] };
  }) as QueryFn;
  return { q, calls };
}

const MARINE = { title: 'Экстренное предупреждение на 27 ноября 2026 г. (переливание песчаных кос морской водой)', severity: 1, alert_type: 'weather', zonal: true };
const ROAD_ROWS = [
  { title: CLOSED_TIGIL, severity: 2, alert_type: 'road_closure' },
  { title: LIMITED_ANAVGAI, severity: 1, alert_type: 'road_closure' },
  { title: BLIZZARD, severity: 2, alert_type: 'road_closure' },
  { title: 'Вилючинский перевал: проезд по пропускам', severity: 1, alert_type: 'road_closure' },
];

describe('маршрут-зимник получает закрытие своей дороги', () => {
  it('случай 26.11: «Не сегодня» с текстом закрытия, а не «Идти»', async () => {
    const { q } = stub({ title: ZIMNIK, zonal: [MARINE], road: ROAD_ROWS });
    const s = await collectRouteSignals('r1', { query: q, month: 11 });
    expect(s.alerts?.map((a) => a.title)).toEqual([CLOSED_TIGIL, LIMITED_ANAVGAI, MARINE.title]);
    expect(s.alerts?.find((a) => a.title === CLOSED_TIGIL)?.zonal).toBe(false);
    const v = goVerdict(s);
    expect(v.status).toBe('no');
    expect(v.code).toBe('alert_ban');
    expect(v.reason).toContain(CLOSED_TIGIL);
  });

  it('список маршрута — по важности: цунами выше закрытия, закрытие выше зональной единицы', async () => {
    const TSUNAMI = { title: 'Угроза цунами на восточном побережье', severity: 3, alert_type: 'tsunami_warning', zonal: true };
    const { q } = stub({ title: ZIMNIK, zonal: [TSUNAMI, MARINE], road: [ROAD_ROWS[0]!] });
    const s = await collectRouteSignals('r1', { query: q, month: 11 });
    expect(s.alerts?.map((a) => a.title)).toEqual([TSUNAMI.title, CLOSED_TIGIL, MARINE.title]);
  });

  it('то же ограничение уровня 1 — «Осторожно» с его текстом', async () => {
    const { q } = stub({ title: ZIMNIK, road: [{ title: LIMITED_ANAVGAI, severity: 1, alert_type: 'road_closure' }] });
    const v = goVerdict(await collectRouteSignals('r1', { query: q, month: 11 }));
    expect(v.status).toBe('caution');
    expect(v.reason).toBe(LIMITED_ANAVGAI);
  });

  it('маршрут не дорога — дорожные ограничения отдельно не читаются', async () => {
    const { q, calls } = stub({ title: 'Вулкан Горелый', road: ROAD_ROWS });
    const s = await collectRouteSignals('r1', { query: q, month: 11 });
    expect(calls).not.toContain(ROAD_ALERTS_FOR_ROUTE_SQL);
    expect(s.alerts).toEqual([]);
  });

  it('отказ чтения ограничений — «не знаем предупреждения», а не «Идти»', async () => {
    const { q } = stub({ title: ZIMNIK, failRoad: true });
    const s = await collectRouteSignals('r1', { query: q, month: 11 });
    expect(s.alerts).toBeNull();
    expect(goVerdict(s).status).toBe('caution');
  });
});

describe('причина «Идти» не спорит со списком предупреждений', () => {
  const base = { volcanoes: [], inSeason: true, weather: null, closures: [] };

  it('пусто — «предупреждений нет»', () => {
    expect(goVerdict({ ...base, alerts: [] }).reason).toBe(CLEAR_REASON);
  });

  it('зональная единица в списке — «Идти», но без слов «предупреждений нет»', () => {
    const v = goVerdict({ ...base, alerts: [{ title: MARINE.title, severity: 1, type: 'weather', zonal: true }] });
    expect(v.status).toBe('go');
    expect(v.reason).toBe(CLEAR_WITH_ALERTS_REASON);
    expect(v.reason).not.toMatch(/предупреждений[^;]*нет/i);
  });
});
