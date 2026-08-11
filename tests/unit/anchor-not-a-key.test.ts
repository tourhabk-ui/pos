/**
 * Якорь — не ключ.
 *
 * ── Что измерено ───────────────────────────────────────────────────────────
 *
 * Пересуд привязок 11.08 дал 106 «неоднозначных» и 152 «трек длинный» на 290
 * привязок, а перепись двойников — 6173 пары маршрутов, стоящих ближе трёхсот
 * метров друг к другу, почти все с anchorKm 0. Разбор образцов показал, что
 * это не ошибка координат: кластер «Центральный» — Авачинский–Центральный,
 * 5 стройка–Центральный, Радыгино–Центральный, Пиначево–Центральный,
 * Центральный–Таловские источники — все стоят на кордоне, и стоят там верно.
 *
 * Якорь настоящий. Он просто НЕ РАЗЛИЧАЕТ маршруты: на Камчатке они лучами
 * расходятся от считанных кордонов и посёлков. Значит всё, что опиралось на
 * близость к якорю — привязка трека, поиск двойника, «рядом ли» — спрашивало
 * величину, общую у десятков записей, и получало ответ про кордон.
 *
 * ── Что из этого следует ───────────────────────────────────────────────────
 *
 * Якорь остаётся тем, чем он и является: точкой, куда центрировать карту.
 * Ключом — то есть уликой о тождестве — он быть перестаёт. Здесь два предмета
 * проверки:
 *
 *   1. измерение, которое это показывает (сколько РАЗЛИЧНЫХ точек на 421
 *      маршрут) — без него разговор идёт о парах, а пары сами по себе немы;
 *   2. импорт треков больше не привязывает по близости — и это проверяется
 *      поведением, а не наличием строчки в исходнике.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { importKmlTrack } from '@/lib/import/kml-inbox';
import {
  runDuplicateAudit, endpoints, sameSubject, isLatinTitle,
} from '@/lib/routes/duplicate-audit';

beforeEach(() => {
  poolQueryMock.mockReset();
});

/** Короткий трек у Пиначево: четыре километра. Раньше близость решала. */
const NEAR_TRACK = Array.from({ length: 40 }, (_, i) =>
  `${158.6382 + i * 0.0009},${53.0787 + i * 0.00006}`).join(' ');

function kml(name: string, coords = NEAR_TRACK): string {
  return `<?xml version="1.0"?><kml><Document><name>${name}</name>`
    + `<Placemark><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`
    + `</Document></kml>`;
}

/** Кордон «Центральный»: на нём стоят разные маршруты, и стоят верно. */
const CORDON = { lat: '53.0787', lng: '158.6382' };

