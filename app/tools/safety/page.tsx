import type { Metadata } from 'next';
import { SafetyClient } from './_SafetyClient';

export const metadata: Metadata = {
  title: 'Анализатор безопасности — Ведар',
  description: 'Проверь безопасность маршрута или места на Камчатке: текущий статус, опасности, рекомендации МЧС.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/tools/safety' },
};

export default function SafetyPage() {
  return <SafetyClient />;
}
