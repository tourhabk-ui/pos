/**
 * Длина маршрута словами и ссылка на паспорт (#3568, партия 1, разбор пары
 * Claude и Фло 20.11). Паспорт называет длину вместе со стороной: «60 км (в одну
 * сторону)». Пометка (`distance_note`, 1472) раньше доходила только до полосы
 * фактов карточки и сниппета; Кузьмич, MCP и строка маршрутов места говорили
 * голое «60 км». Сторож судит вызовом: что получает тот, кто читает.
 */
import { describe, it, expect } from 'vitest';
import { routeDistanceWords, registryPassportPdf } from '@/lib/routes/distance-words';
import { routeFacts } from '@/lib/ai/route-knowledge';
import { placeRoutesLines } from '@/lib/places/place-routes';

const FACTS = {
  difficulty: null, distance_km: '60', elevation_gain_m: null, duration_hours: null, season: null,
  hazards: null, equipment: null, mchs_registration_required: null, mchs_phone: null, park_name: null,
};

describe('routeDistanceWords', () => {
  it('число с пометкой паспорта и без неё; нет длины — null', () => {
    expect(routeDistanceWords('60', 'в одну сторону')).toBe('60 км в одну сторону');
    expect(routeDistanceWords(7.3, ' в обе стороны ')).toBe('7.3 км в обе стороны');
    expect(routeDistanceWords('4.3', null)).toBe('4.3 км');
    expect(routeDistanceWords(null, 'в одну сторону')).toBeNull();
    expect(routeDistanceWords('0', null)).toBeNull();
    expect(routeDistanceWords('', null)).toBeNull();
  });
});

describe('пометка стороны доходит до Кузьмича и строки маршрутов места', () => {
  it('факты маршрута Кузьмичу: «дистанция 60 км в одну сторону»', () => {
    expect(routeFacts({ ...FACTS, distance_note: 'в одну сторону' }).join('\n')).toContain('дистанция 60 км в одну сторону');
    expect(routeFacts(FACTS).join('\n')).toContain('дистанция 60 км');
    expect(routeFacts(FACTS).join('\n')).not.toContain('сторону');
  });

  it('строка маршрута места: «длина маршрута 7.3 км в обе стороны»', () => {
    const line = placeRoutesLines([{
      id: 'r1', slug: 'ozero-sinichkino-marshrut', title: 'Озеро Синичкино', link_kind: 'waypoint',
      distance_km: '7.3', distance_note: 'в обе стороны',
    } as Parameters<typeof placeRoutesLines>[0][number]]).join('\n');
    expect(line).toContain('«Озеро Синичкино», длина маршрута 7.3 км в обе стороны');
  });
});

describe('registryPassportPdf — PDF реестра паспортов и только он', () => {
  it('паспорт реестра принимается, любой регистр расширения', () => {
    expect(registryPassportPdf('https://visitkamchatka.ru/upload/route_passports/malkin_all_seasones.PDF'))
      .toBe('https://visitkamchatka.ru/upload/route_passports/malkin_all_seasones.PDF');
  });

  it('другой хост, http, другой каталог, не PDF, мусор — не паспорт', () => {
    for (const u of [
      'https://visitkamchatka.ru.example.com/upload/route_passports/a.pdf',
      'http://visitkamchatka.ru/upload/route_passports/a.pdf',
      'https://visitkamchatka.ru/upload/other/a.pdf',
      'https://visitkamchatka.ru/upload/route_passports/a.doc',
      'https://extraguide.ru/route/1',
      'не ссылка',
      null,
    ]) expect(registryPassportPdf(u)).toBeNull();
  });
});
