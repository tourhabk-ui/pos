import type { Metadata } from 'next';
import GuideDashboardClient from './_GuideDashboardClient';

export const metadata: Metadata = {
  title: 'Личный кабинет гида',
  description: 'Управление расписанием, группами и доходами гида на Ведаре',
  robots: 'noindex, nofollow',
};

export default function GuideDashboard() {
  return <GuideDashboardClient />;
}
