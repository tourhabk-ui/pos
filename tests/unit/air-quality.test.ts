import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getZoneAirQuality, getAllZonesAirQuality, categorizeAqi, clearAirQualityCache,
} from '@/lib/services/safety/air-quality';

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
    clearAirQualityCache();
    process.env.IQAIR_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.IQAIR_API_KEY;
    else process.env.IQAIR_API_KEY = ORIGINAL_ENV;
  });

  it('без ключа — отказ с причиной no_key, и провайдера не беспокоим', async () => {
    delete process.env.IQAIR_API_KEY;
    const fetchSpy = vi.spyOn(global, 'fetch');

    const result = await getZoneAirQuality('avachinsky');

    expect(result).toEqual({ ok: false, reason: 'no_key' });
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
      ok: true,
      data: {
      zone: 'avachinsky',
      zoneName: 'Авачинский вулкан',
      aqiUs: 42,
      mainPollutant: 'p2',
      category: 'good',
      // Источник в этой фикстуре города не назвал — станции нет, и это
      // честный null, а не «станция прямо в зоне» (23.08).
      station: null,
      },
    });
  });

  it('источник ответил и станции у него нет — это no_station', async () => {
    // Единственный случай, который вправе называться отсутствием покрытия.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'fail' }), { status: 200 }),
    );

    const result = await getZoneAirQuality('mutnovsky_s');

    expect(result).toEqual({ ok: false, reason: 'no_station' });
  });

  it('сеть упала — network, а не «станции нет»', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(getZoneAirQuality('tolbachik')).resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('429 — предел плана, и он назван так, а не «нет данных»', async () => {
    // Именно эта подмена 23.08 привела к неверному выводу «IQAir не покрывает
    // Толбачик»: шесть параллельных запросов дважды подряд упёрлись в предел
    // бесплатного плана, а выглядело это как отсутствие станций.
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

    expect(await getZoneAirQuality('klyuchi')).toEqual({ ok: false, reason: 'rate_limited', status: 429 });
  });

  it('401 — ключ не принят, и это не путается с пределом', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    expect(await getZoneAirQuality('nalychevo')).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
  });

  it('повторный запрос берётся из кэша — квота плана не жжётся зря', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 'success',
        data: { current: { pollution: { aqius: 42, mainus: 'p2' } } },
      }), { status: 200 }),
    );

    await getZoneAirQuality('avachinsky');
    await getZoneAirQuality('avachinsky');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getAllZonesAirQuality', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearAirQualityCache();
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
