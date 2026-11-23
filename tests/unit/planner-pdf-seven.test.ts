/**
 * Семь дефектов PDF владельца (24.11–04.12): правила, которые движок
 * вызывает. Закрытие и возраст — по записи, зона — по координате места,
 * пустой день — местом каталога, ссылка тура — только та, что открывается.
 */
import { describe, it, expect } from 'vitest';

import { ZONE_COORDS } from '@/lib/planner/engine';
import { AVACHA_ZONE_CENTER, placePoint } from '@/lib/planner/place-point';
import { assignCatalogFreeDays, publicPlacePath, type SelfPlace } from '@/lib/planner/self-fill';
import { NO_TOUR_DAY_TITLE } from '@/lib/planner/honest-days';
import { dateOutsideRecordedWindow, recordedMinAge, redParkFromCard, tourGate } from '@/lib/planner/tour-gates';
import { isSeasonalClosure } from '@/lib/safety/park-closure';
import { estimateGroup, type EstimateDay, type EstimateProfile } from '@/lib/planner/estimate';
import { resolvingTourPath } from '@/lib/tours/tour-url';
import type { DayPlan } from '@/lib/planner/engine';

const free = (day: number, zone: DayPlan['zone'] = 'avachinsky'): DayPlan => ({
  day, type: 'activity', zone, title: NO_TOUR_DAY_TITLE, description: '',
  activityType: 'helicopter', priceFrom: 0, priceTo: 0, coords: [53, 158],
  defaultTransport: 'walking', allowedTransports: ['walking'], difficulty: 'easy',
  childFriendly: true, minChildAge: 0, dayWarnings: [],
});

const museum: SelfPlace = { name: 'Краеведческий музей', href: '/places/kraevedchesky-muzey', type: 'museum', lat: 53.02, lng: 158.65 };

