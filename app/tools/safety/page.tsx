import type { Metadata } from 'next';
import { SafetyClient } from './_SafetyClient';

export const metadata: Metadata = {
  title: 'Анализатор безопасности',
  description: 'Место или маршрут на Камчатке на сегодня: обстановка по сводкам, записанные опасности, регистрация в МЧС и номер 112 — те же данные, что на карточке.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/tools/safety' },
};

export default function SafetyPage() {
  return <SafetyClient />;
}
