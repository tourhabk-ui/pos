import type { Metadata } from 'next';
import PlanningClient from './_PlanningClient';

export const metadata: Metadata = {
  title: 'Планирование похода — Vedar',
  description: 'Чеклист готовности, рекомендации Кузьмича и популярные маршруты Камчатки.',
};

export default function PlanningPage() {
  return <PlanningClient />;
}
