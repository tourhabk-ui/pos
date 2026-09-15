/**
 * Сторож превью снятой записи (lib/field/track-preview).
 *
 * Держит ровно то, чем превью может соврать о записи:
 *   — склеить куски в одну линию, выдав прямую через молчание прибора за
 *     снятый путь (§12);
 *   — потерять конец записи при прореживании;
 *   — умолчать о прореживании, то есть выдать огрубление за запись;
 *   — вернуть рамку там, где точек нет вовсе (§4.0: ноль вместо «не знаю»).
 */

import { describe, it, expect } from 'vitest';
import { buildTrackPreview } from '@/lib/field/track-preview';
import { splitAtGaps, type SegmentPoint } from '@/lib/field/track-segments';

function line(n: number, lat0 = 53.0, lng0 = 158.0, t0 = 0): SegmentPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: lat0 + i * 0.0005,
    lng: lng0 + i * 0.0005,
    ele: 100 + i,
    t: t0 + i * 5000,
  }));
}

describe('buildTrackPreview', () => {
  it('кусок записи остаётся куском: одна непрерывная запись — одна линия, ни одной прямой через молчание', () => {
    const preview = buildTrackPreview(splitAtGaps(line(40)));
    expect(preview.pieces).toHaveLength(1);
    expect(preview.gaps).toHaveLength(0);
  });

  it('провал сигнала даёт ОТДЕЛЬНУЮ прямую, а не шов внутри снятой линии', () => {
    // Второй кусок начинается через час и в семи километрах — прибор молчал.
    const points = [...line(20), ...line(20, 53.07, 158.07, 3_600_000)];
    const preview = buildTrackPreview(splitAtGaps(points));

    expect(preview.pieces.length).toBeGreaterThan(1);
    expect(preview.gaps).toHaveLength(preview.pieces.length - 1);

    // Прямая соединяет КОНЕЦ предыдущего куска с НАЧАЛОМ следующего: иначе
    // она пройдёт не там, где прибор молчал, и соврёт о месте провала.
    const [from, to] = preview.gaps[0]!;
    const first = preview.pieces[0]!;
    expect(from).toEqual(first[first.length - 1]);
    expect(to).toEqual(preview.pieces[1]![0]);
  });

  it('прореживание сохраняет концы записи и объявляет себя числами', () => {
    const points = line(5000);
    const preview = buildTrackPreview(splitAtGaps(points), 300);

    expect(preview.shown).toBeLessThanOrEqual(300);
    expect(preview.of).toBe(points.length);
    // Умолчать о прореживании — значит выдать огрубление за запись.
    expect(preview.shown).toBeLessThan(preview.of);

    const drawn = preview.pieces[0]!;
    expect(drawn[0]).toEqual([points[0]!.lat, points[0]!.lng]);
    expect(drawn[drawn.length - 1]).toEqual([
      points[points.length - 1]!.lat,
      points[points.length - 1]!.lng,
    ]);
  });

  it('короткая запись не прореживается и не объявляет себя прореженной', () => {
    const points = line(12);
    const preview = buildTrackPreview(splitAtGaps(points), 600);
    expect(preview.shown).toBe(preview.of);
    expect(preview.pieces[0]).toHaveLength(12);
  });

  it('рамка охватывает запись целиком', () => {
    const preview = buildTrackPreview(splitAtGaps(line(30)));
    const b = preview.bounds!;
    expect(b.south).toBeCloseTo(53.0, 5);
    expect(b.north).toBeCloseTo(53.0 + 29 * 0.0005, 5);
    expect(b.west).toBeCloseTo(158.0, 5);
    expect(b.east).toBeCloseTo(158.0 + 29 * 0.0005, 5);
  });

  it('точек нет — рамки НЕТ, а не ноль: нулевая координата лежит в Гвинейском заливе', () => {
    const preview = buildTrackPreview([]);
    expect(preview.bounds).toBeNull();
    expect(preview.pieces).toHaveLength(0);
    expect(preview.of).toBe(0);
  });
});