describe('ворота тура', () => {
  const base = {
    youngest: 5, activityMinAge: 3, activityName: 'Вертолёт',
    placeOpenFrom: null, placeOpenTo: null, offOrientation: true,
    parkClosed: false, ageText: '', date: '2026-11-24', kind: 'request' as const,
  };

  it('нет окна и нет закрытия — месяц открыт (08.10)', () => {
    expect(tourGate(base)).toBeNull();
  });

  it('закрытие парка и не сезон — прежняя причина', () => {
    expect(tourGate({ ...base, parkClosed: true })?.reason).toBe('park_and_off_season');
  });

  it('закрытие парка в сезон занятия — тур без календаря не ставится', () => {
    const g = tourGate({ ...base, parkClosed: true, offOrientation: false });
    expect(g?.reason).toBe('park');
    expect(g?.clause).toMatch(/закрытие парка/);
  });

  it('подтверждённый выезд закрытие парка не снимает', () => {
    expect(tourGate({ ...base, kind: 'dated', parkClosed: true })).toBeNull();
  });

  it('окно места вне даты — сказано по записанным датам', () => {
    const g = tourGate({ ...base, placeOpenFrom: '2026-06-01', placeOpenTo: '2026-09-30', parkClosed: false, offOrientation: false });
    expect(g?.reason).toBe('place');
    expect(g?.clause).toMatch(/01\.06\.2026/);
    expect(g?.clause).toMatch(/30\.09\.2026/);
  });

  it('окна нет — дата не закрыта', () => {
    expect(dateOutsideRecordedWindow('2026-11-24', null, null)).toBe(false);
    expect(dateOutsideRecordedWindow('2026-11-24', '2026-06-01', '2026-09-30')).toBe(true);
    expect(dateOutsideRecordedWindow('2026-07-01', '2026-06-01', '2026-09-30')).toBe(false);
  });

  it('«от 12 лет» в тексте тура закрывает ребёнка 5 лет и у тура с календарём', () => {
    expect(recordedMinAge('Программа от 12 лет, детям с 5 лет скидка')).toBe(12);
    expect(recordedMinAge('программа от 18 лет')).toBe(18);
    expect(recordedMinAge('без возраста')).toBeNull();
    const g = tourGate({ ...base, kind: 'dated', ageText: 'Облёт от 12 лет', parkClosed: false, offOrientation: false });
    expect(g?.reason).toBe('age');
    expect(g?.clause).toMatch(/от 12 лет/);
    expect(tourGate({ ...base, ageText: 'от 5 лет' })).toBeNull();
  });

  it('занятие с 14 лет не ставится ребёнку 5 лет', () => {
    const g = tourGate({ ...base, activityMinAge: 14, activityName: 'Снегоход', kind: 'dated' });
    expect(g?.reason).toBe('age');
    expect(g?.clause).toMatch(/с 14 лет/);
  });

  it('«от 18 лет» не пускает ребёнка 17 лет', () => {
    const g = tourGate({ ...base, youngest: 17, kind: 'dated', ageText: 'Программа от 18 лет', parkClosed: false, offOrientation: false });
    expect(g?.reason).toBe('age');
    expect(g?.clause).toMatch(/от 18 лет/);
    expect(g?.clause).toMatch(/17 лет/);
  });

  it('без даты поездки возраст всё равно режет, закрытие парка — нет', () => {
    expect(tourGate({ ...base, date: null, ageText: 'от 12 лет' })?.reason).toBe('age');
    expect(tourGate({ ...base, date: null, parkClosed: true })).toBeNull();
  });

  const klyu = 'Ключевской — маршруты закрыты на зимний сезон: Передвижение в районах вулканов крайне опасно';
  const seasonal = 'Маршруты природного парка «Налычево» закрыты на период межсезонья';

  it('красное закрытие парка не прячется за closed=false и пустым окном', () => {
    expect(isSeasonalClosure(klyu)).toBe(false);
    expect(isSeasonalClosure(seasonal)).toBe(true);
    expect(redParkFromCard({ level: 'red', closed: false, openFrom: null, openTo: null, summary: klyu })).toBe(true);
    expect(redParkFromCard({ level: 'red', closed: false, openFrom: null, openTo: null, summary: seasonal })).toBe(false);
    expect(redParkFromCard({ level: 'red', closed: false, openFrom: null, openTo: null, summary: '' })).toBe(false);
    expect(redParkFromCard({ level: 'yellow', closed: false, openFrom: null, openTo: null, summary: klyu })).toBe(false);
    const g = tourGate({
      ...base, parkClosed: false, offOrientation: false, placeLevel: 'red', placeClosed: false, parkSummary: klyu,
    });
    expect(g?.reason).toBe('park');
    expect(g?.clause).toMatch(/закрытие парка/);
  });

  it('возраст, парк и не сезон — в одной строке; межсезонье красным не становится', () => {
    const g = tourGate({
      ...base, ageText: 'от 12 лет', placeLevel: 'red', placeClosed: false, parkSummary: klyu,
    });
    expect(g?.reason).toBe('age');
    expect(g?.clause).toMatch(/от 12 лет/);
    expect(g?.clause).toMatch(/парк у места тура закрыт/);
    expect(g?.clause).toMatch(/не сезон/);
    const dated = tourGate({
      ...base, kind: 'dated', ageText: 'от 12 лет', placeLevel: 'red', placeClosed: false, parkSummary: klyu,
    });
    expect(dated?.clause).toMatch(/парк у места тура закрыт/);
    expect(dated?.clause).not.toMatch(/не сезон/);
    expect(tourGate({
      ...base, parkClosed: true, placeLevel: 'red', placeClosed: false, parkSummary: seasonal,
    })).toBeNull();
    expect(recordedMinAge('от 21 лет')).toBe(21);
  });
});

