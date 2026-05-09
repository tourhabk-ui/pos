import type { Metadata } from 'next';
import TripPlanClient from './_TripPlanClient';

export const metadata: Metadata = {
  title: 'Составить маршрут — Камчатка в кармане',
  description: 'AI составит день-за-днём план похода по маршрутам Камчатки. Сохраните план офлайн и идите без интернета.',
  alternates: { canonical: 'https://tourhab.ru/trips/plan' },
};

export default function TripPlanPage() {
  return <TripPlanClient />;
}
