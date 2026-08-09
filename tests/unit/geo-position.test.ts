/**
 * Запрос местоположения: одна дверь и честная причина отказа.
 *
 * Владелец 09.08: «геоточки не работают» — кнопка «Моё местоположение» на
 * радаре. В коде было восемь мест с разными настройками, а у кнопки — худшие:
 * таймаут восемь секунд (холодный фикс на телефоне часто дольше), без запроса
 * точности, и любая беда сводилась к «Геолокация недоступна». Плюс не было
 * состояния «ищу»: нажатие выглядело как молчание.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestPosition, geoFailureText, GEO_DEFAULT_TIMEOUT_MS } from '@/lib/geo/current-position';

const RADAR = readFileSync(join(process.cwd(), 'components/safety/LiveStatus.tsx'), 'utf-8');

function mockGeo(impl: (ok: PositionCallback, err: PositionErrorCallback, o?: PositionOptions) => void) {
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: impl } });
}

afterEach(() => vi.unstubAllGlobals());

describe('причина отказа различима', () => {
  it('успех отдаёт координаты и точность', async () => {
    mockGeo((ok) => ok({ coords: { latitude: 53.02, longitude: 158.65, accuracy: 12 } } as GeolocationPosition));
    const r = await requestPosition();
    expect(r).toEqual({ ok: true, lat: 53.02, lng: 158.65, accuracyM: 12 });
  });

  it('коды спецификации разводятся по смыслу', async () => {
    for (const [code, kind] of [[1, 'denied'], [2, 'unavailable'], [3, 'timeout']] as const) {
      mockGeo((_ok, err) => err({ code } as GeolocationPositionError));
      const r = await requestPosition();
      expect(r).toEqual({ ok: false, kind });
    }
  });

  it('нет датчика — отдельный случай, его не «попробуешь снова»', async () => {
    vi.stubGlobal('navigator', {});
    const r = await requestPosition();
    expect(r).toEqual({ ok: false, kind: 'unsupported' });
  });

  it('каждая причина говорит, что делать', () => {
    expect(geoFailureText('denied')).toMatch(/настройках браузера/);
    expect(geoFailureText('timeout')).toMatch(/попробуйте ещё раз/);
    expect(geoFailureText('unavailable')).toMatch(/не удалось/);
    expect(geoFailureText('unsupported')).toMatch(/не умеет/);
  });

  it('таймаут по умолчанию даёт холодному фиксу время', async () => {
    expect(GEO_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    let seen: PositionOptions | undefined;
    mockGeo((ok, _e, o) => { seen = o; ok({ coords: { latitude: 1, longitude: 2, accuracy: 1 } } as GeolocationPosition); });
    await requestPosition();
    expect(seen?.timeout).toBe(GEO_DEFAULT_TIMEOUT_MS);
    expect(seen?.enableHighAccuracy).toBe(true);
  });
});

describe('радар пользуется общей дверью и показывает поиск', () => {
  it('своего getCurrentPosition у радара больше нет', () => {
    expect(RADAR).toMatch(/requestPosition\(/);
    expect(RADAR).not.toMatch(/navigator\.geolocation\.getCurrentPosition/);
  });

  it('нажатие видно сразу: состояние «ищу» и заблокированная кнопка', () => {
    expect(RADAR).toMatch(/setGeo\('busy'\)/);
    expect(RADAR).toMatch(/Ищем спутники…/);
    expect(RADAR).toMatch(/disabled=\{geo === 'busy'\}/);
  });

  it('после отказа кнопка предлагает повтор, а не исчезает', () => {
    expect(RADAR).toMatch(/Попробовать снова/);
  });

  it('текст отказа — по причине, а не один на все случаи', () => {
    expect(RADAR).toMatch(/geoFailureText\(geoErr\)/);
    expect(RADAR).not.toMatch(/Геолокация недоступна — показываю/);
  });
});
