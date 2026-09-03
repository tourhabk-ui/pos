import type { Metadata } from 'next';
import HealthTabs from './_HealthTabs';

export const metadata: Metadata = {
  title: 'Health-метрики | Tourhab Admin',
  description: 'Сводка health-метрик данных платформы',
  robots: 'noindex, nofollow',
};

export default function AdminHealthPage() {
  return <HealthTabs />;
}
