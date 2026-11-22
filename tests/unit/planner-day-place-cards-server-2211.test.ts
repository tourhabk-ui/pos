import { describe, it, expect, vi } from 'vitest';
import {
  absoluteCard, assignDayCards, buildDayPlaceCards, placeIdsForDays, type DayPlaceCardDeps,
} from '@/lib/planner/day-place-cards';

const places = [
  { id: 'p-vil', title: 'Вулкан Вилючинский', lat: 52.7, lng: 158.28 },
  { id: 'p-par', title: 'Паратунская зона отдыха', lat: 52.95, lng: 158.25 },
];
const detail = (id: string, name: string) => ({
  id, name, description: `${name} — место на Камчатке. Второе предложение.`,
  images: [`/api/images/route/${id}`], photoCredits: { [`/api/images/route/${id}`]: 'Автор' },
});
const days = [
  { day: 1, title: 'Прилёт' },
  { day: 2, title: 'Восхождение', realTour: { tourId: 11 } },
  { day: 3, title: 'Термы', realTour: { tourId: 12 } },
  { day: 4, title: 'Термы ещё', realTour: { tourId: 12 } },
  { day: 5, title: 'Маршрут с карты', description: 'Тропа к водопаду', routeId: 'r-1' },
];
const locs = { '11': 'Вилючинский вулкан', '12': 'Паратунка, Паратунская зона отдыха' };

function deps(over: Partial<DayPlaceCardDeps> = {}): DayPlaceCardDeps {
  return {
    loadCatalogPlaces: async () => places,
    loadTourLocations: async () => locs,
    loadPlaceDetail: async id => (id === 'p-vil' ? detail(id, 'Вулкан Вилючинский') : detail(id, 'Паратунская зона отдыха')),
    ...over,
  };
}

describe('карточки дней на сервере (боты MAX/TG)', () => {
  it('placeIdsForDays: место тура по locationName, день маршрута пропущен', () => {
    expect(placeIdsForDays(days, locs, places)).toEqual({ 2: 'p-vil', 3: 'p-par', 4: 'p-par' });
    expect(placeIdsForDays(days, locs, [])).toEqual({});
  });

  it('assignDayCards: повтор места подряд — только у первого дня; маршрут — карточка маршрута', () => {
    const card = { kind: 'place' as const, id: 'p-par', title: 'П', text: '', href: '/places/p-par', photo: null };
    const out = assignDayCards(days, { 3: 'p-par', 4: 'p-par' }, { 'p-par': card });
    expect(Object.keys(out)).toEqual(['3', '5']);
    expect(out[5]).toMatchObject({ kind: 'route', id: 'r-1', href: '/routes/r-1' });
  });

  it('buildDayPlaceCards: фото с автором, описание, ссылка', async () => {
    const out = await buildDayPlaceCards(days, deps());
    expect(Object.keys(out).sort()).toEqual(['2', '3', '5']);
    expect(out[2]).toMatchObject({ kind: 'place', id: 'p-vil', href: '/places/p-vil', photo: { author: 'Автор' } });
    expect(out[2].photo?.src).toContain('size=card');
  });

  it('сбой источника — без карточек места, без исключения; onFailure вызван', async () => {
    const onFailure = vi.fn();
    const out = await buildDayPlaceCards(days, deps({ loadTourLocations: async () => { throw new Error('db'); }, onFailure }));
    expect(Object.keys(out)).toEqual(['5']);
    expect(onFailure).toHaveBeenCalledWith('tour-locations', expect.any(Error));
    const out2 = await buildDayPlaceCards(days, deps({ loadPlaceDetail: async () => { throw new Error('x'); }, onFailure }));
    expect(Object.keys(out2)).toEqual(['5']);
  });

  it('план без туров — данные мест не читаются', async () => {
    const loadCatalogPlaces = vi.fn(async () => places);
    await buildDayPlaceCards([{ day: 1, title: 'Город' }], deps({ loadCatalogPlaces }));
    expect(loadCatalogPlaces).not.toHaveBeenCalled();
  });

  it('absoluteCard: полные адреса для сообщения', () => {
    const c = absoluteCard({ kind: 'place', id: 'a', title: 'A', text: '', href: '/places/a', photo: { src: '/api/images/route/a?size=card', author: 'X' } });
    expect(c.href).toBe('https://vedarai.ru/places/a');
    expect(c.photo?.src).toBe('https://vedarai.ru/api/images/route/a?size=card');
  });
});
