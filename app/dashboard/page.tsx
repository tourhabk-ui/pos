import type { Metadata } from 'next';
import DashboardClient from './_DashboardClient';

export const metadata: Metadata = {
  title: 'Командный центр — Vedar',
  description: 'Панель экспедиции: маршрут дня, статус вулканов, предупреждения Кузьмича.',
  robots: 'noindex',
};

export default function DashboardPage() {
  return <DashboardClient />;
}
