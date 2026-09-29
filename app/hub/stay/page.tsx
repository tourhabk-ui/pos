import type { Metadata } from 'next';
import StayDashboardClient from './_StayDashboardClient';

export const metadata: Metadata = {
  title: 'Кабинет владельца жилья',
  description: 'Управление объектами размещения и бронями',
  robots: 'noindex, nofollow',
};

export default function StayHubDashboard() {
  return <StayDashboardClient />;
}
