/**
 * Сниппет маршрута начинается с названия (SEO-аудит 20.11.2026): у 188
 * страниц description был шаблоном «Маршрут на Камчатке: N км · …».
 */
import { describe, it, expect } from 'vitest';
import { routeDescription, routeDescriptionHead, type RouteMetaFacts } from '@/lib/seo/place-meta';
import { META_DESCRIPTION_MAX } from '@/lib/seo/meta-description';

const base: RouteMetaFacts = {
  title: 'Каньон сноубордистов', zone: 'western', distanceKm: 9, durationHours: null, durationDays: null,
  elevationGainM: 1100, difficulty: 'medium', season: 'winter', mchsRequired: true, description: null,
};

describe('голова сниппета', () => {
  it('название, район, факты', () => {
    expect(routeDescriptionHead('Озеро Зелёное', 'Авачинский', '4,9 км')).toBe('Озеро Зелёное — маршрут, Авачинский: 4,9 км.');
    expect(routeDescriptionHead('Озеро Зелёное', null, '4,9 км')).toBe('Озеро Зелёное — маршрут на Камчатке: 4,9 км.');
    expect(routeDescriptionHead('Маршрут на вулкан Дыгерен', 'Западная Камчатка', '22,8 км'))
      .toBe('Маршрут на вулкан Дыгерен (Западная Камчатка): 22,8 км.');
    expect(routeDescriptionHead('', null, '')).toBe('Маршрут на Камчатке.');
  });
});

describe('routeDescription', () => {
  it('без описания: не шаблон — начинается с названия, факты из полей', () => {
    const d = routeDescription(base);
    expect(d).toBe('Каньон сноубордистов — маршрут, Западная Камчатка: 9 км · набор 1100 м · сложность средняя · сезон зима. Регистрация в МЧС обязательна.');
    expect(d.startsWith('Маршрут на Камчатке')).toBe(false);
  });

  it('описание не влезает при полных фактах — факты короче, начало описания попадает', () => {
    const d = routeDescription({
      ...base,
      title: 'Озеро Галямаки',
      durationHours: 9,
      description: 'Озеро Галямаки представляет собой типичный для Камчатки треккинговый маршрут, ведущий к озеру.',
    });
    expect(d.startsWith('Озеро Галямаки — маршрут, Западная Камчатка: 9 км · сложность средняя. Регистрация в МЧС обязательна.')).toBe(true);
    expect(d).toContain('Озеро Галямаки представляет собой');
    expect(d.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });

  it('ничего не выдумывает: нет полей — нет фактов', () => {
    const d = routeDescription({ ...base, zone: null, distanceKm: null, elevationGainM: null, difficulty: null, season: null, mchsRequired: false });
    expect(d).toBe('Каньон сноубордистов — маршрут на Камчатке.');
  });
});
