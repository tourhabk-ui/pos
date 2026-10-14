import type { Metadata } from 'next';
import { Suspense } from 'react';
import MapPageClient from './_MapPageClient';
import { MAP_PACK_BASE_URL_ENV } from '@/lib/map/pack-source';
import { MapPlacesIndexSection } from '@/components/map/MapPlacesIndex';

export const dynamic = 'force-dynamic';

// Заголовок — частый запрос целиком («карта Камчатки с достопримечательностями»);
// описание — без цифр: число мест в статичном тексте устарело бы молча (§4.0).
export const metadata: Metadata = {
  alternates: { canonical: '/map' },
  title: 'Карта Камчатки с достопримечательностями',
  description: 'Интерактивная карта Камчатки: вулканы, термальные источники, гейзеры, озёра и бухты. Обстановка в крае и землетрясения — на той же карте.',
};

export default function MapPage() {
  // Адрес хранилища пакетов — с сервера, в момент запроса (см. шапку
  // lib/map/pack-source.ts: NEXT_PUBLIC_* в клиентский бандл не доходит,
  // сборка Timeweb идёт внутри Docker без переменных приложения).
  const mapPackBaseUrl = process.env[MAP_PACK_BASE_URL_ENV] || null;
  // Указатель мест — своей границей ожидания: запрос к базе не задерживает
  // разметку карты, она уходит сразу, как и раньше.
  return (
    <>
      <MapPageClient mapPackBaseUrl={mapPackBaseUrl} />
      <Suspense fallback={null}>
        <MapPlacesIndexSection />
      </Suspense>
    </>
  );
}
