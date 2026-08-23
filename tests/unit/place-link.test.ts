/**
 * Привязка мест к маршрутам — правила подсказчика.
 *
 * Сторож стоит на главном уроке миграции 167: близость НЕ доказывает, что
 * маршрут проходит через место, поэтому имя весит больше расстояния, а
 * родовые слова («вулкан», «источники») не должны опознавать ничего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  significantTokens, nameMatchScore, distanceKm, suggestRoutes, suggestPlaces,
  linkPairProblems, clusterConflicts, CONFLICT_AGREEMENT_KM,
  type RouteCandidateInput, type PlaceCandidateInput, type CoordinateConflict,
} from '@/lib/routes/place-link';

const ROOT = process.cwd();

describe('значимые слова названия', () => {
  it('родовые слова отбрасываются', () => {
    expect(significantTokens('Малкинские горячие источники')).toEqual(['малкинские']);
    expect(significantTokens('Вулкан Плоский Толбачик')).toEqual(['плоский', 'толбачик']);
  });

  it('название из одних родовых слов не опознаёт ничего', () => {
    expect(significantTokens('Горячие источники')).toEqual([]);
    expect(nameMatchScore('Горячие источники', 'Термальные источники Паратунки')).toBe(0);
  });
});

describe('совпадение имени', () => {
  it('падежный хвост не мешает — сравниваются основы', () => {
    expect(nameMatchScore('Малкинские горячие источники', 'Малкинские')).toBe(1);
    expect(nameMatchScore('Вулкан Авачинский', 'Восхождение на Авачинский вулкан')).toBe(1);
  });

  it('чужой маршрут не совпадает', () => {
    expect(nameMatchScore('Вулкан Горелый', 'Восхождение на Мутновский вулкан')).toBe(0);
  });

  it('частичное совпадение считается долей', () => {
    // «Плоский» есть, «Толбачик» есть → 1; только один из двух → 0.5
    expect(nameMatchScore('Вулкан Плоский Толбачик', 'Вокруг Толбачиков')).toBe(0.5);
  });
});

describe('подсказка кандидатов', () => {
  const routes: RouteCandidateInput[] = [
    { id: 'r-malki', title: 'Малкинские', lat: 53.28, lng: 157.58, hasGeometry: true, waypointCount: 2 },
    { id: 'r-near', title: 'Термальный день', lat: 53.29, lng: 157.59, hasGeometry: false, waypointCount: 0 },
    { id: 'r-far', title: 'Ключевская группа', lat: 56.05, lng: 160.64, hasGeometry: true, waypointCount: 5 },
  ];
  const place = { name: 'Малкинские горячие источники', lat: 53.28, lng: 157.58 };

  it('маршрут с именем места идёт первым, даже если сосед ближе', () => {
    const out = suggestRoutes({ ...place, lat: 53.29, lng: 157.59 }, routes);
    expect(out[0].routeId).toBe('r-malki');
    expect(out[0].nameScore).toBe(1);
  });

  it('далёкие и безымянные кандидаты не показываются', () => {
    const out = suggestRoutes(place, routes, { maxKm: 20 });
    expect(out.map(c => c.routeId)).not.toContain('r-far');
  });

  it('место без координат всё равно получает подсказку по имени', () => {
    const out = suggestRoutes({ name: 'Малкинские горячие источники', lat: null, lng: null }, routes);
    expect(out).toHaveLength(1);
    expect(out[0].routeId).toBe('r-malki');
    expect(out[0].distanceKm).toBeNull();
  });
});

describe('обратная подсказка: места для маршрута без точек', () => {
  const places: PlaceCandidateInput[] = [
    { id: 'p-avacha', name: 'Вулкан Авачинский', locationType: 'volcano', lat: 53.26, lng: 158.83 },
    { id: 'p-camp', name: 'Авачинский перевал', locationType: 'mountain', lat: 53.27, lng: 158.80 },
    { id: 'p-museum', name: 'Краевой художественный музей', locationType: 'museum', lat: 53.02, lng: 158.65 },
    { id: 'p-far', name: 'Озеро Кроноцкое', locationType: 'lake', lat: 54.75, lng: 160.25 },
  ];

  it('маршрут называет место — оно идёт первым с полным счётом', () => {
    const out = suggestPlaces({ title: 'Восхождение на Авачинский вулкан', lat: 53.25, lng: 158.82 }, places);
    expect(out[0].placeId).toBe('p-avacha');
    expect(out[0].nameScore).toBe(1);
  });

  it('далёкое и безымянное не показывается', () => {
    const out = suggestPlaces({ title: 'Восхождение на Авачинский вулкан', lat: 53.25, lng: 158.82 }, places);
    expect(out.map(c => c.placeId)).not.toContain('p-far');
  });

  it('городской сосед без совпадения имени не вытесняет цель маршрута', () => {
    // Музей ближе к точке старта, чем перевал, но маршрут его не называет.
    const out = suggestPlaces({ title: 'Восхождение на Авачинский вулкан', lat: 53.05, lng: 158.68 }, places);
    const museumIdx = out.findIndex(c => c.placeId === 'p-museum');
    const avachaIdx = out.findIndex(c => c.placeId === 'p-avacha');
    expect(avachaIdx).toBeGreaterThanOrEqual(0);
    expect(museumIdx === -1 || museumIdx > avachaIdx).toBe(true);
  });
});

describe('расстояние', () => {
  it('Петропавловск — Елизово примерно 27 км', () => {
    const d = distanceKm(53.024, 158.643, 53.183, 158.388);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(30);
  });
});

describe('валидация пар', () => {
  it('повтор пары — проблема', () => {
    expect(linkPairProblems([
      { place: 'p', route: 'r' }, { place: 'p', route: 'r' },
    ])).toHaveLength(1);
  });

  it('одно место в несколько маршрутов — норма (вершина на трёх тропах)', () => {
    expect(linkPairProblems([
      { place: 'p', route: 'r1' }, { place: 'p', route: 'r2' },
    ])).toHaveLength(0);
  });
});

describe('обещания эндпоинта', () => {
  it('привязка только поимённая — авто-режима по радиусу нет', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link/route.ts'), 'utf-8');
    expect(src).toContain('pairs');
    expect(src, 'радиусный авто-режим повторил бы паутины миграции 167')
      .not.toMatch(/INSERT INTO route_waypoints[\s\S]{0,400}JOIN places/);
  });

  it('привязка идёт только к живым маршрутам и живым местам', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link/route.ts'), 'utf-8');
    expect(src).toContain('r.is_visible = true');
    expect(src).toContain('r.merged_into_id IS NULL');
    expect(src).toContain('p.merged_into_id IS NULL');
  });

  it('род waypoint требует улики имени, а не расстояния (миграция 874)', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link/route.ts'), 'utf-8');
    // Разметка пишется явно, с отметкой времени.
    expect(src).toContain('link_kind');
    expect(src).toContain('link_kind_at');
    // Отказ размечать waypoint без совпадения имён — не молчаливый пропуск.
    expect(src).toContain("kind === 'waypoint' && nameScore === 0");
    // Из расстояния род не выводится нигде.
    expect(src, 'род связи из distanceKm — выключение сигнализации §4.1')
      .not.toMatch(/kind\s*=[^=][^\n]*distanceKm/);
  });

  it('боевая партия ограничена десятью парами (правило владельца)', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link/route.ts'), 'utf-8');
    expect(src).toContain('LIVE_BATCH_MAX = 10');
    expect(src).toMatch(/!data\.dry_run && data\.pairs\.length > LIVE_BATCH_MAX/);
  });
});

describe('обещания подсказчика маршрутов (route-link-suggest)', () => {
  it('читает только живое с обеих сторон и ничего не пишет', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/route-link-suggest/route.ts'), 'utf-8');
    expect(src).toContain('r.is_visible = true');
    expect(src).toContain('r.merged_into_id IS NULL');
    expect(src).toContain('p.is_visible = true');
    expect(src).toContain('p.merged_into_id IS NULL');
    expect(src).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});


describe('улики о координатах: кто в одиночестве', () => {
  /** Улика с обеими координатами — иначе чинить нечего. */
  function conflict(
    placeName: string, placeLat: number, placeLng: number,
    routeTitle: string, routeLat: number, routeLng: number,
  ): CoordinateConflict {
    return {
      placeId: `place-${placeName}`, placeName, placeLat, placeLng,
      routeId: `route-${routeTitle}`, routeTitle, routeLat, routeLng,
      nameScore: 1,
      distanceKm: Math.round(distanceKm(placeLat, placeLng, routeLat, routeLng) * 10) / 10,
    };
  }

  it('кучные одноимённые маршруты — согласие свидетелей', () => {
    // Два маршрута «Тюшевские» рядом друг с другом, место — за сотни км.
    const clusters = clusterConflicts([
      conflict('Большие Тюшевские источники', 52.9, 158.2, 'Большие Тюшевские источники', 54.66, 161.33),
      conflict('Большие Тюшевские источники', 52.9, 158.2, 'Малые Тюшевские источники', 54.68, 161.36),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].agreement).toBe('routes_agree');
    expect(clusters[0].routesSpreadKm).not.toBeNull();
    expect(clusters[0].routesSpreadKm!).toBeLessThanOrEqual(CONFLICT_AGREEMENT_KM);
    // Обе координаты доехали: без них следующего шага нет.
    expect(clusters[0].placeLat).toBe(52.9);
    expect(clusters[0].routes[0].lat).toBeGreaterThan(54);
  });

  it('один свидетель — исход отдельный, не «согласие»', () => {
    const clusters = clusterConflicts([
      conflict('Корякский заповедник', 60.0, 166.0, 'Вулкан Корякский', 53.32, 158.71),
    ]);
    expect(clusters[0].agreement).toBe('single_witness');
    expect(clusters[0].routesSpreadKm).toBeNull();
  });

  it('разбросанные маршруты не выдаются за согласие', () => {
    const clusters = clusterConflicts([
      conflict('Ключи', 52.0, 158.0, 'Ключи северные', 56.3, 160.8),
      conflict('Ключи', 52.0, 158.0, 'Ключи южные', 51.4, 156.5),
    ]);
    expect(clusters[0].agreement).toBe('routes_disagree');
    expect(clusters[0].routesSpreadKm!).toBeGreaterThan(CONFLICT_AGREEMENT_KM);
  });

  it('вердикта «врёт место» функция не выносит — только факт согласия', () => {
    const src = readFileSync(join(ROOT, 'lib/routes/place-link.ts'), 'utf-8');
    // Три исхода объявлены и все достижимы; четвёртого — «виновен» — нет.
    expect(src).toContain("'routes_agree' | 'routes_disagree' | 'single_witness'");
    expect(src, 'кучность маршрутов — довод, а не приговор')
      .not.toMatch(/suspect:\s*'place'/);
  });

  it('подсказчик отдаёт улики сгруппированными и с координатами', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/place-link-suggest/route.ts'), 'utf-8');
    expect(src).toContain('clusterConflicts');
    expect(src).toContain('conflict_clusters');
    // Слабые улики не исчезают молча — их число названо.
    expect(src).toContain('coordinate_conflicts_weak_total');
    // Материал для решения идёт раньше улик.
    expect(src.indexOf('items: withCandidates')).toBeLessThan(src.indexOf('conflict_clusters'));
  });
});
