/**
 * Путь от человека до цели раскладывается на честные куски.
 *
 * Полевой скриншот 11.08: «до точки 20.3 км по прямой». Человек в
 * Петропавловске, целевая точка — в Авачинской бухте, трек уходит на
 * юго-запад. Прямая между человеком и точкой пересекает залив: число честно
 * буквально и бесполезно по существу — идти по нему нельзя, и оно не
 * совпадает с нарисованной линией.
 *
 * Здесь стережётся, что путь считается ОТ МЕСТА ЧЕЛОВЕКА и вдоль тропы, а
 * подход и выход не выдаются за путь по тропе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  projectOnTrack, approachPlan, straightKm, ON_TRACK_TOLERANCE_KM, DATA_CONFLICT_KM,
} from '@/lib/on-route/approach';

/** Тропа с юга на север по одному меридиану: удобно считать в уме. */
const MERIDIAN = [
  { lat: 53.00, lng: 158.00 },
  { lat: 53.10, lng: 158.00 },
  { lat: 53.20, lng: 158.00 },
];
const KM_PER_DEG = 111.32;

describe('проекция ищет точку НА тропе, а не ближайшую вершину', () => {
  it('человек сбоку от середины звена проецируется в середину, а не в вершину', () => {
    // Вершины стоят через 11 км. Ближайшая вершина увела бы вбок на 5.5 км от
    // места, где человек реально выйдет на тропу.
    const pr = projectOnTrack({ lat: 53.05, lng: 158.02 }, MERIDIAN)!;
    expect(pr.point.lat).toBeCloseTo(53.05, 4);
    expect(pr.point.lng).toBeCloseTo(158.00, 4);
    expect(pr.offTrackKm).toBeLessThan(2);
  });

  it('человек за концом тропы проецируется в конец, а не за него', () => {
    const pr = projectOnTrack({ lat: 53.40, lng: 158.00 }, MERIDIAN)!;
    expect(pr.point.lat).toBeCloseTo(53.20, 4);
  });

  it('человек НА тропе даёт нулевой отход', () => {
    const pr = projectOnTrack({ lat: 53.15, lng: 158.00 }, MERIDIAN)!;
    expect(pr.offTrackKm).toBeLessThan(0.01);
  });

  it('пустая и одноточечная тропа не роняют расчёт', () => {
    expect(projectOnTrack({ lat: 53, lng: 158 }, [])).toBeNull();
    expect(projectOnTrack({ lat: 53, lng: 158 }, [{ lat: 53.1, lng: 158 }])!.segment).toBe(0);
  });

  it('вырожденное звено не делит на ноль', () => {
    const dup = [{ lat: 53, lng: 158 }, { lat: 53, lng: 158 }, { lat: 53.1, lng: 158 }];
    const pr = projectOnTrack({ lat: 53.05, lng: 158 }, dup)!;
    expect(Number.isFinite(pr.offTrackKm)).toBe(true);
  });
});

describe('путь распадается на подход, тропу и выход', () => {
  it('человек и цель на тропе — весь путь по тропе', () => {
    const p = approachPlan(
      { lat: 53.02, lng: 158.00 }, { lat: 53.18, lng: 158.00 }, MERIDIAN,
    )!;
    expect(p.approachKm).toBeLessThan(ON_TRACK_TOLERANCE_KM);
    expect(p.exitKm).toBeLessThan(ON_TRACK_TOLERANCE_KM);
    expect(p.alongTrackKm).toBeCloseTo(0.16 * KM_PER_DEG, 1);
    expect(p.userOffTrack).toBe(false);
    expect(p.targetOffTrack).toBe(false);
  });

  it('человек в стороне — подход назван отдельно и не влит в тропу', () => {
    const p = approachPlan(
      { lat: 53.02, lng: 158.05 }, { lat: 53.18, lng: 158.00 }, MERIDIAN,
    )!;
    expect(p.userOffTrack).toBe(true);
    expect(p.approachKm).toBeGreaterThan(1);
    // По тропе — по-прежнему ровно между проекциями, подход туда не подмешан.
    expect(p.alongTrackKm).toBeCloseTo(0.16 * KM_PER_DEG, 1);
    expect(p.totalKm).toBeCloseTo(p.approachKm + p.alongTrackKm + p.exitKm, 6);
  });

  it('цель не на тропе — это сказано, а не спрятано', () => {
    // Ровно случай со скриншота: путевая точка стоит в стороне от линии.
    const p = approachPlan(
      { lat: 53.02, lng: 158.00 }, { lat: 53.18, lng: 158.30 }, MERIDIAN,
    )!;
    expect(p.targetOffTrack).toBe(true);
    expect(p.exitKm).toBeGreaterThan(5);
  });

  it('путь считается от МЕСТА ЧЕЛОВЕКА: сдвинулся — изменилось', () => {
    const near = approachPlan({ lat: 53.15, lng: 158 }, { lat: 53.20, lng: 158 }, MERIDIAN)!;
    const far = approachPlan({ lat: 53.00, lng: 158 }, { lat: 53.20, lng: 158 }, MERIDIAN)!;
    expect(near.totalKm).toBeLessThan(far.totalKm);
  });

  it('сумма кусков не выдаётся за путь по тропе', () => {
    const p = approachPlan(
      { lat: 53.02, lng: 158.10 }, { lat: 53.18, lng: 158.10 }, MERIDIAN,
    )!;
    expect(p.totalKm).toBeGreaterThan(p.alongTrackKm);
  });

  it('без тропы плана нет — врать нечем', () => {
    expect(approachPlan({ lat: 53, lng: 158 }, { lat: 53.1, lng: 158 }, [])).toBeNull();
    expect(approachPlan({ lat: 53, lng: 158 }, { lat: 53.1, lng: 158 }, [{ lat: 53, lng: 158 }])).toBeNull();
  });
});

