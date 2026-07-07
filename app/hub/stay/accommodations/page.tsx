import type { Metadata } from 'next';
import AccommodationsClient from './_AccommodationsClient';

export const metadata: Metadata = {
  title: 'Мои объекты размещения | Tourhab',
  description: 'Управление объектами размещения',
  robots: 'noindex, nofollow',
};

export default function StayAccommodationsPage() {
  return <AccommodationsClient />;
}
