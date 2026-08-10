/**
 * Сбор сигналов для вердикта: `null` — «не смогли узнать», `[]` — «узнали,
 * там пусто».
 *
 * Весь сегодняшний день был про то, как эти два состояния сливаются в одно.
 * Пустая лента читалась как «угроз нет». Плашка «Обстановка нормальная»
 * считалась из нуля данных. `catch` возвращал пустой массив, и отказ базы
 * становился неотличим от спокойного дня — а вердикт по такому входу выходит
 * зелёным, потому что ему нечего запретить.
 *
 * Здесь это проверяется без базы: запрос внедряется снаружи, и тест может
 * уронить любой из них по отдельности. Проверяется не «функция вызвалась», а
 * обещание: отказ источника НИКОГДА не выглядит как чистый день.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectRouteSignals, isInSeason, CORRIDOR_VOLCANO_KM, type QueryFn,
} from '@/lib/routes/collect-signals';
import { goVerdict } from '@/lib/routes/go-verdict';

const ROUTE_ID = '00000000-0000-0000-0000-000000000001';

const ROUTE_ROW = { zone: 'avacha', season: 'summer', lat: '53.25', lng: '158.83' };
const WAYPOINT_ROW = { zone: 'nalychevo', lat: '53.30', lng: '158.90' };

type Rows = Record<string, unknown[]>;

/**
 * Запрос-заглушка. Каждый источник узнаётся по своей таблице, любой из них
 * можно уронить: `throw` в `fail` — это отказ базы, а не пустой ответ.
 */
function stubQuery(rows: Partial<Rows> = {}, fail: string[] = []): QueryFn {
  return (async (sql: string) => {
    const table = sql.includes('kamchatka_routes') ? 'route'
      : sql.includes('route_waypoints') ? 'waypoints'
      : sql.includes('external_alerts') ? 'alerts'
      : sql.includes('volcano_status') ? 'volcanoes'
      : 'unknown';
    if (fail.includes(table)) throw new Error(`база отказала: ${table}`);
    return { rows: rows[table] ?? [] };
  }) as QueryFn;
}

const withRoute = (extra: Partial<Rows> = {}): Partial<Rows> => ({
  route: [ROUTE_ROW], waypoints: [WAYPOINT_ROW], ...extra,
});

describe('отказ источника даёт null, а не пустоту', () => {
  it('упал запрос предупреждений — alerts === null', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute(), ['alerts']), month: 7,
    });
    expect(s.alerts).toBeNull();
    expect(s.alerts).not.toEqual([]);
  });

  it('упал запрос вулканов — volcanoes === null', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute(), ['volcanoes']), month: 7,
    });
    expect(s.volcanoes).toBeNull();
  });

  it('упал запрос самого маршрута — не знаем НИЧЕГО, что от него зависит', async () => {
    // Форма маршрута неизвестна — значит неизвестны и зоны, и коридор.
    // Подставить сюда пустые массивы значило бы сказать «узнали, там чисто».
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery({}, ['route']), month: 7,
    });
    expect(s.alerts).toBeNull();
    expect(s.volcanoes).toBeNull();
    expect(s.inSeason).toBeNull();
  });

  it('маршрута нет в базе — то же самое, а не «чистый маршрут»', async () => {
    const s = await collectRouteSignals(ROUTE_ID, { query: stubQuery({}), month: 7 });
    expect(s.alerts).toBeNull();
    expect(s.volcanoes).toBeNull();
  });

  it('любой отказ доезжает до вердикта и не даёт зелёного', async () => {
    // Главная проверка файла: отказ базы обязан быть виден человеку.
    for (const broken of ['route', 'alerts', 'volcanoes']) {
      const s = await collectRouteSignals(ROUTE_ID, {
        query: stubQuery(withRoute(), [broken]), month: 7,
      });
      const v = goVerdict(s);
      expect(v.status, `отказ «${broken}» выдал зелёный вердикт`).not.toBe('go');
      expect(v.unknown.length, `отказ «${broken}» не назван человеку`).toBeGreaterThan(0);
    }
  });
});

describe('успешный пустой ответ даёт [], а не null', () => {
  it('источники ответили, и там правда ничего нет', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute()), month: 7,
    });
    expect(s.alerts).toEqual([]);
    expect(s.volcanoes).toEqual([]);
  });

  it('такой вход — законный зелёный', async () => {
    // Обратная сторона того же различения: если всё спросили и ничего не
    // нашли, вердикт обязан быть зелёным. Вердикт, всегда одного цвета,
    // перестают читать.
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute()), month: 7,
    });
    expect(goVerdict(s).status).toBe('go');
  });
});

describe('зоны маршрута собираются из него самого и из его точек', () => {
  it('в запрос предупреждений уходят обе зоны', async () => {
    let zones: unknown = null;
    const q = (async (sql: string, params: unknown[]) => {
      if (sql.includes('external_alerts')) zones = params[0];
      return { rows: sql.includes('kamchatka_routes') ? [ROUTE_ROW]
        : sql.includes('route_waypoints') ? [WAYPOINT_ROW] : [] };
    }) as QueryFn;

    await collectRouteSignals(ROUTE_ID, { query: q, month: 7 });
    expect(zones).toEqual(expect.arrayContaining(['avacha', 'nalychevo']));
  });

  it('маршрут без зоны и без точек не роняет сбор — зоны просто пусты', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery({ route: [{ zone: null, season: null, lat: '53.2', lng: '158.8' }] }),
      month: 7,
    });
    // Зон нет — но общерегиональные предупреждения всё равно спрошены.
    expect(s.alerts).toEqual([]);
  });

  it('координат нет вовсе — коридор мерить не от чего, это незнание', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery({ route: [{ zone: 'avacha', season: null, lat: null, lng: null }] }),
      month: 7,
    });
    expect(s.volcanoes).toBeNull();
  });
});

