/**
 * get_weather по координатам: точка огрубляется, кэш прогнозов ограничен
 * (проверка MCP 29.09).
 *
 * Агент может прислать геопозицию человека. До этого дня она уходила в
 * Open-Meteo (зарубежный сервис) и в лог прода с точностью ~11 м, а каждый
 * новый квадрат сотых градуса оставался в кэше процесса на три часа — без
 * потолка, при том что публичный MCP принимает любую точку Земли.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { weatherTarget } from '@/lib/kuzmich/weather-tool';
import { fetchForecastDays, forecastCacheSize } from '@/lib/planner/intelligence';

describe('точка огрубляется до сотых', () => {
  it('координата человека не доходит до сервиса и лога точной', () => {
    const t = weatherTarget({ lat: '53.012345', lng: '158.654321' });
    expect(t.kind).toBe('point');
    if (t.kind !== 'point') return;
    expect(t.lat).toBe(53.01);
    expect(t.lng).toBe(158.65);
    expect(t.name).toBe('точка 53.01, 158.65');
  });
});

describe('кэш прогнозов с потолком', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ daily: { time: ['2026-09-30'] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('новые точки не растят кэш без предела', async () => {
    // 5200 разных квадратов — больше потолка.
    for (let i = 0; i < 5200; i++) {
      await fetchForecastDays(-60 + (i % 100) / 100 * 1, -170 + Math.floor(i / 100), 1);
    }
    expect(forecastCacheSize()).toBeLessThanOrEqual(5000);
    expect(fetchMock).toHaveBeenCalledTimes(5200);
  });
});
