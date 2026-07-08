import type { Metadata } from 'next';
import GuideOnboardingClient from './_GuideOnboardingClient';

export const metadata: Metadata = {
  title: 'Настройка профиля гида | Tourhab',
  description: 'Первые шаги кабинета гида',
  robots: 'noindex, nofollow',
};

export default function GuideOnboardingPage() {
  return <GuideOnboardingClient />;
}
