/**
 * Расхождение называет СВОЮ точку.
 *
 * Перепись 18.08 вернула первую ненулевую черту и вместе с ней двадцать
 * отказов «точка стоит в N км от линии». Двадцать — число, которое разбирают
 * руками, но по счётчику случай не откроешь: неизвестно, какой маршрут и
 * какая точка. Причина словами называет только расстояние.
 *
 * Правило теперь возвращает номер спорной точки, а имена подставляет тот, кто
 * эти точки передал. Здесь сторож на два свойства:
 *
 *   1. Номер указывает на ТУ САМУЮ точку, из-за которой вынесен отказ.
 *   2. Номер и причина словами не расходятся: есть один — есть другой.
 *
 * Второе важнее первого. Если список случаев начнёт жить отдельно от
 * счётчика, разбор пойдёт по одному набору, а решение — по другому; это тот
 * же класс, ради которого §12 писался.
 */
import { describe, it, expect } from 'vitest';
import { routeNavigability } from '@/lib/routes/navigability';
import { DATA_CONFLICT_KM } from '@/lib/on-route/approach';

/** Прямая линия вдоль долготы — по ней и меряется отход. */
const line: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [
  53.2 + i * 0.002,
  158.4,
]);

/** Точечный род — иначе расстояние черта не считает (центроид парка ни о чём). */
const POINT = 'hot_spring';

describe('спорная точка называется поимённо', () => {
  it('номер указывает на точку, из-за которой вынесен отказ', () => {
    const nav = routeNavigability({
      grade: 'surveyed',
      track: line,
      waypoints: [
        { lat: 53.21, lng: 158.4 },   // на линии
        { lat: 53.24, lng: 158.4 },   // на линии
        { lat: 53.25, lng: 158.9 },   // в стороне — этот и спорит
      ],
      waypointTypes: [POINT, POINT, POINT],
    });

    expect(nav.verdict).toBe('orientation_only');
    expect(nav.conflict, 'отказ по расстоянию есть, а точка не названа').toBeDefined();
    expect(nav.conflict!.index).toBe(2);
    expect(nav.conflict!.offTrackKm).toBeGreaterThan(DATA_CONFLICT_KM);
  });

  it('номер и причина словами не расходятся', () => {
    const cases = [
      { lat: 53.21, lng: 158.4 },
      { lat: 53.25, lng: 158.9 },
      { lat: 53.9, lng: 159.9 },
    ];
    for (const w of cases) {
      const nav = routeNavigability({
        grade: 'surveyed',
        track: line,
        waypoints: [{ lat: 53.22, lng: 158.4 }, w],
        waypointTypes: [POINT, POINT],
      });
      const saidKm = nav.reasons.some((r) => r.includes('км от линии'));
      expect(
        Boolean(nav.conflict),
        `причина «${nav.reasons.join('; ') || 'нет'}» и номер точки разошлись`,
      ).toBe(saidKm);
      if (nav.conflict) {
        // Расстояние в причине и в номере — одна величина, а не два счёта.
        expect(nav.reasons.join(' ')).toContain(nav.conflict.offTrackKm.toFixed(1));
      }
    }
  });

  it('протяжённый объект точкой спора не становится', () => {
    const nav = routeNavigability({
      grade: 'surveyed',
      track: line,
      waypoints: [{ lat: 53.22, lng: 158.4 }, { lat: 53.25, lng: 158.9 }],
      // Парк: координата — центроид, расстояние до неё ничего не опровергает.
      waypointTypes: [POINT, 'national_park'],
    });
    expect(nav.conflict).toBeUndefined();
    expect(nav.reasons.some((r) => r.includes('км от линии'))).toBe(false);
  });
});
