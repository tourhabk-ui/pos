/**
 * Как путевые точки сидят на треке: отход И ПОРЯДОК.
 *
 * Раньше мерилось одно — «самая дальняя точка от линии». Величина верная, но
 * не знает порядка: трек, проходящий те же места в обратную сторону, по ней
 * неотличим от правильного, потому что все точки на линии.
 *
 * ── Почему не Фреше ────────────────────────────────────────────────────────
 *
 * Каноническую меру похожести кривых я взял первой, и она на этих данных не
 * работает: дискретный Фреше сцепляет ВЕРШИНЫ, а у нас трек в сотни точек
 * против трёх-четырёх путевых. Вершина трека посередине между двумя точками
 * отстоит от обеих на половину шага разметки — и мера показывает шаг
 * разметки, а не расхождение путей. Тест это и поймал; пороги под него
 * подгонять не стал, потому что это подгонка инструмента под ответ.
 */
import { describe, it, expect } from 'vitest';
import {
  waypointFit, routeIntegrity, pointsAreCollection, OFF_TRACK_M, LINE_BREAK_KM,
} from '@/lib/routes/shape-match';
import type { GeoPoint } from '@/lib/on-route/approach';

/** Тропа на север: 40 точек, около девяти километров. */
const TRACK: GeoPoint[] = Array.from({ length: 40 }, (_, i) => ({ lat: 53 + i * 0.002, lng: 158 }));

/** Путевые точки вдоль тропы, в правильном порядке. */
const IN_ORDER: GeoPoint[] = [0, 13, 26, 39].map((i) => TRACK[i]);

describe('порядок — то, чего не было', () => {
  it('точки по порядку — всё сходится', () => {
    const f = waypointFit(TRACK, IN_ORDER);
    expect(f.verdict).toBe('fits');
    expect(f.inversions).toBe(0);
  });

  it('обратный обход: все точки на линии, а путь другой', () => {
    // Прежняя мера тут показывала нулевой отход и молчала.
    const f = waypointFit(TRACK, [...IN_ORDER].reverse());
    expect(f.maxOffsetM).toBeLessThan(50);
    expect(f.verdict).toBe('out_of_order');
    expect(f.inversions).toBe(3);
  });

  it('одна перепутанная точка видна, а не тонет в среднем', () => {
    const shuffled = [IN_ORDER[0], IN_ORDER[2], IN_ORDER[1], IN_ORDER[3]];
    expect(waypointFit(TRACK, shuffled).inversions).toBe(1);
  });
});

describe('отход считается до ЛИНИИ, а не до её вершин', () => {
  it('точка между вершинами трека не считается отошедшей', () => {
    // Тут и ломался Фреше: он мерил бы полшага разметки как расхождение.
    const between: GeoPoint = { lat: (TRACK[10].lat + TRACK[11].lat) / 2, lng: 158 };
    expect(waypointFit(TRACK, [between]).maxOffsetM).toBeLessThan(5);
  });

  it('точка в стороне — отход, и приговор про него', () => {
    const aside: GeoPoint = { lat: 53.02, lng: 158.02 };
    const f = waypointFit(TRACK, [aside]);
    expect(f.maxOffsetM!).toBeGreaterThan(OFF_TRACK_M);
    expect(f.verdict).toBe('off_track');
  });

  it('порог оставляет обычную разметку в покое', () => {
    // Точку ставят на МЕСТО — озеро отмечают у берега, вулкан у подножия.
    const nearby: GeoPoint = { lat: 53.02, lng: 158.003 };
    expect(waypointFit(TRACK, [nearby]).verdict).toBe('fits');
  });
});

describe('отход важнее порядка: сначала «где», потом «в каком порядке»', () => {
  it('точка далеко и порядок нарушен — говорим про отход', () => {
    const bad = [TRACK[30], TRACK[10], { lat: 53.02, lng: 158.05 }];
    expect(waypointFit(TRACK, bad).verdict).toBe('off_track');
  });
});

describe('нечего мерить — так и сказано', () => {
  it('нет линии или нет точек — unknown, а не нули', () => {
    // Ноль отхода читался бы как «идеально легло» — то же «0 вместо неизвестно».
    for (const f of [waypointFit([], IN_ORDER), waypointFit(TRACK, []), waypointFit([TRACK[0]], IN_ORDER)]) {
      expect(f.verdict).toBe('unknown');
      expect(f.maxOffsetM).toBeNull();
      expect(f.inversions).toBeNull();
    }
  });

  it('одна точка: порядка не существует, и это NULL, а не ноль', () => {
    // Ноль означал бы «порядок проверен и не нарушен». Проверять нечего.
    const f = waypointFit(TRACK, [TRACK[5]]);
    expect(f.inversions).toBeNull();
    expect(f.verdict).toBe('fits');
  });
});

