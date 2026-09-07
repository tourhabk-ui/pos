/**
 * Координаты словами (05.09, «хочу видеть координаты»). Сторож держит
 * форматы, которые диктуют спасателям: DD в пять знаков и DMS с десятой
 * секунды и русскими полушариями, без «60.0″» на границе округления.
 */
import { describe, it, expect } from 'vitest';
import { formatDD, formatDMS, formatCoords, toDMS, distanceM } from '@/lib/geo/format-coords';

describe('координаты словами', () => {
  const p = { lat: 53.258912, lng: 158.831071 };

  it('DD — пять знаков через запятую, широта первой', () => {
    expect(formatDD(p)).toBe('53.25891, 158.83107');
    expect(formatDD({ lat: -33.8688, lng: -151.2093 }, 3)).toBe('-33.869, -151.209');
  });

  it('DMS — градусы, минуты, десятая секунды и русские полушария', () => {
    expect(formatDMS(p)).toBe('53°15′32.1″ с.ш. 158°49′51.9″ в.д.');
    expect(formatDMS({ lat: -1.5, lng: -0.25 })).toBe('1°30′00.0″ ю.ш. 0°15′00.0″ з.д.');
  });

  it('округление секунд до 60 переносится в минуты и градусы', () => {
    // 59′59.97″ → 1°00′00.0″, а не 0°59′60.0″.
    expect(toDMS(0.99999, 'с.ш.', 'ю.ш.')).toBe('1°00′00.0″ с.ш.');
  });

  it('formatCoords переключает формат одним словом', () => {
    expect(formatCoords(p, 'dd')).toBe(formatDD(p));
    expect(formatCoords(p, 'dms')).toBe(formatDMS(p));
  });

  it('расстояние: Петропавловск — Елизово около 29 км, та же точка — ноль', () => {
    const d = distanceM({ lat: 53.0195, lng: 158.6505 }, { lat: 53.1830, lng: 158.3880 });
    expect(d).toBeGreaterThan(24000);
    expect(d).toBeLessThan(26000);
    expect(distanceM(p, p)).toBe(0);
  });
});
