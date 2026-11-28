/**
 * Сниппет места без подписи зоны (28.11, владелец: «да растояние да»).
 * places.zone — адрес рассылки тревог, не район: «avachinsky» ловит всё южнее
 * 55,5°N, и Ксудач (153 км) читался «…на Камчатке, Авачинский». Вместо подписи —
 * «N км по прямой к <стороне> от Петропавловска» из координат карточки.
 */
import { describe, it, expect } from 'vitest';
import { placeDescription, placeWhere, type PlaceMetaFacts } from '@/lib/seo/place-meta';
import { composeAccessText } from '@/lib/places/access-text';
import { META_DESCRIPTION_MAX } from '@/lib/seo/meta-description';

const base: PlaceMetaFacts = {
  name: 'Вулкан Тест', typeLabel: 'вулкан', zone: 'avachinsky', bestSeason: null, altitudeM: null,
  hazardsRecorded: false, registrationRequired: false, isOpen: null, essence: null,
};

describe('placeWhere — расстояние и сторона света из координат', () => {
  it('дальнее место: километры по прямой и румб (Ксудач 51.8, 157.52 → юго-запад)', () => {
    expect(placeWhere(51.8, 157.52)).toMatch(/^, 1\d\d км по прямой к юго-западу от Петропавловска$/);
  });
  it('Кроноцкое озеро (54.814, 160.218) — к северо-востоку', () => {
    expect(placeWhere(54.814, 160.218)).toMatch(/ к северо-востоку от Петропавловска$/);
  });
  it('ближнее место (до 15 км) — число без стороны света; у самой точки отсчёта — ничего', () => {
    expect(placeWhere(52.95131, 158.71249)).toBe(', 8 км по прямой от Петропавловска');
    expect(placeWhere(53.01, 158.65)).toBe('');
  });
  it('нет координат или не числа — пустая строка, ничего не выдумано', () => {
    expect(placeWhere(null, null)).toBe('');
    expect(placeWhere(undefined, 158)).toBe('');
    expect(placeWhere(NaN, 158)).toBe('');
  });
  it('то же число и румб, что в «Как добраться»', () => {
    const lat = 51.8, lng = 157.52;
    const access = composeAccessText({
      name: 'X', lat, lng, zone: null, district: null, accessInfo: null, routes: [],
      registrationRequired: false, eco: null, toursCount: 0,
    } as never)[0];
    const [, km, dir] = /в (\d+) км по прямой к (\S+) от/.exec(access)!;
    expect(placeWhere(lat, lng)).toBe(`, ${km} км по прямой к ${dir} от Петропавловска`);
  });
});

describe('placeDescription — зона не печатается', () => {
  it('с координатами: «…вулкан на Камчатке, N км по прямой к … от Петропавловска.»', () => {
    const d = placeDescription({ ...base, lat: 51.8, lng: 157.52 });
    expect(d).toMatch(/^Вулкан Тест — вулкан на Камчатке, \d+ км по прямой к юго-западу от Петропавловска\./);
    expect(d).not.toMatch(/Авачинск|avachinsky/);
    expect(d.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });
  it('без координат: просто без подписи', () => {
    expect(placeDescription({ ...base })).toBe('Вулкан Тест — вулкан на Камчатке.');
    expect(placeDescription({ ...base, typeLabel: 'место' })).toBe('Вулкан Тест — место на Камчатке.');
  });
  it('любая зона, в том числе человеческая подпись, в сниппет не попадает', () => {
    for (const zone of ['avachinsky', 'kronotsky', 'Кроноцкий заповедник', null]) {
      const d = placeDescription({ ...base, zone, lat: 54.8, lng: 160.2 });
      expect(d).not.toMatch(/Авачинск|Кроноцкий заповедник|kronotsky|avachinsky/);
    }
  });
  it('высота, сезон, МЧС идут после расстояния, без цен', () => {
    const d = placeDescription({ ...base, lat: 51.8, lng: 157.52, altitudeM: 1079, bestSeason: 'июль – сентябрь', registrationRequired: true });
    expect(d).toMatch(/от Петропавловска\. Высота 1079 м\. Сезон: июль – сентябрь\. Нужна регистрация в МЧС\./);
    expect(d).not.toMatch(/₽|руб/);
  });
});
