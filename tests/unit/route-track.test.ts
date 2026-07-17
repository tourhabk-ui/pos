import { describe, it, expect } from 'vitest';
import { extractTrackpoints, decimateTrack } from '@/lib/routes/track';

const line = (n: number) => ({
  type: 'LineString',
  coordinates: Array.from({ length: n }, (_, i) => [158 + i * 0.001, 53 + i * 0.001]),
});

describe('extractTrackpoints', () => {
  it('geometry LineString — приоритет 1, [lng,lat] → {lat,lng}', () => {
    const pts = extractTrackpoints({ type: 'LineString', coordinates: [[158.6, 53.2, 100], [158.7, 53.3]] }, {});
    expect(pts).toEqual([
      { lng: 158.6, lat: 53.2, elevation: 100 },
      { lng: 158.7, lat: 53.3, elevation: undefined },
    ]);
  });

  it('legacy payload.geometry — приоритет 2', () => {
    const pts = extractTrackpoints(null, { geometry: line(3) });
    expect(pts).toHaveLength(3);
    expect(pts[0].lat).toBe(53);
  });

  it('legacy payload.track — приоритет 3, битые точки отфильтрованы', () => {
    const pts = extractTrackpoints(null, {
      track: [{ lat: 53.2, lng: 158.6 }, { lat: NaN, lng: 1 }, null, { lat: 53.3, lng: 158.7 }],
    });
    expect(pts).toHaveLength(2);
  });

  it('мусорные координаты в LineString отфильтрованы', () => {
    const pts = extractTrackpoints(
      { type: 'LineString', coordinates: [[158.6, 53.2], ['x' as unknown as number, 53], [158.7]] },
      {},
    );
    expect(pts).toHaveLength(1);
  });

  it('нет ничего — пустой массив', () => {
    expect(extractTrackpoints(null, null)).toEqual([]);
    expect(extractTrackpoints({ type: 'Point', coordinates: [[1, 2]] }, {})).toEqual([]);
  });
});

describe('decimateTrack', () => {
  it('короткий трек не трогается', () => {
    const pts = extractTrackpoints(line(10), {});
    expect(decimateTrack(pts, 600)).toHaveLength(10);
  });

  it('длинный трек прорежен, старт и финиш сохранены', () => {
    const pts = extractTrackpoints(line(5000), {});
    const out = decimateTrack(pts, 600);
    expect(out.length).toBeLessThanOrEqual(601);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });
});
