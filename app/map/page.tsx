import type { Metadata } from 'next';
import MapPageClient from './_MapPageClient';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Карта Камчатки — Ведар',
  description: 'Интерактивная карта Камчатки с достопримечательностями, вулканами, термальными источниками',
};

export default function MapPage() {
  return <MapPageClient />;
}
