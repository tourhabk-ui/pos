import type { Metadata } from 'next';
import AgentProfileClient from './_AgentProfileClient';

export const metadata: Metadata = {
  title: 'Профиль агентства | Tourhab',
  description: 'Профиль и контакты агента',
  robots: 'noindex, nofollow',
};

export default function AgentProfilePage() {
  return <AgentProfileClient />;
}
