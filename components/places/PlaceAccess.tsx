'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Download, Navigation, MapPin, FileDown } from 'lucide-react';
import { MarkerType, type MapMarker } from '@/components/shared/leaflet-types';
import { OWN_ROUTE_EVENT, OWN_ROUTE_ANCHOR } from '@/components/places/PlaceOwnRoute';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

interface Props {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  accessInfo: string | null;
  nearbyMarkers: { id: string; name: string; lat: number; lng: number; locationType: string | null }[];
}

export default function PlaceAccess({ placeId, name, lat, lng, accessInfo, nearbyMarkers }: Props) {
  // Кнопки «Organic Maps» и «Яндекс.Карты» сняты 13.09 (владелец: «кнопка
  // навигация до сих пор открывает сторонние сервисы»). Дорогу считает свой
  // граф — блок PlaceOwnRoute под шапкой этой же карточки; здесь остаются
  // только файлы, которые человек уносит с собой и которые ни от какого
  // чужого приложения не зависят.
  const gpxUrl = `/api/places/${placeId}/gpx`;

  // useMemo обязателен: LeafletMap пересоздаёт карту при смене identity
  // center/markers — инлайн-массивы сбрасывали её при ре-рендере родителя
  const mapCenter = useMemo<[number, number]>(() => [lat, lng], [lat, lng]);
  const mapMarkers = useMemo<MapMarker[]>(() => [
    {
      coords: [lat, lng],
      title: name,
      description: 'Текущее место',
      color: 'red',
      type: MarkerType.TOUR,
      category: 'place',
    },
    ...nearbyMarkers.map(n => ({
      coords: [n.lat, n.lng] as [number, number],
      title: n.name,
      description: n.locationType ?? '',
      color: 'blue' as const,
      type: MarkerType.TOUR,
      category: n.locationType ?? 'other',
    })),
  ], [lat, lng, name, nearbyMarkers]);

  return (
    <section className="max-w-3xl mx-auto px-4 space-y-4">
      <h2 className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2" style={{ fontFamily: 'var(--font-playfair)' }}>
        <MapPin className="w-5 h-5 text-[var(--accent)]" /> Как добраться
      </h2>

      {accessInfo && (
        <p className="text-[var(--text-secondary)] leading-relaxed" style={{ fontSize: '17px', lineHeight: '1.7', maxWidth: '68ch' }}>
          {accessInfo}
        </p>
      )}

      {/* Map */}
      <div className="w-full rounded-lg overflow-hidden border border-[var(--border)]">
        <LeafletMap
          center={mapCenter}
          zoom={11}
          markers={mapMarkers}
          height="300px"
          className="w-full"
        />
      </div>

      {/* Файлы места — унести с собой. Чужих навигаторов здесь больше нет. */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <a
          href={gpxUrl}
          download
          className="flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[var(--accent)] text-xs font-semibold hover:bg-[var(--accent)]/20 transition-colors text-center"
        >
          <Download className="w-4 h-4" />
          Скачать GPX
        </a>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new Event(OWN_ROUTE_EVENT));
            document.getElementById(OWN_ROUTE_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-lg bg-[var(--ocean)]/10 border border-[var(--ocean)]/30 text-[var(--ocean)] text-xs font-semibold hover:bg-[var(--ocean)]/20 transition-colors text-center"
        >
          <Navigation className="w-4 h-4" />
          Построить путь
        </button>
      </div>

      {/* Offline PDF */}
      <a
        href={`/api/places/${placeId}/pdf`}
        download
        className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-xs font-semibold transition-colors"
        style={{
          background: 'var(--bg-hover)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
        }}
      >
        <FileDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
        Скачать карточку для офлайн (PDF)
      </a>
    </section>
  );
}