describe('зона по точке места', () => {
  it('центр Авачи совпадает с движком', () => {
    expect(AVACHA_ZONE_CENTER).toEqual(ZONE_COORDS.avachinsky);
  });

  it('Толбачик, записанный авачинским, — север и его координата', () => {
    const p = placePoint({ recordedZone: 'avachinsky', lat: 55.818, lng: 160.39 });
    expect(p?.zone).toBe('northern');
    expect(p?.point).toEqual([55.818, 160.39]);
    expect(p?.fromCoords).toBe(true);
  });

  it('записанный север не переписывается, Авачинский вулкан остаётся авачинским', () => {
    expect(placePoint({ recordedZone: 'northern', lat: 55.818, lng: 160.39 })?.zone).toBe('northern');
    expect(placePoint({ recordedZone: 'western', lat: 55.93, lng: 158.7 })?.zone).toBe('western');
    expect(placePoint({ recordedZone: 'avachinsky', lat: 53.26, lng: 158.83 })?.zone).toBe('avachinsky');
  });

  it('координат нет — зону не угадываем', () => {
    expect(placePoint({ recordedZone: null, lat: null, lng: null })).toBeNull();
    expect(placePoint({ recordedZone: 'avachinsky', lat: null, lng: null })?.zone).toBe('avachinsky');
    expect(placePoint({ recordedZone: 'avachinsky', lat: null, lng: null })?.fromCoords).toBe(false);
  });
});

describe('пустой день и ссылка', () => {
  it('день «на своё усмотрение» получает место каталога; чужая зона — нет', () => {
    const days = assignCatalogFreeDays([free(1), free(2, 'northern')], [museum], '');
    expect(days[0]!.title).toBe('Самостоятельно: Краеведческий музей');
    expect(days[0]!.placeHref).toBe('/places/kraevedchesky-muzey');
    expect(days[0]!.description).toMatch(/без гида/);
    expect(days[1]!.title).toBe(NO_TOUR_DAY_TITLE);
  });

  it('база не ответила — дни как были', () => {
    expect(assignCatalogFreeDays([free(1)], null, '')[0]!.title).toBe(NO_TOUR_DAY_TITLE);
  });

  it('место без slug ссылкой не становится', () => {
    expect(publicPlacePath('kraevedchesky-muzey')).toBe('/places/kraevedchesky-muzey');
    expect(publicPlacePath('98d0607d-8547-40a3-8b71-e981b59a31df')).toBeNull();
    expect(publicPlacePath(null)).toBeNull();
  });

  it('тур: slug и число открываются, UUID — нет', () => {
    expect(resolvingTourPath({ id: 51, slug: 'oblet-avachi' })).toBe('/catalog/tours/oblet-avachi');
    expect(resolvingTourPath({ id: '51', slug: null })).toBe('/catalog/tours/51');
    expect(resolvingTourPath({ id: 't-1', slug: null })).toBe('/catalog/tours/t-1');
    expect(resolvingTourPath({ id: '98d0607d-8547-40a3-8b71-e981b59a31df', slug: null })).toBeNull();
    expect(resolvingTourPath({ id: '98d0607d-8547-40a3-8b71-e981b59a31df', slug: '98d0607d-8547-40a3-8b71-e981b59a31df' })).toBeNull();
  });

  it('самостоятельный день музея не обещает цену исполнителя', () => {
    const profile: EstimateProfile = { adults: 2, children: [5, 11, 17], budgetTier: 'comfort', tripOrigin: 'visitor' };
    const museumDay: EstimateDay = {
      day: 1, type: 'activity', zone: 'avachinsky', title: 'Самостоятельно: Краеведческий музей',
      priceFrom: 0, priceTo: 0, activityMode: 'self',
    };
    const openDay: EstimateDay = {
      day: 2, type: 'activity', zone: 'avachinsky', title: 'Вулканы — Авачинская зона',
      priceFrom: 0, priceTo: 0, activityMode: 'open',
    };
    const leave: EstimateDay = { day: 3, type: 'departure', zone: 'avachinsky', title: 'Вылет', priceFrom: 0, priceTo: 0 };
    const est = estimateGroup([museumDay, openDay, leave], profile);
    const activity = est.lines.filter((l) => l.kind === 'activity');
    expect(activity.map((l) => l.label)).toEqual(['«Вулканы — Авачинская зона», день 2']);
    expect(activity[0]?.basis).toBe('тур не выбран — цену называет исполнитель');
  });
});
