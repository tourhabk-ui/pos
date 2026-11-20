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
import {
  registryPassportAgentClause, registryPassportAgentLine, parseRegistryPassports,
} from '@/lib/routes/registry-passport';

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

/**
 * Паспорт реестра, к маршруту не привязанный (1478), — агенту (слово владельца
 * 20.11 «1 да»): там, где Кузьмич и MCP называют длину маршрута, они называют
 * и длину паспорта, и что маршрут в паспорте может быть другим.
 */
const P = 'https://visitkamchatka.ru/upload/route_passports/';
const PERE = [{ url: `${P}vilyuchinsky_pereval_avto.pdf`, km: 76, side: 'в обе стороны', label: null }];
const WATERFALL = [
  { url: `${P}vilyuchinsky_waterfall_summer.pdf`, km: 4, side: 'в обе стороны', label: 'летний' },
  { url: `${P}vilyuchinsky_waterfall_winter.pdf`, km: 4, side: 'в обе стороны', label: 'зимний' },
];
const MAY_DIFFER = 'маршрут в паспорте может отличаться от этого маршрута каталога';

describe('паспорт реестра — слова агенту', () => {
  it('один паспорт, два с одной длиной, разные длины', () => {
    expect(registryPassportAgentClause(parseRegistryPassports(PERE)))
      .toBe(`В официальном паспорте — 76 км в обе стороны; ${MAY_DIFFER}`);
    expect(registryPassportAgentClause(parseRegistryPassports(WATERFALL)))
      .toBe(`В обоих официальных паспортах — 4 км в обе стороны; ${MAY_DIFFER}`);
    expect(registryPassportAgentClause(parseRegistryPassports([WATERFALL[0], { ...WATERFALL[1], km: 6 }])))
      .toBe(`В официальных паспортах: летний — 4 км в обе стороны, зимний — 6 км в обе стороны; ${MAY_DIFFER}`);
  });

  it('строка фактов — со ссылками на PDF; неверная запись и пустота — без строки', () => {
    expect(registryPassportAgentLine(WATERFALL)).toBe(
      `В обоих официальных паспортах — 4 км в обе стороны; ${MAY_DIFFER} — `
      + `летний паспорт (PDF): ${P}vilyuchinsky_waterfall_summer.pdf, зимний паспорт (PDF): ${P}vilyuchinsky_waterfall_winter.pdf`,
    );
    expect(registryPassportAgentLine(PERE)).toContain(`паспорт (PDF): ${P}vilyuchinsky_pereval_avto.pdf`);
    for (const bad of [null, [], { url: PERE[0].url, km: 76 }, [{ ...PERE[0], url: 'https://evil.example/x.pdf' }]]) {
      expect(registryPassportAgentLine(bad)).toBeNull();
    }
  });

  it('факты маршрута Кузьмичу: длина маршрута своя, паспорт — отдельной строкой рядом с ней', () => {
    const facts = routeFacts({ ...FACTS, distance_km: '12.1', registry_passports: PERE });
    expect(facts[0]).toBe('дистанция 12.1 км');
    expect(facts[1]).toBe(registryPassportAgentLine(PERE));
    expect(routeFacts({ ...FACTS, distance_km: '12.1' }).join('\n')).not.toContain('паспорт');
  });

  it('строка маршрута места: оговорка в скобках сразу после длины', () => {
    const line = placeRoutesLines([{
      id: 'r1', slug: 'vilyuchinskij-pereval-marshrut', title: 'Вилючинский перевал', link_kind: 'waypoint',
      distance_km: '12.1', registry_passports: PERE,
    } as Parameters<typeof placeRoutesLines>[0][number]]).join('\n');
    expect(line).toContain(
      `«Вилючинский перевал», длина маршрута 12.1 км (в официальном паспорте — 76 км в обе стороны; ${MAY_DIFFER}) — `,
    );
    const bare = placeRoutesLines([{
      id: 'r1', slug: 'vilyuchinskij-pereval-marshrut', title: 'Вилючинский перевал', link_kind: 'waypoint', distance_km: '12.1',
    } as Parameters<typeof placeRoutesLines>[0][number]]).join('\n');
    expect(bare).not.toContain('паспорт');
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
