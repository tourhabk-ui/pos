import type { Metadata } from 'next';
import TripViewClient from './_TripViewClient';

export const metadata: Metadata = {
  title: 'Мой маршрут — Камчатка в кармане',
  description: 'Офлайн-план похода по маршруту Камчатки. Работает без интернета.',
};

export default async function TripViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TripViewClient planId={id} />;
}
