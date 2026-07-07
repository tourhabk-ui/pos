import type { Metadata } from 'next';
import TransfersClient from './_TransfersClient';

export const metadata: Metadata = {
  title: 'Трансферы по Камчатке — поиск и бронирование | TourHab',
  description:
    'Трансферы из аэропорта Елизово, между Петропавловском-Камчатским и точками маршрутов. Поиск по датам и бронирование онлайн.',
  alternates: { canonical: '/transfers' },
};

export default function TransfersPage() {
  return <TransfersClient />;
}
