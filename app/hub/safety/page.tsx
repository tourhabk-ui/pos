import type { Metadata } from 'next';
import SafetyHubClient from './_SafetyHubClient';

export const metadata: Metadata = {
  title: 'Безопасность',
  description: 'Управление безопасностью туров',
  robots: 'noindex, nofollow',
};

export default function SafetyHub() {
  return <SafetyHubClient />;
}
