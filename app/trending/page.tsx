import type { Metadata } from 'next';
import { TrendingClient } from './_TrendingClient';

export const metadata: Metadata = {
  alternates: { canonical: '/trending' },
  title: 'Популярные маршруты и места Камчатки',
  description: 'Самые популярные места и маршруты Камчатки прямо сейчас',
};

export default function TrendingPage() {
  return <TrendingClient />;
}
