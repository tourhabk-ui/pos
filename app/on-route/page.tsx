import type { Metadata } from 'next';
import OnRouteClient from './_OnRouteClient';

export const metadata: Metadata = {
  title: 'На маршруте — Vedar',
  description: 'Режим навигации на маршруте: компас, GPS, высота, расстояние до точки.',
  robots: 'noindex',
};

export default function OnRoutePage() {
  return <OnRouteClient />;
}
