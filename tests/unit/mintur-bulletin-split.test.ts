/**
 * Сводка Минтура о доступности туристических объектов — построчный разбор.
 *
 * До 06.08 сводка (kamgov.ru/mintur/news/operativnaa-svodka-...) целиком
 * схлопывалась в одно info-событие severity 0 с пометкой в коде «построчный
 * разбор — следующий шаг, когда накопятся образцы». Второй образец принёс
 * владелец 07.08 — на нём и построен разбор: закрытые маршруты, опасные
 * вулканы, паводки и медведи доезжают до карточек отдельными событиями.
 *
 * Текст ниже — ЖИВАЯ сводка от 06.08.2026 (передал владелец, источник
 * kamgov.ru/mintur/news/operativnaa-svodka-o-dostupnosti-turisticeskih-obektov-06082026-91530).
 */
import { describe, it, expect } from 'vitest';
import { classifyMchsItems, isMinturBulletin, mchs_zones } from '@/lib/services/safety/seismic-parser';

const TITLE = 'Оперативная сводка доступности туристических объектов от 6 августа';
const BULLETIN = `Перед поездкой по Камчатке обязательно проверьте актуальную обстановку.

Открыты летние маршруты природного парка «Быстринский».
Доступны летние маршруты природного парка «Налычево», но с перекрытием двух маршрутов: «Радыгино — Центральный» и «р. Налычева — р. Островная».
В природном парке «Ключевской» летние маршруты также открыты, но передвижение в районах вулканов крайне небезопасно.

Будьте внимательны на следующих участках:
в «Налычево» закрыты два маршрута из-за паводков, а также на маршруте «Авачинский — Центральный» переход через реку Шумную осуществляется по снежнику;
не рекомендуется посещать вулканы Ключевской, Безымянный, Мутновский, Шивелуч и район вулкана Крашенинникова;
на большинстве рек края наблюдается высокий уровень воды и подтопления;
в с. Соболево действует режим повышенной готовности в связи с выходом медведей в населённый пункт.`;

const events = classifyMchsItems(
  'kamgov/91530', TITLE, BULLETIN, '2026-08-06T10:00:00Z',
  'https://kamgov.ru/mintur/news/operativnaa-svodka-o-dostupnosti-turisticeskih-obektov-06082026-91530',
  'kamgov',
);

describe('живая сводка 06.08 разбирается на события', () => {
  it('сводка распознана как минтуровская', () => {
    expect(isMinturBulletin(`${TITLE} ${BULLETIN}`)).toBe(true);
  });

  it('не схлопывается в один info: событий несколько', () => {
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every(e => e.alert_type === 'info' && e.severity === 0)).toBe(false);
  });

  it('перекрытые маршруты Налычево — road_closure красного уровня', () => {
    const road = events.find(e => e.alert_type === 'road_closure');
    expect(road, 'закрытие маршрутов потеряно').toBeDefined();
    expect(road!.severity).toBe(2);
    expect(road!.affected_zones).toContain('avachinsky');
  });

  it('«не рекомендуется посещать вулканы …» — вулканическая угроза на ТРИ зоны', () => {
    const volc = events.filter(e => e.alert_type === 'volcanic_eruption');
    expect(volc.length).toBeGreaterThanOrEqual(1);
    const zones = new Set(volc.flatMap(e => e.affected_zones));
    // Ключевской/Безымянный/Шивелуч → northern, Мутновский → avachinsky,
    // Крашенинникова → eastern. Первый-матч оставлял только northern.
    expect(zones).toContain('northern');
    expect(zones).toContain('avachinsky');
    expect(zones).toContain('eastern');
    expect(Math.max(...volc.map(e => e.severity))).toBeGreaterThanOrEqual(2);
  });

  it('запрет из недельной сводки живёт до следующего выпуска (168ч), не 48 (issue #1985)', () => {
    // Мутновский зелёный на проде 21.09 при живой рекомендации Минтура «не
    // приближаться» — потому что запись гасла через двое суток, а следующий
    // выпуск сводки мог не переиздать её слово в слово. 168ч — тот же срок,
    // что у соседней пожарной ветки того же документа.
    const volc = events.filter(e => e.alert_type === 'volcanic_eruption' && e.severity >= 2);
    expect(volc.length).toBeGreaterThanOrEqual(1);
    for (const e of volc) expect(e.expires_hours).toBe(168);
  });

  it('высокая вода на реках — flood', () => {
    expect(events.some(e => e.alert_type === 'flood')).toBe(true);
  });

  it('медведи в Соболево — событие западной зоны', () => {
    const bear = events.find(e => /медвед/i.test(`${e.title} ${e.description}`));
    expect(bear, 'медвежий пункт потерян').toBeDefined();
    expect(bear!.affected_zones).toContain('western');
    expect(bear!.severity).toBeGreaterThanOrEqual(1);
  });

  it('пункты «открыто» тревог не порождают — только улику открытия, рождённую истёкшей (06.11)', () => {
    // «Открыты летние маршруты природного парка «Быстринский»» — сводка об
    // открытии: проход приёма снимет этим парком более раннее закрытие. Сама
    // она не тревога: уровень 0 и срок 0 ч, ни лента, ни статус места её не
    // читают.
    const bystrinsky = events.filter(e => /Быстринск/i.test(e.title));
    expect(bystrinsky.length).toBeGreaterThan(0);
    for (const e of bystrinsky) {
      expect(e.alert_type).toBe('park_reopening');
      expect(e.severity).toBe(0);
      expect(e.expires_hours).toBe(0);
      expect(e.affected_parks).toEqual(['bystrinskiy']);
      expect(e.affected_zones).toEqual([]);
    }
  });
});

