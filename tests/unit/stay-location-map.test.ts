/**
 * Сторож: точка объекта жилья на карте карточки (владелец 10.10: «точка на
 * карте есть?»). Координаты лежали в базе и нигде не показывались.
 *
 * Держит: годные координаты → карта, негодные (нет, 0,0, вне диапазона,
 * не числа) → блока нет; карта своя (LeafletMap), без чужих навигаторов;
 * координаты доходят до карточки из той же выборки, что остальное.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stayCoords } from '@/components/stay/StayLocationMap';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('координаты объекта', () => {
  it('«Кутха» из 2ГИС — точка', () => {
    expect(stayCoords({ lat: 53.094924, lng: 158.5432 })).toEqual([53.094924, 158.5432]);
    expect(stayCoords({ lat: '53.09', lng: '158.54' })).toEqual([53.09, 158.54]);
  });

  it('нет, ноль, вне диапазона, не числа — карты нет', () => {
    expect(stayCoords(null)).toBeNull();
    expect(stayCoords({})).toBeNull();
    expect(stayCoords({ lat: 53.09 })).toBeNull();
    expect(stayCoords({ lat: 0, lng: 0 })).toBeNull();
    expect(stayCoords({ lat: 158.54, lng: 253.09 })).toBeNull();
    expect(stayCoords({ lat: 'x', lng: 'y' })).toBeNull();
    expect(stayCoords('53.09,158.54')).toBeNull();
  });
});

describe('карточка жилья', () => {
  const card = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');
  const map = read('components/stay/StayLocationMap.tsx');

  it('блок «Где находится» рисуется только с годными координатами', () => {
    expect(card).toMatch(/const coords = stayCoords\(data\.coordinates\);/);
    expect(card).toMatch(/coords \? \([\s\S]{0,200}Где находится[\s\S]{0,300}<StayLocationMap coords=\{coords\} name=\{data\.name\} \/>/);
  });

  it('карта своя, без чужих навигаторов', () => {
    expect(map).toMatch(/import\('@\/components\/shared\/LeafletMap'\)/);
    expect(map).not.toMatch(/geo:|om:\/\/|yandex\.ru\/maps|2gis\.ru/);
  });

  it('координаты приходят из выборки карточки', () => {
    expect(read('lib/stay/accommodation-detail.ts')).toMatch(/coordinates: accommodation\.coordinates,/);
  });
});
