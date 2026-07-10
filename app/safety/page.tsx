import type { Metadata } from 'next';
import SafetyClient from './_SafetyClient';

export const metadata: Metadata = {
  title: 'Безопасность на Камчатке',
  description: 'Актуальная сейсмика, вулканическая активность, зоны риска и AI Спасатель для туристов на Камчатке.',
  alternates: { canonical: '/safety' },
};

export default function SafetyPage() {
  return <SafetyClient />;
}
