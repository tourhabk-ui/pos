import type { Metadata } from 'next';
import GearDashboardClient from './_GearDashboardClient';

export const metadata: Metadata = {
  title: 'Кабинет проката снаряжения',
  description: 'Управление инвентарём и арендами снаряжения',
  robots: 'noindex, nofollow',
};

export default function GearHubDashboard() {
  return <GearDashboardClient />;
}
