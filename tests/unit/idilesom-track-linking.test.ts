/**
 * Привязка GPS-треков idilesom к местам (пост-проход mode=link).
 *
 * Кейс «Тёплое озеро»: backfill матчил место только по bbox вокруг СТАРТА
 * трека (±~1 км), а тропа начинается за километры от озера — 240 из 277
 * треков легли без metadata.place_ark_id, и карточки мест их не видели.
 * matchTrackToPlace матчит по имени + близости места к ЛЮБОЙ точке трека.
 */

import { describe, it, expect } from 'vitest';
import { matchTrackToPlace, type PlaceRef } from '@/lib/services/idilesom-importer';

// Трек ~7 км: старт на трассе, финиш у озера (шаг ~0.009° ≈ 1 км)
function trackTowards(lat: number, lng: number, steps = 7): number[][] {
  const coords: number[][] = [];
  for (let i = steps; i >= 0; i--) {
    coords.push([lng - i * 0.012, lat - i * 0.009]);
  }
  return coords;
}

const TEPLOE: PlaceRef = { ark_id: 'ark-1', name: 'Тёплое озеро', lat: 52.5, lng: 158.2 };
const FAR_LAKE: PlaceRef = { ark_id: 'ark-2', name: 'Тёплое озеро', lat: 53.9, lng: 159.9 };
const OTHER: PlaceRef = { ark_id: 'ark-3', name: 'Вулкан Горелый', lat: 52.56, lng: 158.03 };

describe('matchTrackToPlace', () => {
  it('привязывает место у ФИНИША трека, хотя старт за километры (кейс Тёплого озера)', () => {
    const match = matchTrackToPlace(
      { title: 'Озеро Тёплое', coordinates: trackTowards(TEPLOE.lat, TEPLOE.lng) },
      [TEPLOE, OTHER],
    );
    expect(match?.place.ark_id).toBe('ark-1');
    expect(match!.minKm).toBeLessThan(1);
  });

  it('ё/е и порядок слов не мешают матчу имени', () => {
    const place: PlaceRef = { ...TEPLOE, name: 'Теплое озеро' };
    const match = matchTrackToPlace(
      { title: 'Озеро Тёплое', coordinates: trackTowards(place.lat, place.lng) },
      [place],
    );
    expect(match?.place.ark_id).toBe('ark-1');
  });

  it('одноимённое место в другом районе (дальше 5 км от всего трека) не привязывается', () => {
    const match = matchTrackToPlace(
      { title: 'Озеро Тёплое', coordinates: trackTowards(52.5, 158.2) },
      [FAR_LAKE],
    );
    expect(match).toBeNull();
  });

  it('без похожего имени близость не считается привязкой', () => {
    const match = matchTrackToPlace(
      { title: 'Озеро Тёплое', coordinates: trackTowards(OTHER.lat, OTHER.lng) },
      [OTHER],
    );
    expect(match).toBeNull();
  });

  it('из нескольких подходящих имён выбирает ближайшее к треку', () => {
    const near: PlaceRef = { ark_id: 'near', name: 'Тёплое озеро', lat: 52.5, lng: 158.2 };
    const alsoNamed: PlaceRef = { ark_id: 'far', name: 'Тёплое озеро', lat: 52.53, lng: 158.24 };
    const match = matchTrackToPlace(
      { title: 'Озеро Тёплое', coordinates: trackTowards(near.lat, near.lng) },
      [alsoNamed, near],
    );
    expect(match?.place.ark_id).toBe('near');
  });

  it('пустая геометрия — null без падения', () => {
    expect(matchTrackToPlace({ title: 'Озеро Тёплое', coordinates: [] }, [TEPLOE])).toBeNull();
  });
});