describe('покрытие показывает, о какой части пути вообще идёт речь', () => {
  it('точки по всему треку — покрытие близко к единице', () => {
    expect(waypointFit(TRACK, IN_ORDER).coverage!).toBeGreaterThan(0.9);
  });

  it('точки в начале — покрытие мало, и это видно', () => {
    // «Точки лежат верно» на пятой части маршрута — не то же, что на всём.
    const head = [TRACK[0], TRACK[3], TRACK[6]];
    expect(waypointFit(TRACK, head).coverage!).toBeLessThan(0.25);
  });
});

describe('мера подключена к переписи', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8',
  ) as string;

  it('перепись считает посадку точек, а не только дальнюю точку', () => {
    expect(src).toMatch(/waypointFit\(/);
    expect(src).toMatch(/by_shape/);
  });

  it('прежняя величина не выброшена — обе в ответе', () => {
    expect(src).toMatch(/worstOffTrackKm/);
  });

  it('подборка по ЛИНИИ судится разрывом, а не габаритом', () => {
    // Габарит сплошной линии равен длине маршрута: им «Сплав по реке Камчатка,
    // 500 км» объявлялся подборкой. Разрыв — признак того, что пути нет.
    // К имени вызова не привязываемся: правило проверяется поведением меры
    // выше, здесь — только что перепись не судит линию габаритом.
    expect(src).not.toMatch(/scatteredGeo = isScatteredCollection\(/);
    expect(src).not.toMatch(/boundingSpanKm\(pairs\)\s*>/);
  });
});

/**
 * Три сигнала — в одном месте.
 *
 * Отход и порядок жили здесь, непрерывность — в geometry-compact, а порог
 * прыжка был отдельной константой в переписи. Та же конфигурация, которая за
 * сутки разошлась дважды: SQL-чистка алертов отстала от TS-стража на один
 * глагол, и правило рисования линии разъехалось по трём экранам.
 */
describe('целостность маршрута: три сигнала, один ответ', () => {
  /** Линия с разрывом: два куска, между ними полкрая. */
  const BROKEN: GeoPoint[] = [
    { lat: 53.00, lng: 158.0 }, { lat: 53.01, lng: 158.0 },
    { lat: 55.90, lng: 158.7 }, { lat: 55.91, lng: 158.7 },
  ];

  it('линия рвётся — это не путь, и про точки спрашивать незачем', () => {
    // У набора мест вопрос «в каком порядке идут точки» бессмысленен.
    expect(routeIntegrity(BROKEN, IN_ORDER).verdict).toBe('not_a_path');
  });

  it('сплошная длинная линия путём остаётся', () => {
    // «Сплав по реке Камчатка, 500 км» габаритом объявлялся подборкой.
    const long: GeoPoint[] = Array.from({ length: 400 }, (_, i) => ({ lat: 53 + i * 0.01, lng: 158 }));
    expect(routeIntegrity(long, []).maxGapKm!).toBeLessThan(LINE_BREAK_KM);
    expect(routeIntegrity(long, []).verdict).toBe('unknown'); // точек нет — судить нечем
  });

  it('порядок ветвей: разрыв важнее отхода, отход важнее порядка', () => {
    const aside: GeoPoint[] = [{ lat: 53.02, lng: 158.05 }, { lat: 53.0, lng: 158.05 }];
    expect(routeIntegrity(BROKEN, aside).verdict).toBe('not_a_path');
    expect(routeIntegrity(TRACK, aside).verdict).toBe('points_off_path');
    expect(routeIntegrity(TRACK, [...IN_ORDER].reverse()).verdict).toBe('points_out_of_order');
    expect(routeIntegrity(TRACK, IN_ORDER).verdict).toBe('coherent');
  });

  it('нет линии — unknown, а не «всё хорошо»', () => {
    const r = routeIntegrity([], IN_ORDER);
    expect(r.verdict).toBe('unknown');
    expect(r.maxGapKm).toBeNull();
  });

  it('у НАБОРА ТОЧЕК работают оба признака, включая габарит', () => {
    // Тут габарит — улика: места по краю и прыгают, и разбросаны.
    const across: GeoPoint[] = [
      { lat: 53.0, lng: 158.6 }, { lat: 55.9, lng: 158.7 }, { lat: 51.5, lng: 157.1 },
    ];
    expect(pointsAreCollection(across)).toBe(true);
    expect(pointsAreCollection(IN_ORDER)).toBe(false);
    expect(pointsAreCollection([IN_ORDER[0]])).toBe(false);
  });

  it('перепись спрашивает сигналы у одной меры, а не считает свои', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8',
    ) as string;
    expect(src).toMatch(/routeIntegrity\(/);
    expect(src).toMatch(/pointsAreCollection\(/);
    // Своего порога прыжка в переписи остаться не должно.
    expect(src).not.toMatch(/COLLECTION_JUMP_KM/);
    expect(src).not.toMatch(/maxSegmentKm\(/);
  });
});
