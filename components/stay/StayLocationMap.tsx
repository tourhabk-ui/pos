'use client';

/**
 * Где находится объект жилья — точка на карте карточки (владелец 10.10:
 * «точка на карте есть?»). До этого координаты объекта лежали в базе, а
 * карточка их не показывала нигде: гость видел «пос. Пионерский» словами и
 * не понимал, где это относительно аэропорта и города.
 *
 * Карта своя (LeafletMap, как на карточке места): чужих навигаторов на
 * экранах платформы нет (tests/unit/no-external-navigators.test.ts).
 * Координаты, которых нет или которые явно не координаты (0,0, вне диапазона),
 * не рисуются: точка в Гвинейском заливе хуже, чем отсутствие карты.
 *
 * Сторож: tests/unit/stay-location-map.test.ts.
 */

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { MarkerType, type MapMarker } from '@/components/shared/leaflet-types';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

/** Координаты объекта из `accommodations.coordinates` ({lat, lng}); null — нет или не годятся. */
export function stayCoords(c: unknown): [number, number] | null {
  if (!c || typeof c !== 'object') return null;
  const { lat, lng } = c as { lat?: unknown; lng?: unknown };
  if (lat == null || lng == null) return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la === 0 && ln === 0) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return [la, ln];
}

export function StayLocationMap({ coords, name }: { coords: [number, number]; name: string }) {
  // useMemo обязателен: LeafletMap пересоздаёт карту при смене identity
  // center/markers (тот же приём, что в PlaceAccess).
  const [lat, lng] = coords;
  const center = useMemo<[number, number]>(() => [lat, lng], [lat, lng]);
  const markers = useMemo<MapMarker[]>(() => [{
    coords: [lat, lng],
    title: name,
    description: 'Жильё',
    color: 'red',
    type: MarkerType.TOUR,
    category: 'place',
  }], [lat, lng, name]);
  return (
    <div className="w-full rounded-lg overflow-hidden border border-[var(--border)]">
      <LeafletMap center={center} zoom={12} markers={markers} height="260px" className="w-full" />
    </div>
  );
}
