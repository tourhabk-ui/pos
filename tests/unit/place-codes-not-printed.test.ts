/**
 * Латинский код из данных не печатается на карточке места (04.10).
 *
 * Скрин владельца, «Этническое стойбище Кайныран»: «Как добраться»
 * кончалось «…от Петропавловска-Камчатского, avachinsky.», а маршрут в
 * списке стоял со сложностью «easy». Подписи были — в соседнем блоке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeAccessText, type AccessFacts } from '@/lib/places/access-text';
import { placeZoneLabel, routeDifficultyLabel } from '@/lib/places/zone-labels';
import { placeDescription, routeDescription } from '@/lib/seo/place-meta';

const base: AccessFacts = {
  name: 'Этническое стойбище Кайныран',
  lat: 53.3, lng: 158.3,
  district: null, zone: 'avachinsky',
  accessInfo: null, routes: [], registrationRequired: false, eco: null, toursCount: 0,
};

describe('зона в «Как добраться» — словами или никак', () => {
  it('известный код подписан', () => {
    const first = composeAccessText(base)[0];
    expect(first).toContain('район: Авачинский');
    expect(first).not.toContain('avachinsky');
  });

  it('неизвестный код молчит', () => {
    const first = composeAccessText({ ...base, zone: 'zzz_unknown' })[0];
    expect(first).not.toContain('zzz_unknown');
    expect(first).toMatch(/Петропавловска-Камчатского\.$/);
  });

  it('записанный район важнее кода зоны', () => {
    const first = composeAccessText({ ...base, district: 'Елизовский район' })[0];
    expect(first).toContain('Елизовский район');
    expect(first).not.toContain('Авачинский');
  });
});

describe('сложность маршрута места — по-русски', () => {
  it('словарь отвечает и молчит на незнакомое', () => {
    expect(routeDifficultyLabel('easy')).toBe('лёгкий');
    expect(routeDifficultyLabel('nope')).toBeNull();
    expect(placeZoneLabel(null)).toBeNull();
  });

  it('PlaceRoutes печатает подпись, а не код', () => {
    const src = readFileSync(join(process.cwd(), 'components/places/PlaceRoutes.tsx'), 'utf8');
    expect(src).toContain('{routeDifficultyLabel(r.difficulty)}');
    expect(src).not.toMatch(/>\s*\{r\.difficulty\}\s*</);
  });
});

describe('сниппет для поиска — тоже словами', () => {
  it('описание места и маршрута не несут латинского кода зоны', () => {
    const d = placeDescription({
      name: 'Этническое стойбище Кайныран', typeLabel: 'историческое место', zone: 'avachinsky',
      bestSeason: null, altitudeM: null, hazardsRecorded: false, registrationRequired: false,
      isOpen: null, essence: null,
    });
    expect(d).toContain('на Камчатке, Авачинский.');
    expect(d).not.toContain('avachinsky');
    const r = routeDescription({
      title: 'X', zone: 'zzz_code', distanceKm: 5, durationHours: null, durationDays: null,
      elevationGainM: null, difficulty: 'easy', season: null, mchsRequired: false, description: null,
    });
    expect(r).not.toContain('zzz_code');
  });
});
