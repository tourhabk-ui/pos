import type { Metadata } from 'next';
import AgentOnboardingClient from './_AgentOnboardingClient';

export const metadata: Metadata = {
  title: 'Настройка кабинета агента | Tourhab',
  description: 'Первые шаги агентского кабинета',
  robots: 'noindex, nofollow',
};

export default function AgentOnboardingPage() {
  return <AgentOnboardingClient />;
}
