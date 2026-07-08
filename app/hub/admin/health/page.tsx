import type { Metadata } from 'next';
import HealthDashboardClient from './_HealthDashboardClient';

export const metadata: Metadata = {
  title: 'Health-метрики | Tourhab Admin',
  description: 'Сводка health-метрик данных платформы',
  robots: 'noindex, nofollow',
};

export default function AdminHealthPage() {
  return <HealthDashboardClient />;
}