describe('прямая по-прежнему считается прямой', () => {
  it('градус широты — сто одиннадцать километров', () => {
    expect(straightKm({ lat: 53, lng: 158 }, { lat: 54, lng: 158 })).toBeCloseTo(KM_PER_DEG, 0);
  });

  it('на широте Камчатки градус долготы короче градуса широты', () => {
    const byLat = straightKm({ lat: 53, lng: 158 }, { lat: 54, lng: 158 });
    const byLng = straightKm({ lat: 53, lng: 158 }, { lat: 53, lng: 159 });
    expect(byLng).toBeLessThan(byLat);
  });
});

describe('когда точка и трек про разное — считать нечего', () => {
  it('цель в двадцати километрах от трека: это не длинный подход, а кривые данные', () => {
    // Скриншот 11.08: «Мыс Маячный» на южном берегу входа в Авачинскую бухту,
    // трек — по дорогам вдоль северного, между ними вода. Экран показывал
    // «20.3 км» и «придём через 5 ч 45 м» — числа, по которым не дойти.
    const p = approachPlan(
      { lat: 53.02, lng: 158.00 }, { lat: 53.10, lng: 158.40 }, MERIDIAN,
    )!;
    expect(p.exitKm).toBeGreaterThan(DATA_CONFLICT_KM);
    expect(p.dataConflict).toBe(true);
  });

  it('двести метров в стороне — обычная неточность, не конфликт', () => {
    const p = approachPlan(
      { lat: 53.02, lng: 158.00 }, { lat: 53.10, lng: 158.003 }, MERIDIAN,
    )!;
    expect(p.dataConflict).toBe(false);
  });

  it('порог считает ТОЛЬКО отрыв цели: далеко стоящий человек данные не портит', () => {
    // Турист может законно быть в тридцати километрах от начала маршрута.
    // Это про него, а не про качество данных маршрута.
    const p = approachPlan(
      { lat: 53.02, lng: 158.50 }, { lat: 53.10, lng: 158.00 }, MERIDIAN,
    )!;
    expect(p.userOffTrack).toBe(true);
    expect(p.dataConflict).toBe(false);
  });
});

describe('проекция одна на весь экран', () => {
  it('рельеф режется той же проекцией, что считает расстояние', async () => {
    // Было две реализации одного понятия: расстояние — проекцией на ЗВЕНО,
    // рельеф — по ближайшей ВЕРШИНЕ. Вершины прореженного трека стоят через
    // сотни метров, и два числа про одно положение расходились.
    const src = readFileSync(join(process.cwd(), 'lib/routes/relief.ts'), 'utf-8');
    expect(src).toMatch(/from '@\/lib\/on-route\/approach'/);
    expect(src).toMatch(/projectOnTrack\(/);
    expect(src).not.toMatch(/bestIdx/);
  });

  it('точка сбоку от середины длинного звена не округляется до вершины', async () => {
    const { distanceAlongTrack } = await import('@/lib/routes/relief');
    // Звено в 11 км: вершинная привязка дала бы 0 либо 11 км, сегментная — 5.5.
    const m = distanceAlongTrack([[53.00, 158.00], [53.10, 158.00]], 53.05, 158.01)!;
    expect(m).toBeGreaterThan(4000);
    expect(m).toBeLessThan(7000);
  });
});
