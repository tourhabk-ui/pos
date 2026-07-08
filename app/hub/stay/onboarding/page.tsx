import type { Metadata } from 'next';
import StayOnboardingClient from './_StayOnboardingClient';

export const metadata: Metadata = {
  title: 'Настройка кабинета жилья | Tourhab',
  description: 'Первые шаги владельца жилья',
  robots: 'noindex, nofollow',
};

export default function StayOnboardingPage() {
  return <StayOnboardingClient />;
}
