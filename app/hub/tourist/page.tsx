import type { Metadata } from 'next';
import TouristDashboardClient from './_TouristDashboardClient';

export const metadata: Metadata = {
  title: 'Личный кабинет туриста',
  description: 'Заявки на туры и поездки туриста',
  robots: 'noindex, nofollow',
};

export default function TouristDashboard() {
  return <TouristDashboardClient />;
}
