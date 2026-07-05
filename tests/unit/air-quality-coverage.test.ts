/**
 * tests/unit/air-quality-coverage.test.ts
 *
 * getCoverageStats (issue #291): доля вулканических зон со свежим (<6ч)
 * сигналом IQAir. Все зоны отвечают → 100%; упавшая зона попадает в
 * stale_zones и снижает coverage_pct; без ключа роут отдаёт degraded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCoverageStats, clearAirQualityFreshness } from '@/lib/services/air-quality';
import { ZONES } from '@/lib/services/zone-weather';

const TOTAL = Object.keys(ZONES).length;

function iqairOk(aqi: number): Response {
  return new Response(
    JSON.stringify({ status: 'success', data: { current: { pollution: { aqius: aqi, mainus: 'p2' } } } }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearAirQualityFreshness();
  process.env.IQAIR_API_KEY = 'test-key';
});

describe('getCoverageStats (IQAir по вулканическим зонам)', () => {
  it('все зоны отвечают → 100%, stale_zones пуст', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(iqairOk(42)));

    const stats = await getCoverageStats();

    expect(stats.total_zones).toBe(TOTAL);
    expect(stats.zones_with_fresh_data).toBe(TOTAL);
    expect(stats.coverage_pct).toBe(100);
    expect(stats.stale_zones).toEqual([]);
    expect(stats.zones.every(z => z.fresh && z.ageMinutes === 0)).toBe(true);
  });

  it('одна зона падает → она в stale_zones, coverage_pct ниже 100', async () => {
    // Первая зона (mutnovsky) получает 500, остальные — ок
    vi.spyOn(global, 'fetch').mockImplementation((url) =>
      Promise.resolve(String(url).includes('lat=52.4&') ? new Response('', { status: 500 }) : iqairOk(55)),
    );

    const stats = await getCoverageStats();

    expect(stats.zones_with_fresh_data).toBe(TOTAL - 1);
    expect(stats.coverage_pct).toBe(Math.round(((TOTAL - 1) / TOTAL) * 100));
    expect(stats.stale_zones.map(z => z.zone)).toEqual(['mutnovsky']);
    expect(stats.stale_zones[0].ageMinutes).toBeNull(); // данных не было вовсе
  });

  it('зона падает сейчас, но отвечала недавно → всё ещё fresh (окно 6ч)', async () => {
    // Прогрев: все отвечают
    const spy = vi.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(iqairOk(30)));
    await getCoverageStats();

    // Второй прогон: всё падает, но lastSuccess свежий
    spy.mockImplementation(() => Promise.reject(new Error('quota exceeded')));
    const stats = await getCoverageStats();

    expect(stats.zones_with_fresh_data).toBe(TOTAL);
    expect(stats.coverage_pct).toBe(100);
  });

  it('без IQAIR_API_KEY все зоны stale (getZoneAirQuality возвращает null)', async () => {
    delete process.env.IQAIR_API_KEY;
    const fetchSpy = vi.spyOn(global, 'fetch');

    const stats = await getCoverageStats();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stats.zones_with_fresh_data).toBe(0);
    expect(stats.coverage_pct).toBe(0);
    expect(stats.stale_zones.length).toBe(TOTAL);
  });
});
