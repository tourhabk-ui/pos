import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { trailObservationZone, TRAIL_OBSERVATION_RADIUS_M } from '@/lib/safety/trail-observation-zones';
import { checkZone } from '@/lib/safety/geofence';
import { SIGHTING_WINDOW_MS } from '@/lib/safety/bear-sightings';

// 03.10: брод, завал, камнепад из наблюдений туристов — зонами геофенса.
const NOW = Date.parse('2026-10-03T08:00:00Z');

describe('зона из наблюдения о тропе', () => {
  const z = trailObservationZone({ id: '7', type: 'trail', lat: 53.2, lng: 158.8, text: 'Брод по пояс после дождя', hoursAgo: 5 }, NOW);

  it('слова туриста, возраст и отметка модерации', () => {
    expect(z.hazard).toBe('trail');
    expect(z.message).toContain('Брод по пояс после дождя');
    expect(z.message).toContain('5 ч назад');
    expect(z.message).toContain('прошло модерацию');
  });

  it('срок — от времени наблюдения, а не ответа', () => {
    expect(z.expiresAt).toBe(NOW - 5 * 3_600_000 + SIGHTING_WINDOW_MS);
  });

  it('пустой текст не подменяется выдумкой', () => {
    const e = trailObservationZone({ id: '8', type: 'rockfall', lat: 53.2, lng: 158.8, text: '  ', hoursAgo: 30 }, NOW);
    expect(e.message).toContain('Камнепад — отметка без описания');
  });

  it('предупреждает на подходе: за ~400 м — «рядом», дальше 450 м — молчит', () => {
    const dLat = (m: number) => m / 111_320;
    expect(checkZone(53.2 + dLat(400), 158.8, 10, z)?.state).toBe('near');
    expect(checkZone(53.2 + dLat(100), 158.8, 10, z)?.state).toBe('inside');
    expect(checkZone(53.2 + dLat(TRAIL_OBSERVATION_RADIUS_M * 1.6), 158.8, 10, z)).toBeNull();
  });
});

describe('производитель подключён', () => {
  it('geofence-zones берёт одобренные свежие наблюдения о тропе', () => {
    const src = readFileSync('app/api/safety/geofence-zones/route.ts', 'utf8');
    expect(src).toMatch(/report_type = ANY\(\$2::text\[\]\)/);
    expect(src).toMatch(/AND \$\{FRESH_APPROVED_SQL\}[\s\S]*TRAIL_HAZARD_REPORT_TYPES/);
    expect(src).toMatch(/trailObservationZone\(/);
  });
});
