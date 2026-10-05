/**
 * Погода зон — Open-Meteo, не wttr.in (04.10, проба 708).
 *
 * wttr.in отдавал пяти зонам из шести ОДНО значение (+8°, 26 км/ч,
 * «Солнечно») — одну станцию на все районы; Ключи — по-английски. Open-Meteo
 * в тех же точках: Авачинский +0.8° с порывами 70 км/ч. Кузьмич отвечал
 * туристу погодой одного места под именами разных районов.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wmoDescriptionRu } from '@/lib/weather/wmo-hazard';

const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/zone-weather.ts'), 'utf8');
const code = SRC.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('источник погоды зон', () => {
  it('Open-Meteo по точке зоны, с порывами; wttr.in в коде нет', () => {
    expect(code).toContain('https://api.open-meteo.com/v1/forecast?latitude=${zone.lat}&longitude=${zone.lon}');
    expect(code).toContain('wind_gusts_10m');
    expect(code).not.toContain('wttr.in');
  });

  it('разные точки — разные ответы, порывы и высота доходят до строки Кузьмича', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      const avacha = u.includes('latitude=53.3');
      return new Response(JSON.stringify({
        elevation: avacha ? 943 : 402,
        current: avacha
          ? { temperature_2m: 0.8, apparent_temperature: -2.7, wind_speed_10m: 7.4, wind_gusts_10m: 69.5, weather_code: 1 }
          : { temperature_2m: 5.6, apparent_temperature: 3.1, wind_speed_10m: 5.4, wind_gusts_10m: 30.2, weather_code: 3 },
      }), { status: 200 });
    });
    const { getZoneWeatherForText } = await import('@/lib/services/safety/zone-weather');
    const line = await getZoneWeatherForText('пойдём на авачинский и мутновский');
    expect(line).toContain('Авачинский вулкан (~943 м): +1C');
    expect(line).toContain('порывы до 70 км/ч');
    expect(line).toContain('Мутновский вулкан (~402 м): +6C');
    expect(line).toContain('пасмурно');
  });

  it('отказ источника — null и строка в логе, не выдуманная погода', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 503 }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getZoneWeather } = await import('@/lib/services/safety/zone-weather');
    expect(await getZoneWeather('tolbachik')).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe('описание по коду WMO', () => {
  it('по-русски; незнакомый код — без подписи', () => {
    expect(wmoDescriptionRu(0)).toBe('ясно');
    expect(wmoDescriptionRu(3)).toBe('пасмурно');
    expect(wmoDescriptionRu(51)).toBe('слабая морось');
    expect(wmoDescriptionRu(42)).toBeNull();
    expect(wmoDescriptionRu(null)).toBeNull();
  });
});
