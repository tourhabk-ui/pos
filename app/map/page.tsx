import type { Metadata } from 'next';
import { Suspense } from 'react';
import MapPageClient from './_MapPageClient';
import { MAP_PACK_BASE_URL_ENV } from '@/lib/map/pack-source';
import { MapPlacesIndexSection } from '@/components/map/MapPlacesIndex';
import { mapTargetFromSearch } from '@/lib/map/map-target';
import { loadMapFocus } from '@/lib/map/map-focus';

export const dynamic = 'force-dynamic';

// Заголовок — частый запрос целиком («карта Камчатки с достопримечательностями»);
// описание — без цифр: число мест в статичном тексте устарело бы молча (§4.0).
export const metadata: Metadata = {
  alternates: { canonical: '/map' },
  title: 'Карта Камчатки с достопримечательностями',
  description: 'Интерактивная карта Камчатки: вулканы, термальные источники, гейзеры, озёра и бухты. Обстановка в крае и землетрясения — на той же карте.',
};

export default async function MapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Ссылка на место или на сводку обстановки (`?place=`, `?show=safety`,
  // payload мини-приложения MAX) — та же карта, без второй копии
  // (lib/map/map-target.ts). Место ищется в базе: по ссылке без записанной
  // координаты точка не ставится.
  const target = mapTargetFromSearch(await searchParams);
  const focus = target.kind === 'place' ? await loadMapFocus(target.ref) : null;
  // Адрес хранилища пакетов — с сервера, в момент запроса (см. шапку
  // lib/map/pack-source.ts: NEXT_PUBLIC_* в клиентский бандл не доходит,
  // сборка Timeweb идёт внутри Docker без переменных приложения).
  const mapPackBaseUrl = process.env[MAP_PACK_BASE_URL_ENV] || null;
  // Указатель мест — своей границей ожидания: запрос к базе не задерживает
  // разметку карты, она уходит сразу, как и раньше.
  return (
    <>
      <MapPageClient mapPackBaseUrl={mapPackBaseUrl} focus={focus} openSafety={target.kind === 'safety'} />
      <Suspense fallback={null}>
        <MapPlacesIndexSection />
      </Suspense>
    </>
  );
}
