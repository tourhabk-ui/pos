/**
 * Одна геометрия: форма Дугласом-Пекером, шкала — метрами полного трека.
 *
 * Прежнее прореживание брало каждую N-ю точку и срезало вершины поворотов ПО
 * ПОСТРОЕНИЮ. На серпантине от тропы оставались хорды, а по хорде проекция
 * человека уходит вбок — экран объявлял уход с тропы, которого нет, и занижал
 * расстояние. Дуглас-Пекер выбрасывает точки на прямых и сохраняет ровно
 * перегибы, то есть то, ради чего трек и снимали.
 *
 * Шкала при этом остаётся отдельной величиной: даже хорошее упрощение делает
 * ломаную короче настоящей, и без накопленных метров полного трека профиль
 * снова тихо разъехался бы с положением.
 */
import { describe, it, expect } from 'vitest';
import {
  simplifyIndices, decimateTrackWithScale, SIMPLIFY_EPSILON_M, type TrackPoint,
} from '@/lib/routes/track';
import { haversineM } from '@/lib/routes/relief';

/** Прямая с частыми точками: упрощать тут есть что. */
function straight(n: number): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({ lat: 53 + i * 0.0002, lng: 158 }));
}

/** Серпантин: зигзаг с амплитудой ~80 м — заметно больше допуска. */
function serpentine(n: number): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: 53 + i * 0.0005,
    lng: 158 + (i % 2 === 0 ? 0.0012 : -0.0012),
  }));
}

describe('упрощение выбрасывает прямые, а не повороты', () => {
  it('на прямой остаются только концы', () => {
    const idx = simplifyIndices(straight(200));
    expect(idx).toEqual([0, 199]);
  });

  it('на серпантине повороты сохраняются', () => {
    // Здесь и ломался прежний метод: каждая N-я точка спрямляла зигзаг.
    const pts = serpentine(60);
    const idx = simplifyIndices(pts);
    expect(idx.length).toBeGreaterThan(pts.length / 2);
  });

  it('концы трека не теряются никогда', () => {
    for (const pts of [straight(50), serpentine(50)]) {
      const idx = simplifyIndices(pts);
      expect(idx[0]).toBe(0);
      expect(idx[idx.length - 1]).toBe(pts.length - 1);
    }
  });

  it('порядок точек сохраняется', () => {
    const idx = simplifyIndices(serpentine(80));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it('два узла и меньше — не о чем упрощать', () => {
    expect(simplifyIndices([])).toEqual([]);
    expect(simplifyIndices(straight(2))).toEqual([0, 1]);
  });

  it('длинный трек не переполняет стек', () => {
    // Явный стек вместо рекурсии: OSM-треки бывают в тысячи точек.
    expect(() => simplifyIndices(serpentine(4000))).not.toThrow();
  });

  it('допуск меньше точности GPS — иначе упрощение съело бы тропу', () => {
    expect(SIMPLIFY_EPSILON_M).toBeLessThan(30);
  });
});

describe('шкала остаётся шкалой полного трека', () => {
  it('шкала равна длине ПОЛНОГО трека, а не упрощённого', () => {
    const pts = serpentine(400);
    const { points, dm } = decimateTrackWithScale(pts);
    expect(dm.length).toBe(points.length);

    // Считаем полную длину той же меркой, что и сборщик шкалы.
    let full = 0;
    for (let i = 1; i < pts.length; i++) full += haversineM(pts[i - 1], pts[i]);
    expect(dm[dm.length - 1]).toBeCloseTo(full, 6);
  });

  it('упрощение делает ломаную короче — ровно поэтому шкала и нужна', () => {
    // Если бы длины совпадали, отдельная шкала была бы лишней. На прямой
    // упрощение выбрасывает всё лишнее, и разница видна в чистом виде.
    const pts = [...straight(200), { lat: 53.05, lng: 158.02 }, ...straight(3)];
    const { points, dm } = decimateTrackWithScale(pts);
    let simplified = 0;
    for (let i = 1; i < points.length; i++) simplified += haversineM(points[i - 1], points[i]);
    expect(simplified).toBeLessThanOrEqual(dm[dm.length - 1] + 1);
  });

  it('шкала монотонна и начинается с нуля', () => {
    const { dm } = decimateTrackWithScale(serpentine(300));
    expect(dm[0]).toBe(0);
    for (let i = 1; i < dm.length; i++) expect(dm[i]).toBeGreaterThanOrEqual(dm[i - 1]);
  });

  it('короткий трек отдаётся целиком со своей шкалой', () => {
    const pts = straight(2);
    const { points, dm } = decimateTrackWithScale(pts);
    expect(points.length).toBe(2);
    expect(dm.length).toBe(2);
  });

  it('пустой вход не роняет расчёт', () => {
    expect(decimateTrackWithScale([])).toEqual({ points: [], dm: [] });
  });
});

describe('потолок ответа не возвращает шаговую выборку', () => {
  it('перебор точек режется ужесточением допуска, а не каждой N-й', () => {
    // Иначе всё, ради чего звали Дугласа-Пекера, потерялось бы на последнем шаге.
    const { points } = decimateTrackWithScale(serpentine(5000), 600);
    expect(points.length).toBeLessThanOrEqual(600);
    // И повороты при этом всё равно остаются: спрямлённой прямой не выходит.
    const lngs = new Set(points.map((p) => p.lng.toFixed(4)));
    expect(lngs.size).toBeGreaterThan(1);
  });
});