describe('важность предупреждения не подменяется нулём', () => {
  it('пустой severity читается как «повод сказать осторожно», а не как «безопасно»', async () => {
    // `Number(null) || 0` — ровно тот дефект, который мы ловим весь день.
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute({ alerts: [{ title: 'Штормовое', severity: null }] })),
      month: 7,
    });
    expect(s.alerts?.[0].severity).toBeGreaterThanOrEqual(1);
    expect(goVerdict(s).status).not.toBe('go');
  });

  it('проставленная важность доезжает как есть', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute({
        alerts: [{ title: 'Тургруппам воздержаться от выхода', severity: 2 }],
      })),
      month: 7,
    });
    expect(goVerdict(s).status).toBe('no');
    expect(goVerdict(s).code).toBe('alert_ban');
  });
});

describe('код вулкана не додумывается', () => {
  it('неизвестный код становится unassigned, а не зелёным', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute({ volcanoes: [{ name: 'Ключевской', acc: 'странно' }] })),
      month: 7,
    });
    expect(s.volcanoes?.[0].acc).toBe('unassigned');
  });

  it('красный код доезжает до вердикта', async () => {
    const s = await collectRouteSignals(ROUTE_ID, {
      query: stubQuery(withRoute({ volcanoes: [{ name: 'Шивелуч', acc: 'red' }] })),
      month: 7,
    });
    expect(goVerdict(s).code).toBe('volcano_red');
  });
});

describe('сезон', () => {
  it('не задан в данных — null, а не «вне сезона»', () => {
    expect(isInSeason(null, 7)).toBeNull();
    expect(isInSeason('', 7)).toBeNull();
  });

  it('летний маршрут летом и зимой', () => {
    expect(isInSeason('summer', 7)).toBe(true);
    expect(isInSeason('лето', 1)).toBe(false);
  });

  it('круглогодичный — всегда', () => {
    expect(isInSeason('all', 1)).toBe(true);
    expect(isInSeason('круглогодично', 7)).toBe(true);
  });

  it('незнакомое слово — null, а не догадка', () => {
    expect(isInSeason('по договорённости', 7)).toBeNull();
  });

  it('месяц приходит снаружи — иначе ответ плыл бы сам по себе', async () => {
    const q = stubQuery(withRoute());
    const summer = await collectRouteSignals(ROUTE_ID, { query: q, month: 7 });
    const winter = await collectRouteSignals(ROUTE_ID, { query: q, month: 1 });
    expect(summer.inSeason).toBe(true);
    expect(winter.inSeason).toBe(false);
  });
});

describe('погода собирается намеренно не как запрет', () => {
  it('weather всегда null: опасная погода доезжает предупреждением МЧС', async () => {
    const s = await collectRouteSignals(ROUTE_ID, { query: stubQuery(withRoute()), month: 7 });
    expect(s.weather).toBeNull();
    // И это не мешает зелёному — циклон 10.08 пришёл через external_alerts.
    expect(goVerdict(s).status).toBe('go');
  });
});

describe('код сборщика не имеет права молча вернуть пустоту', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/routes/collect-signals.ts'), 'utf-8');

  it('ни один catch не возвращает пустой массив', () => {
    // Стережётся не дисциплина, а текст: `catch { return []; }` — это и есть
    // тот самый молчаливый «спокойный день» вместо отказа базы.
    expect(SRC).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*return\s*\[\s*\]/);
  });

  it('пустой массив не подставляется через ?? и ||', () => {
    expect(SRC).not.toMatch(/\?\?\s*\[\s*\]/);
    expect(SRC).not.toMatch(/\|\|\s*\[\s*\]/);
  });

  it('важность не приводится через || 0', () => {
    expect(SRC).not.toMatch(/severity[^\n]*\|\|\s*0/);
  });

  it('бессрочное предупреждение считается действующим', () => {
    // Условие «expires_at > NOW()» в одиночку молча выкидывает целый класс
    // записей: у алерта без срока NULL не больше NOW().
    expect(SRC).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
  });

  it('вулканы отбираются по расстоянию, а не по совпадению имён', () => {
    // Похожее имя дало бы уверенный ответ там, где его нет.
    expect(SRC).toMatch(/asin|acos|earth_box|ST_DWithin/);
    expect(SRC).not.toMatch(/volcano_name\s+ILIKE|name\s+ILIKE/);
  });

  it('радиус коридора назван числом, а не спрятан в строке запроса', () => {
    expect(CORRIDOR_VOLCANO_KM).toBeGreaterThan(0);
    expect(SRC).toContain('CORRIDOR_VOLCANO_KM');
  });

  it('SQL параметризован — конкатенации значений нет', () => {
    expect(SRC).toMatch(/\$1/);
    expect(SRC).not.toMatch(/`[^`]*SELECT[^`]*\$\{/);
  });
});