describe('импорт трека: близость к якорю больше не привязывает', () => {
  it('якорь чужого маршрута прямо на треке — трек всё равно уходит на ревью', async () => {
    // Тот самый случай в чистом виде: маршрут стоит на кордоне, трек выходит
    // с этого же кордона, но ведёт в другую сторону. Прежнее правило считало
    // это совпадением; на деле совпал кордон.
    poolQueryMock.mockImplementation((sql: string) => {
      if (/^\s*SELECT/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 'r-1', title: 'Маршрут Радыгино - Центральный',
            ...CORDON, geom_source: null, has_geometry: false,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const out = await importKmlTrack('pinachevo.kml', kml('Маршрут Пиначево - Центральный'));
    expect(out.status).toBe('created_hidden');
    expect(out.matched_route_id).toBeUndefined();
    expect(out.match_by).toBeUndefined();

    // И ни одного UPDATE по чужой записи.
    const wrote = poolQueryMock.mock.calls.some(([sql]) => /^\s*UPDATE/i.test(String(sql)));
    expect(wrote).toBe(false);
  });

  it('десяток маршрутов на одной координате — ни один не забирает трек', async () => {
    // Реальная плотность кластера «Центральный»: близость выбрала бы «самый
    // ближний» из шести, стоящих в одной точке, то есть случайный.
    const cluster = ['Авачинский - Центральный', '5 стройка - Центральный',
      'Радыгино - Центральный', 'Центральный - Таловские источники']
      .map((title, i) => ({
        id: `r-${i}`, title, ...CORDON, geom_source: null, has_geometry: false,
      }));
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /^\s*SELECT/i.test(sql) ? cluster : [] }));

    const out = await importKmlTrack('some.kml', kml('Тропа на Верблюд'));
    expect(out.status).toBe('created_hidden');
  });

  it('совпадение по имени работает — оно и различает', async () => {
    // Отказ от близости не должен превратиться в отказ от привязки вообще.
    // Здесь же и вторая находка 11.08: разбор KML снимает слово «Маршрут», а
    // в справочнике оно есть — сравнение имён расходилось само с собой, и
    // одноимённая запись не узнавалась.
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({
        rows: /^\s*SELECT/i.test(sql) ? [{
          id: 'r-7', title: 'Маршрут Пиначево — Центральный', // тире, а в KML дефис
          ...CORDON, geom_source: null, has_geometry: false,
        }] : [],
      }));

    const out = await importKmlTrack('pinachevo.kml', kml('Маршрут Пиначево - Центральный'));
    expect(out.status).toBe('imported');
    expect(out.match_by).toBe('name');
    expect(out.matched_route_id).toBe('r-7');
  });

  it('настоящий трек не перетирается и при совпадении имени', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({
        rows: /^\s*SELECT/i.test(sql) ? [{
          id: 'r-9', title: 'Вулкан Горелый',
          ...CORDON, geom_source: 'osm', has_geometry: true,
        }] : [],
      }));

    const out = await importKmlTrack('gorely.kml', kml('Вулкан Горелый'));
    expect(out.status).toBe('kept_existing_track');
    expect(out.existing_source).toBe('osm');
  });
});

/**
 * То же самое, но в буквах.
 *
 * Скопление якорей показало не только общую точку, но и общее СЛОВО: на
 * кордоне «Центральный» стоят четыре маршрута, и «Центральный» есть в имени
 * каждого — потому что так называется точка, из которой они расходятся. Общая
 * основа у них по устройству названия, а не по предмету.
 */
describe('общий конец пути — не общий маршрут', () => {
  it('название-пара распознаётся, обычное — нет', () => {
    expect(endpoints('Маршрут Пиначево — Центральный')).toEqual(['пиначево', 'центральный']);
    expect(endpoints('Вулкан Горелый')).toBeNull();
  });

  it('совпал один конец — предметы разные', () => {
    // Прежнее правило («есть общая значимая основа») звало их одним предметом.
    expect(sameSubject('Авачинский - Центральный', 'Радыгино - Центральный')).toBe(false);
    expect(sameSubject('5 стройка - Центральный', 'Центральный - Таловские источники')).toBe(false);
  });

  it('совпали оба конца — предмет один, и порядок концов не важен', () => {
    // Обратный обход — тот же путь.
    expect(sameSubject('Пиначево — Центральный', 'Маршрут Центральный - Пиначево')).toBe(true);
  });

  it('названия не-пары судятся как прежде — по общей основе', () => {
    expect(sameSubject('Озеро Толмачева', 'На каяках по озеру Толмачево')).toBe(true);
    expect(sameSubject('Вулкан Горелый', 'Вулкан Мутновский')).toBe(false);
  });
});

