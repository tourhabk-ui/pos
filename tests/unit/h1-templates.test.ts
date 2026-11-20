import { describe, it, expect } from 'vitest';
import {
  routeHeading, routeTitleFactsTail, tourHeadingTail, tourTitleTails, chronicleHeading,
  parkHeading, placeHeading, collectionHeading, PLACE_CANONICAL_PARENT, PLACE_NOINDEX, placeInSitemap,
} from '@/lib/seo/h1-templates';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';

// Спецификация Сыщика 21.11: дубли H1 закрываются шаблонами из полей записи.
const route = { distanceKm: null, elevationGainM: null, durationHours: null, durationDays: null, difficulty: null };

describe('T2: H1 маршрута', () => {
  it('обычное имя — «Маршрут «имя», км»; км нет — без хвоста', () => {
    expect(routeHeading({ ...route, title: 'Озеро Зелёное', distanceKm: 19.6 })).toBe('Маршрут «Озеро Зелёное», 19,6 км');
    expect(routeHeading({ ...route, title: 'Озеро Зелёное' })).toBe('Маршрут «Озеро Зелёное»');
  });
  it('имя про путь — факты через запятую, только записанные', () => {
    expect(routeHeading({ ...route, title: 'Восхождение на Авачинский вулкан', distanceKm: 14, elevationGainM: 1859, durationHours: 12.5, difficulty: 'medium' }))
      .toBe('Восхождение на Авачинский вулкан: 14 км, набор 1859 м, 12,5 ч, сложность средняя');
    expect(routeHeading({ ...route, title: 'Сплав по реке' })).toBe('Сплав по реке');
  });
  it('хвост title с фактами — или null', () => {
    expect(routeTitleFactsTail({ ...route, distanceKm: 14 })).toBe(': маршрут 14 км');
    expect(routeTitleFactsTail(route)).toBeNull();
  });
});

describe('T3: тур', () => {
  it('оператор в хвосте H1; нет оператора — нет хвоста', () => {
    expect(tourHeadingTail('Запорожец')).toBe('тур «Запорожец»');
    expect(tourHeadingTail('  ')).toBeNull();
  });
  it('хвосты title — только заполненные поля', () => {
    const t = tourTitleTails({ duration: '8 ч', basePrice: '12000', operatorName: 'Оператор' });
    expect(t[0]).toBe(': тур 8 ч, от 12 000 ₽, Оператор');
    expect(tourTitleTails({ duration: null, basePrice: null, operatorName: 'Оператор' })).toEqual([': тур Оператор']);
    expect(tourTitleTails({ duration: null, basePrice: '0', operatorName: null })).toEqual([]);
  });
});

describe('T4: летопись, парк, место ООПТ', () => {
  it('летопись со страницей парка — «история и летопись», событие — без хвоста', () => {
    const kr = CHRONICLE_ARTICLES.find((a) => a.slug === 'kronotskij-zapovednik')!;
    expect(chronicleHeading(kr.title, kr.parkSlugs)).toBe('Кроноцкий заповедник: история и летопись');
    const ev = CHRONICLE_ARTICLES.find((a) => a.slug === 'vzyatie-shumshu-1945')!;
    expect(chronicleHeading(ev.title, ev.parkSlugs)).toBe(ev.title);
  });
  it('парк и место', () => {
    expect(parkHeading('Кроноцкий заповедник', true)).toBe('Кроноцкий заповедник: маршруты, карты и разрешения');
    expect(parkHeading('Парк', false)).toBe('Парк');
    expect(placeHeading('Кроноцкий заповедник', true)).toBe('Кроноцкий заповедник: как добраться и посетить');
    expect(placeHeading('Озеро', false)).toBe('Озеро');
  });
});

describe('T5: подборка', () => {
  it('по составу', () => {
    expect(collectionHeading('Озёра Камчатки', { places: 5, routes: 0 })).toBe('Озёра Камчатки — подборка мест');
    expect(collectionHeading('Вулканы', { places: 2, routes: 1 })).toBe('Вулканы — подборка мест и маршрутов');
    expect(collectionHeading('Пусто', { places: 0, routes: 0 })).toBe('Пусто');
  });
});

describe('смотровые: каноникал и noindex', () => {
  it('три каноникала на родителя, два noindex, все вне sitemap', () => {
    expect(Object.keys(PLACE_CANONICAL_PARENT)).toHaveLength(3);
    expect(PLACE_NOINDEX.size).toBe(2);
    for (const s of [...Object.keys(PLACE_CANONICAL_PARENT), ...PLACE_NOINDEX]) expect(placeInSitemap(s)).toBe(false);
    expect(placeInSitemap('ganalskie-vostryaki')).toBe(true);
    expect(placeInSitemap(null)).toBe(true);
  });
});
