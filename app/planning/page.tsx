import type { Metadata } from 'next';
import { PlanningClient } from './_PlanningClient';

export const metadata: Metadata = {
  title: 'Планирование — Ведар',
  description: 'Планируйте поход, отслеживайте готовность и навигируйте по маршруту.',
};

export default function PlanningPage() {
  return <PlanningClient />;
}
