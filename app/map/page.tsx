import type { Metadata } from 'next';
import MapPageClient from './_MapPageClient';
import { MAP_PACK_BASE_URL_ENV } from '@/lib/map/pack-source';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Карта Камчатки — Ведар',
  description: 'Интерактивная карта Камчатки с достопримечательностями, вулканами, термальными источниками',
};

export default function MapPage() {
  // Адрес хранилища пакетов — с сервера, в момент запроса (см. шапку
  // lib/map/pack-source.ts: NEXT_PUBLIC_* в клиентский бандл не доходит,
  // сборка Timeweb идёт внутри Docker без переменных приложения).
  const mapPackBaseUrl = process.env[MAP_PACK_BASE_URL_ENV] || null;
  return <MapPageClient mapPackBaseUrl={mapPackBaseUrl} />;
}
