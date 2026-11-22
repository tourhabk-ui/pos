import { describe, it, expect } from 'vitest';
import {
  routeHeading, routeTitleFactsTail, tourHeadingTail, tourTitleTails, chronicleHeading,
  parkHeading, placeHeading, collectionHeading, PLACE_CANONICAL_PARENT, PLACE_NOINDEX, placeInSitemap,
} from '@/lib/seo/h1-templates';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';
import { priceWithUnitWords } from '@/lib/tours/price-label';

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
    const t = tourTitleTails({ duration: '8 ч', basePrice: '12000', priceUnit: 'per_person', operatorName: 'Оператор' });
    expect(t[0]).toBe(`: тур 8 ч, ${priceWithUnitWords('12000', 'per_person')}, Оператор`);
    expect(tourTitleTails({ duration: null, basePrice: null, priceUnit: 'per_person', operatorName: 'Оператор' })).toEqual([': тур Оператор']);
    expect(tourTitleTails({ duration: null, basePrice: '0', priceUnit: 'per_person', operatorName: null })).toEqual([]);
  });

  // Сверка 21.11 (#3487): «Первый рассвет» — «от 11 000 ₽» в title при одной
  // цене «11 000 ₽ за человека» на карточке. У тура одна цена: «от» в
  // заголовке — слово шаблона, а не оператора.
  it('цена в title — та же строка, что на карточке: без «от», с единицей', () => {
    const tails = tourTitleTails({ duration: '5 ч', basePrice: '11000', priceUnit: 'per_person', operatorName: 'Лагуна Экспедиция' });
    expect(tails.every((x) => !/(^|[\s,])от\s/.test(x))).toBe(true);
    expect(tails).toContain(`: тур 5 ч, ${priceWithUnitWords('11000', 'per_person')}, Лагуна Экспедиция`);
    expect(tourTitleTails({ duration: null, basePrice: '48000', priceUnit: 'per_tour', operatorName: null }))
      .toEqual([`: тур ${priceWithUnitWords('48000', 'per_tour')}`]);
    expect(priceWithUnitWords('48000', 'per_tour')).toMatch(/^48\s000 ₽ за группу$/);
  });

  it('единица не записана — цены в title нет (голая сумма читалась бы как с человека)', () => {
    const tails = tourTitleTails({ duration: '5 ч', basePrice: '11000', priceUnit: null, operatorName: 'Оператор' });
    expect(tails.some((x) => x.includes('₽'))).toBe(false);
    expect(tails[0]).toBe(': тур 5 ч, Оператор');
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
