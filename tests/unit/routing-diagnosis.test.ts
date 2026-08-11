/**
 * Отказ роутера называет причину и подкрепляет её числом.
 *
 * Полевая проба 11.08: четыре километра по Петропавловску, режим «на
 * машине» — `no_path`. Дороги там есть; ответ был про наш граф, а звучал
 * как утверждение о местности. Одним кодом на все случаи разом роутер
 * превращал «мы не знаем» в «дороги нет», и по этому начинали делать
 * выводы — ровно тот дефект, что «0 вместо неизвестно».
 *
 * Разбирается на два разных утверждения:
 *   disconnected — до цели по нашим данным нет НИКАКОГО пути;
 *   mode_blocked — путь есть, но не для этого способа передвижения.
 * Лечатся они разным: первое — импортом, второе — выбором режима.
 */
import { describe, it, expect } from 'vitest';
import {
  componentFrom, diagnoseFailure, findPath, nearestNode, routableNodes,
  type RoadEdge, type RoadNode,
} from '@/lib/routing/astar';

const edge = (from: number, to: number, length_m: number, highway = 'unclassified'): RoadEdge => ({
  from, to, length_m, highway, surface: null, geometry: [[0, 0], [0, 0]],
});

/** Два куска, между ними ничего: так выглядит рассыпанный импорт. */
const TORN: RoadEdge[] = [edge(1, 2, 1000), edge(2, 3, 1000), edge(10, 11, 1000)];

/** Целая улица, но нарисованная тропой: машине не проехать, ногам — да. */
const TRAIL: RoadEdge[] = [edge(1, 2, 500, 'path'), edge(2, 3, 500, 'path')];

describe('компонента связности', () => {
  it('без режима считает связность по данным как таковую', () => {
    expect(componentFrom(TORN, 1)).toEqual(new Set([1, 2, 3]));
    expect(componentFrom(TORN, 10)).toEqual(new Set([10, 11]));
  });

  it('с режимом отсекает непроходимые рёбра', () => {
    // Пешком тропа проходима, машиной — нет, и компонента съёживается до
    // самого узла: ехать некуда.
    expect(componentFrom(TRAIL, 1, 'foot').size).toBe(3);
    expect(componentFrom(TRAIL, 1, 'car')).toEqual(new Set([1]));
  });

  it('одинокий узел — компонента из себя одного, а не пустота', () => {
    expect(componentFrom([], 42)).toEqual(new Set([42]));
  });

  it('петли и повторные рёбра не зацикливают обход', () => {
    const looped = [edge(1, 2, 100), edge(2, 1, 100), edge(1, 1, 5), edge(2, 3, 100)];
    expect(componentFrom(looped, 1)).toEqual(new Set([1, 2, 3]));
  });
});

describe('привязка садится на узел, из которого есть куда выйти', () => {
  const nodes: RoadNode[] = [
    { id: 7, lat: 53.0000, lng: 158.0000 },  // висячий: ближе всех, но рёбер нет
    { id: 1, lat: 53.0010, lng: 158.0000 },  // настоящий перекрёсток, дальше
    { id: 2, lat: 53.0020, lng: 158.0000 },
  ];
  const edges = [edge(1, 2, 100)];

  it('без фильтра привязка липнет к висячему узлу', () => {
    // Так и было: подграф грузится по bbox, рёбра с концом за границей
    // отброшены, висячие узлы есть всегда.
    expect(nearestNode(nodes, 53.0, 158.0)!.node.id).toBe(7);
  });

  it('с фильтром — к ближайшему узлу с рёбрами', () => {
    const allowed = routableNodes(edges, 'car');
    expect(allowed.has(7)).toBe(false);
    expect(nearestNode(nodes, 53.0, 158.0, allowed)!.node.id).toBe(1);
  });

  it('фильтр учитывает режим, а не только наличие ребра', () => {
    const trail = [edge(1, 2, 100, 'path')];
    expect(routableNodes(trail, 'foot').size).toBe(2);
    expect(routableNodes(trail, 'car').size).toBe(0);
  });

  it('проходимых узлов нет вовсе — привязки нет, а не привязка в никуда', () => {
    expect(nearestNode(nodes, 53.0, 158.0, routableNodes([edge(1, 2, 100, 'path')], 'car'))).toBeNull();
  });

  it('расстояние привязки считается до выбранного узла, а не до отброшенного', () => {
    // Иначе экран показал бы «до дороги 0 м», сев на узел в километре.
    const r = nearestNode(nodes, 53.0, 158.0, routableNodes(edges, 'car'))!;
    expect(r.distance_m).toBeGreaterThan(50);
  });
});

describe('диагноз отказа', () => {
  it('граф рассыпан → disconnected, и видно, насколько мал кусок', () => {
    const d = diagnoseFailure(TORN, 1, 11, 'car');
    expect(d.reason).toBe('disconnected');
    expect(d.reachable_any).toBe(3);
  });

  it('путь нарисован, но режим по нему не идёт → mode_blocked', () => {
    // Именно это отличие и было потеряно: машина упиралась в тропу, а ответ
    // звучал как «пути нет вообще».
    const d = diagnoseFailure(TRAIL, 1, 3, 'car');
    expect(d.reason).toBe('mode_blocked');
    expect(d.reachable_any).toBe(3);
    expect(d.reachable_mode).toBe(1);
  });

  it('числа режима и данных расходятся только когда есть чему расходиться', () => {
    const open: RoadEdge[] = [edge(1, 2, 100), edge(2, 3, 100)];
    const d = diagnoseFailure(open, 1, 99, 'car');
    expect(d.reason).toBe('disconnected');
    expect(d.reachable_mode).toBe(d.reachable_any);
  });

  it('диагноз согласован с самим поиском пути', () => {
    // Диагноз, противоречащий findPath, хуже отсутствия диагноза: он
    // объясняет то, чего не было.
    const nodes = new Map<number, RoadNode>([
      [1, { id: 1, lat: 53, lng: 158 }],
      [3, { id: 3, lat: 53.01, lng: 158 }],
    ]);
    expect(findPath(nodes, TRAIL, 1, 3, 'car')).toBeNull();
    expect(findPath(nodes, TRAIL, 1, 3, 'foot')).not.toBeNull();
    expect(diagnoseFailure(TRAIL, 1, 3, 'car').reason).toBe('mode_blocked');
  });
});
