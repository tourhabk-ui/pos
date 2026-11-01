import type { Metadata } from 'next';
import { TripRequestClient } from './_TripRequestClient';

// Поездка по личным ключам частей: ключи во фрагменте (#k1.k2), в поиск нельзя.
export const metadata: Metadata = {
  title: 'Поездка — заявки',
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tripId = /^TRIP-[A-F0-9]{6}$/.test(id) ? id : null;
  return <TripRequestClient tripId={tripId} />;
}
