import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geocodeAddress, withinKamchatka, clearGeocodeCache, normalizeGeocodeKey } from '@/lib/services/routes/geocode';

describe('withinKamchatka', () => {
  it('accepts coordinates within the Kamchatka bounding box', () => {
    expect(withinKamchatka(53.2551, 158.6939)).toBe(true); // Петропавловск-Камчатский
  });

  it('rejects coordinates outside the bounding box', () => {
    expect(withinKamchatka(55.75, 37.62)).toBe(false); // Москва
  });

  it('accepts exact boundary values', () => {
    expect(withinKamchatka(50, 155)).toBe(true);
    expect(withinKamchatka(64, 167)).toBe(true);
  });

  it('rejects values just outside the boundary', () => {
    expect(withinKamchatka(49.9, 160)).toBe(false);
    expect(withinKamchatka(60, 167.1)).toBe(false);
  });
});

describe('geocodeAddress (Nominatim/OpenStreetMap)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearGeocodeCache();
  });

  it('returns null for an empty query without calling fetch', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const result = await geocodeAddress('   ');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns lat/lng/displayName from the first result', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { lat: '53.2551', lon: '158.6939', display_name: 'Петропавловск-Камчатский, Камчатский край, Россия' },
      ]), { status: 200 }),
    );

    const result = await geocodeAddress('Петропавловск-Камчатский');

    expect(result).toEqual({
      lat: 53.2551,
      lng: 158.6939,
      displayName: 'Петропавловск-Камчатский, Камчатский край, Россия',
      source: 'nominatim',
    });
  });

  it('повторный геокод того же имени → source: cache, без сетевого вызова (issue #290)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { lat: '52.4550', lon: '157.9880', display_name: 'Вулкан Горелый, Камчатский край' },
      ]), { status: 200 }),
    );

    const first = await geocodeAddress('Вулкан Горелый');
    // То же имя в другом регистре и с лишними пробелами — тот же кэш-ключ
    const second = await geocodeAddress('  вулкан   горелый ');

    expect(first?.source).toBe('nominatim');
    expect(second?.source).toBe('cache');
    expect(second?.lat).toBe(52.455);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('null-результат НЕ кэшируется — временный сбой сети не залипает', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { lat: '53.0', lon: '158.0', display_name: 'Место' },
      ]), { status: 200 }));

    expect(await geocodeAddress('Ключевская сопка')).toBeNull();
    const retry = await geocodeAddress('Ключевская сопка');

    expect(retry?.source).toBe('nominatim');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('sends a valid User-Agent header (required by Nominatim usage policy)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await geocodeAddress('Авачинский вулкан');

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBeTruthy();
  });

  it('returns null when Nominatim finds no match', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const result = await geocodeAddress('несуществующее место нигде');
    expect(result).toBeNull();
  });

  it('returns null (fail-open) on network error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(geocodeAddress('вулкан')).resolves.toBeNull();
  });

  it('returns null on non-ok HTTP status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    const result = await geocodeAddress('вулкан');
    expect(result).toBeNull();
  });
});

describe('normalizeGeocodeKey', () => {
  it('схлопывает регистр и пробелы', () => {
    expect(normalizeGeocodeKey('  Вулкан   Горелый ')).toBe('вулкан горелый');
  });
});