describe('фидовые пути зовут множественную форму классификатора', () => {
  it('RSS-конвейеры (МЧС и kamgov) используют classifyMchsItems, не одиночную', () => {
    // 07.08: разбор сводки был готов, но фидовый путь звал classifyMchsItem
    // (единственную форму) — сводка Минтура из kamgov-RSS шла мимо разборщика,
    // и владелец справедливо спросил «где предупреждения с сайта минтуризма».
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
    // Одиночная форма как ВЫЗОВ допустима только внутри classifyMchsItems и
    // в разборе соцпостов без заголовка — но не в фидовых циклах по items.
    const feedCalls = src.match(/const event = classifyMchsItem\(/g) ?? [];
    expect(feedCalls, 'фидовый цикл откатился на одиночный классификатор').toHaveLength(0);
    expect((src.match(/classifyMchsItems\(it\.id/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('зоны объединяются, а не первый матч', () => {
  it('перечисление вулканов трёх зон даёт все три', () => {
    const zones = mchs_zones('не рекомендуется посещать вулканы Ключевской, Мутновский и Крашенинникова');
    expect(new Set(zones)).toEqual(new Set(['northern', 'avachinsky', 'eastern']));
  });

  it('один вулкан — одна зона; без географии — пусто, а не Авачинская (17.09)', () => {
    expect(mchs_zones('вулкан Мутновский')).toEqual(['avachinsky']);
    expect(mchs_zones('без географии')).toEqual([]);
  });
});

/**
 * Еженедельная сводка 12.11 (передал владелец): пункты о парках стоят под
 * заголовком «Природные парки:» и слова «парк» в себе не несут. Поодиночке
 * «Налычево, Южно-Камчатский, Быстринский — закрыты» уходило «закрытой
 * дорогой», а «Вилючинский — открыты» терялось. Маркеры пунктов в оригинале —
 * эмодзи; здесь дефис (эмодзи в коде запрещены), разбор снимает любой.
 */
const WEEKLY_1211 = `Еженедельная сводка о доступности туристических объектов

Природные парки:
- «Налычево» и «Южно-Камчатский», «Быстринский» — маршруты закрыты.
- «Вилючинский» — маршруты открыты для посещения.
- «Ключевской» — маршруты закрыты на зимний сезон. Передвижение в районах вулканов крайне опасно.

- Не рекомендуется приближаться к вулканам Мутновский, Безымянный, Ключевской, Крашенинникова. Шивелуч — разрешено приближение радиусе не более, чем на 10 км от вершины.

Транспортная доступность:
- Проезд «п. Термальный — Вилючинский перевал»: строго по пропускам.
- Проезд к Авачинскому перевалу: после дождей произошел размыв дороги, образовался овраг — передвижение осложнено и опасно.
- Проезд по дороге Усть-Большерецк –Октябрьский (участок 115–128 км) разрешён только дорожной технике, автомобилям с продуктами, лекарствами, топливом, транспорту для аварийно-восстановительных работ, служебным автомобилям, транспорту, задействованному в ликвидации ЧС.`;

describe('еженедельная сводка 12.11: раздел «Природные парки»', () => {
  // Как в канале турпортала (visitkamchatka-channel): первая строка поста —
  // заголовок, остальное — пункты.
  const [head, ...rest] = WEEKLY_1211.split('\n');
  const evs = classifyMchsItems('visitkamchatka/tg/4979', head!, rest.join('\n'), '2026-11-12T05:59:16Z', 'https://t.me/visitkamchatka41/4979', 'visitkamchatka');
  const of = (t: string) => evs.filter((e) => e.alert_type === t);

  it('закрытие трёх парков — park_closure с парками, а не «закрытая дорога»', () => {
    const closures = of('park_closure');
    const parks = closures.flatMap((e) => e.affected_parks ?? []).sort();
    expect(parks).toEqual(['bystrinskiy', 'klyuchevskoy', 'nalychevo', 'yuzhno-kamchatsky']);
    expect(closures.every((e) => e.severity === 2)).toBe(true);
    expect(of('road_closure').some((e) => /Быстрин|Налычев|Ключевской/.test(e.title))).toBe(false);
    expect(closures[0]?.title).toMatch(/^Природный парк «Налычево»/);
  });

  it('«Вилючинский — открыты» — улика открытия парка', () => {
    const reopen = of('park_reopening');
    expect(reopen.flatMap((e) => e.affected_parks ?? [])).toEqual(['vilyuchinsky']);
    expect(reopen[0]?.expires_hours).toBe(0);
  });

  it('вулканы — каждый своим событием, Мутновский на месте', () => {
    const names = of('volcanic_eruption').map((e) => e.title).join(' | ');
    for (const v of ['Мутновский', 'Безымянный', 'Ключевской', 'Крашенинникова', 'Шивелуч']) expect(names).toContain(v);
  });

  it('пункты транспортного раздела — дороги, без приписанного парка', () => {
    const roads = of('road_closure').map((e) => e.title);
    expect(roads.some((t) => /Термальный/.test(t))).toBe(true);
    expect(roads.some((t) => /Авачинскому перевалу/.test(t))).toBe(true);
    expect(roads.some((t) => /^Природный парк/.test(t))).toBe(false);
  });

  it('«Усть-Большерецк – Октябрьский: разрешён только дорожной технике…» — закрытая для туриста дорога на западе', () => {
    // Владелец 12.11: «возьми дорогу Усть-Большерецк — Октябрьский». Ни
    // «закрыт», ни «ограничен» в строке нет — пункт отбрасывался.
    const ub = of('road_closure').find((e) => /Большерецк/.test(e.title));
    expect(ub).toMatchObject({
      severity: 2,
      title: 'Усть-Большерецк (дорога на п. Октябрьский, 115–128 км): проезд только для спецтранспорта',
      affected_zones: ['western'],
    });
  });
});
