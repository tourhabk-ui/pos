/**
 * lib/on-route/destination.ts — «куда» отдельно от «как» (владелец 27.08).
 *
 * Route-first модель смешивала цель и путь: выбор «Вулкан Авачинский» на
 * самом деле выбирал ОДНУ из линий к нему, гора нигде не фиксировалась как
 * отдельная сущность. Сторож держит контракт минимального шага:
 *  - совпавшее место с настоящими id/координатами становится Destination,
 *    а непроверенные линии к нему — routeOptions ВНУТРИ этой цели;
 *  - существующая сортировка/группировка (groupRoutesByPlace) переиспользуется
 *    без изменений — домен только оборачивает её;
 *  - место без разрешимых id/координат НЕ выдумывается — путь остаётся в
 *    titleOnly, а не получает фиктивную Destination-карточку.
 */
import { describe, it, expect } from 'vitest';
import { groupRoutesByDestination, type DestinationCandidate } from '@/lib/on-route/destination';

const R = (
  id: string,
  wps: string[] = [],
  ids: (string | null)[] = [],
  lats: (number | null)[] = [],
  lngs: (number | null)[] = [],
  extra: Partial<DestinationCandidate> = {},
): DestinationCandidate => ({
  id,
  title: id,
  distanceKm: 5,
  lineGrade: 'unknown',
  waypointNames: wps,
  waypointIds: ids,
  waypointLats: lats,
  waypointLngs: lngs,
  ...extra,
});

describe('совпавшее место с настоящей личностью — Destination', () => {
  it('id/координаты берутся по ТОМУ ЖЕ индексу, что и совпавшее имя', () => {
    const routes = [
      R('к-вершине', ['Вулкан Авачинский'], ['place-1'], [53.25], [158.83]),
      R('через-перевал', ['Вулкан Авачинский'], ['place-1'], [53.25], [158.83]),
    ];
    const { destinations, titleOnly } = groupRoutesByDestination(routes, 'авачинский');
    expect(destinations).toHaveLength(1);
    expect(destinations[0].destination).toEqual({
      kind: 'place', id: 'place-1', title: 'Вулкан Авачинский', lat: 53.25, lon: 158.83,
    });
    expect(destinations[0].routeOptions).toHaveLength(2);
    expect(titleOnly).toHaveLength(0);
  });

  it('непроверенная линия — вариант пути ВНУТРИ цели, а не сама цель', () => {
    const routes = [R('линия', ['Вулкан Авачинский'], ['place-1'], [53.25], [158.83], { lineGrade: 'unknown' })];
    const { destinations } = groupRoutesByDestination(routes, 'авачинский');
    expect(destinations[0].routeOptions[0].id).toBe('линия');
    expect(destinations[0].routeOptions[0].lineGrade).toBe('unknown');
  });

  it('индекс совпавшего имени ищется по имени, а не по позиции 0', () => {
    // Вторая путевая точка — та, что совпала запросом; личность должна
    // взяться со ВТОРОГО индекса всех трёх параллельных массивов.
    const routes = [
      R('через-две-точки', ['Кордон', 'Вулкан Авачинский'], ['place-0', 'place-1'], [10, 53.25], [20, 158.83]),
    ];
    const { destinations } = groupRoutesByDestination(routes, 'авачинский');
    expect(destinations[0].destination).toMatchObject({ id: 'place-1', lat: 53.25, lon: 158.83 });
  });
});

describe('честный откат: нет id/координат — нет выдуманной цели', () => {
  it('место совпало текстом, но массивы личности отсутствуют — путь остаётся titleOnly', () => {
    const routes = [R('без-личности', ['Вулкан Авачинский'])];
    const { destinations, titleOnly } = groupRoutesByDestination(routes, 'авачинский');
    expect(destinations).toHaveLength(0);
    expect(titleOnly).toHaveLength(1);
    expect(titleOnly[0].id).toBe('без-личности');
  });

  it('координата пришла null (не разрешилось) — тоже откат в titleOnly', () => {
    const routes = [R('null-координата', ['Вулкан Авачинский'], ['place-1'], [null], [158.83])];
    const { destinations, titleOnly } = groupRoutesByDestination(routes, 'авачинский');
    expect(destinations).toHaveLength(0);
    expect(titleOnly).toHaveLength(1);
  });

  it('маршруты, совпавшие только названием (без места вовсе), остаются titleOnly', () => {
    const routes = [R('только-именем', [])];
    const { destinations, titleOnly } = groupRoutesByDestination(routes, 'что-то');
    expect(destinations).toHaveLength(0);
    expect(titleOnly).toHaveLength(1);
  });
});

describe('переиспользование существующей группировки — не копия', () => {
  it('внутри routeOptions сохраняется порядок groupRoutesByPlace (род линии → сложность → длина)', () => {
    const routes = [
      R('unknown-длинный', ['Скалы Три Брата'], ['p'], [53], [158], { lineGrade: 'unknown', distanceKm: 10 }),
      R('surveyed-короткий', ['Скалы Три Брата'], ['p'], [53], [158], { lineGrade: 'surveyed', distanceKm: 1 }),
    ];
    const { destinations } = groupRoutesByDestination(routes, 'три брата');
    expect(destinations[0].routeOptions.map(o => o.id)).toEqual(['surveyed-короткий', 'unknown-длинный']);
  });
});
