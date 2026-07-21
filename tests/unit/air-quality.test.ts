import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getZoneAirQuality, getAllZonesAirQuality, categorizeAqi } from '@/lib/services/safety/air-quality';

describe('categorizeAqi', () => {
  it('categorizes AQI thresholds per US EPA breakpoints', () => {
    expect(categorizeAqi(30)).toBe('good');
    expect(categorizeAqi(75)).toBe('moderate');
    expect(categorizeAqi(120)).toBe('unhealthy_sensitive');
    expect(categorizeAqi(175)).toBe('unhealthy');
    expect(categorizeAqi(250)).toBe('very_unhealthy');
    expect(categorizeAqi(400)).toBe('hazardous');
  });

  it('handles exact boundary values', () => {
    expect(categorizeAqi(50)).toBe('good');
    expect(categorizeAqi(51)).toBe('moderate');
  });
});

describe('getZoneAirQuality (IQAir — volcanic ash signal)', () => {
  const ORIGINAL_ENV = process.env.IQAIR_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.IQAIR_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.IQAIR_API_KEY;
    else process.env.IQAIR_API_KEY = ORIGINAL_ENV;
  });

  it('returns null without throwing when IQAIR_API_KEY is not set', async () => {
    delete process.env.IQAIR_API_KEY;
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await getZoneAirQuality('avachinsky');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns AQI and category when IQAir responds with pollution data', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 'success',
        data: { current: { pollution: { aqius: 42, mainus: 'p2' } } },
      }), { status: 200 }),
    );

    const result = await getZoneAirQuality('avachinsky');

    expect(result).toEqual({
      zone: 'avachinsky',
      zoneName: 'Авачинский вулкан',
      aqiUs: 42,
      mainPollutant: 'p2',
      category: 'good',
    });
  });

  it('returns null when IQAir has no monitoring station near a remote zone', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'fail' }), { status: 200 }),
    );

    const result = await getZoneAirQuality('mutnovsky_s');

    expect(result).toBeNull();
  });

  it('returns null (fail-open) on network error, does not throw', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(getZoneAirQuality('tolbachik')).resolves.toBeNull();
  });

  it('returns null on non-ok HTTP status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

    const result = await getZoneAirQuality('klyuchi');

    expect(result).toBeNull();
  });
});

describe('getAllZonesAirQuality', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.IQAIR_API_KEY = 'test-key';
  });

  it('filters out zones with no data, keeps only successful ones', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      // avachinsky координаты — единственная "успешная" станция в этом тесте
      if (String(url).includes('lat=53.3')) {
        return new Response(JSON.stringify({
          status: 'success',
          data: { current: { pollution: { aqius: 60, mainus: 'p2' } } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'fail' }), { status: 200 });
    });

    const results = await getAllZonesAirQuality();

    expect(results).toHaveLength(1);
    expect(results[0]!.zone).toBe('avachinsky');
  });
});
