import type { Metadata } from 'next';
import GearOnboardingClient from './_GearOnboardingClient';

export const metadata: Metadata = {
  title: 'Настройка проката | Tourhab',
  description: 'Первые шаги кабинета проката снаряжения',
  robots: 'noindex, nofollow',
};

export default function GearOnboardingPage() {
  return <GearOnboardingClient />;
}