describe('перепись отвечает на вопрос «сколько различных точек»', () => {
  /** Ответ БД: три записи на кордоне, две на озере, одна отдельная. */
  const CLUSTER_ROWS = [
    { lat: '53.07870', lng: '158.63820', n: '3',
      sample: ['Авачинский - Центральный', 'Пиначево - Центральный', 'Радыгино - Центральный'] },
    { lat: '52.90000', lng: '158.10000', n: '2', sample: ['Озеро Толмачева', 'На каяках по озеру Толмачево'] },
    { lat: '51.45000', lng: '157.12000', n: '1', sample: ['Курильское озеро'] },
  ];

  const ROUTE_ROWS = [
    { id: '1', title: 'Авачинский - Центральный', lat: '53.0787', lng: '158.6382' },
    { id: '2', title: 'Пиначево - Центральный', lat: '53.0787', lng: '158.6382' },
    { id: '3', title: 'Радыгино - Центральный', lat: '53.0787', lng: '158.6382' },
    { id: '4', title: 'Озеро Толмачева', lat: '52.9', lng: '158.1' },
    { id: '5', title: 'На каяках по озеру Толмачево', lat: '52.9', lng: '158.1' },
    { id: '6', title: 'Курильское озеро', lat: '51.45', lng: '157.12' },
  ];

  beforeEach(() => {
    // Различаем по round(lat — «GROUP BY» есть и у запроса про записи без
    // якоря, а он отвечает другой формой.
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({
        rows: /round\(lat/i.test(sql) ? CLUSTER_ROWS : /lat IS NULL/i.test(sql) ? [] : ROUTE_ROWS,
      }));
  });

  it('считает точки, а не маршруты', async () => {
    // Шесть маршрутов на трёх точках. Разница между этими числами и есть
    // ответ на вопрос, ключ якорь или нет.
    const audit = await runDuplicateAudit();
    expect(audit.routes_counted).toBe(6);
    expect(audit.distinct_anchors).toBe(3);
  });

  it('показывает скопления с названиями — по ним видно, ЧТО это за точка', async () => {
    // Без образца названий цифра «три маршрута в одной точке» не отличает
    // ошибку координат от кордона, а чинить это надо по-разному.
    const audit = await runDuplicateAudit();
    expect(audit.anchor_clusters[0].routes).toBe(3);
    expect(audit.anchor_clusters[0].sample).toContain('Пиначево - Центральный');
    expect(audit.anchor_clusters[0].lat).toBeCloseTo(53.0787, 4);
  });

  it('одиночные точки в скопления не попадают', async () => {
    // «Скопление из одного» — не скопление; список должен читаться, а не
    // повторять весь справочник.
    const audit = await runDuplicateAudit();
    expect(audit.anchor_clusters.every((c) => c.routes > 1)).toBe(true);
    expect(audit.anchor_clusters).toHaveLength(2);
  });

  it('маршрут без координат не стоит «рядом» ни с кем', async () => {
    // Первый прогон 11.08 отчитался о 6188 парах «стоят рядом» — и вывод из
    // них («якорь общий, а потому бесполезен») был неверным. Причина:
    // Number(null) — ноль, и записи без координат вставали нулевой широтой в
    // Гвинейском заливе, все в одной точке. Тот самый класс дефекта, за
    // которым перепись и охотилась, — в самом охотнике.
    const noCoords = [
      { id: 'x1', title: 'Первый безымянный', lat: null, lng: null },
      { id: 'x2', title: 'Второй безымянный', lat: null, lng: null },
      { id: 'x3', title: 'Третий безымянный', lat: null, lng: null },
    ];
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /GROUP BY/i.test(sql) ? [] : noCoords }));

    const audit = await runDuplicateAudit();
    expect(audit.by_kind.same_spot_only).toBe(0);
    expect(audit.by_kind.same_spot_same_subject).toBe(0);
    // И число называется вслух: маршрут без якоря не показать на карте.
    expect(audit.routes_without_anchor).toBe(3);
    expect(audit.distinct_anchors).toBe(0);
  });

  it('у записей без якоря спрашивается происхождение', async () => {
    // Сто двенадцать записей из четырёхсот двадцати одной чинятся двумя очень
    // разными способами — дозаполнить или удалить как мусор импорта, — и
    // выбор зависит от того, один это источник или все понемногу.
    const bySource = [
      { source: 'idilesom', category: 'trekking', n: '80', sample: ['Первый', 'Второй'] },
      { source: null, category: null, n: '32', sample: ['Третий'] },
    ];
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({
        rows: /lat IS NULL/i.test(sql) ? bySource : /GROUP BY/i.test(sql) ? [] : [],
      }));

    const audit = await runDuplicateAudit();
    expect(audit.anchorless_by_source[0]).toMatchObject({ source: 'idilesom', routes: 80 });
    // Отсутствие источника — тоже сведение, а не пробел в таблице.
    expect(audit.anchorless_by_source[1].source).toBe('(не указан)');
    expect(audit.anchorless_by_source[1].category).toBe('(без категории)');
  });

  it('маршрутность подтверждается уликами, а не названием', async () => {
    // «История Камчатки» — статья сайта, затянутая скрейпером в справочник
    // МАРШРУТОВ. Судить об этом по словам было бы гаданием; проверяемый факт —
    // что у записи нет ни координат, ни линии, ни единой путевой точки.
    const anchorless = [
      { id: 'a1', title: 'История Камчатки', has_geometry: false, waypoints: '0' },
      { id: 'a2', title: 'Растения Камчатки', has_geometry: false, waypoints: '0' },
      { id: 'a3', title: 'Озеро Крокур', has_geometry: true, waypoints: '0' },
      { id: 'a4', title: 'SUP-маршрут по реке Пиначевская', has_geometry: false, waypoints: '4' },
      { id: 'a5', title: 'dachnye istochniki', has_geometry: false, waypoints: '0' },
    ];
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /route_waypoints/i.test(sql) ? anchorless : [] }));

    const e = (await runDuplicateAudit()).anchorless_evidence;
    expect(e.nothing_at_all).toBe(3);
    expect(e.has_geometry).toBe(1);
    expect(e.has_waypoints).toBe(1);
    expect(e.nothing_at_all_sample).toContain('История Камчатки');
    // Линия или точки — свидетельство места; такие дозаполняют, а не удаляют.
    expect(e.nothing_at_all_sample).not.toContain('Озеро Крокур');
    expect(e.nothing_at_all_sample).not.toContain('SUP-маршрут по реке Пиначевская');
  });

  it('латинский заголовок — слаг из адреса, и он в отдельном счёте', async () => {
    // «dachnye istochniki» и «Дачные источники» — одна и та же точка двумя
    // записями, и совпадение по имени их не склеит никогда. Это переименовать,
    // а не удалить, поэтому счёт отдельный от «ничем не подтверждена».
    expect(isLatinTitle('dachnye istochniki')).toBe(true);
    expect(isLatinTitle('gornyy massiv vachkazhets')).toBe(true);
    expect(isLatinTitle('Дачные источники')).toBe(false);
    // Латиница внутри русского названия — законна, это не слаг.
    expect(isLatinTitle('SUP-маршрут по реке Пиначевская')).toBe(false);
    // И запись без единой буквы слагом не объявляем.
    expect(isLatinTitle('5')).toBe(false);
  });

  it('пустая строка координаты — тоже не ноль', async () => {
    poolQueryMock.mockImplementation((sql: string) =>
      Promise.resolve({
        rows: /GROUP BY/i.test(sql) ? [] : [
          { id: 'y1', title: 'Первый', lat: '', lng: '' },
          { id: 'y2', title: 'Второй', lat: 'нечисло', lng: '158' },
        ],
      }));

    const audit = await runDuplicateAudit();
    expect(audit.by_kind.same_spot_only).toBe(0);
    expect(audit.routes_without_anchor).toBe(2);
  });

  it('маршруты в одной точке с разным предметом двойниками не зовутся', async () => {
    // Урок Эссо целиком: общая перевалка — не общий объект.
    const audit = await runDuplicateAudit();
    const pair = audit.worst.find(
      (p) => p.a.title === 'Авачинский - Центральный' && p.b.title === 'Радыгино - Центральный',
    );
    expect(pair?.kind).toBe('same_spot_only');
    // Толмачева/Толмачево — тот же предмет, и это уже улика.
    expect(audit.by_kind.same_spot_same_subject).toBeGreaterThan(0);
  });
});
