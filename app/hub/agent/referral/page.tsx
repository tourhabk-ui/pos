import type { Metadata } from 'next';
import { agentRoleOpen } from '@/lib/auth/agent-role';
import { AgentMoneyClosed } from '@/components/agent/AgentFrozenNote';
import ReferralClient from './_ReferralClient';

export const metadata: Metadata = {
  title: 'Реферальные ссылки',
  description: 'Агентские реферальные ссылки и конверсии',
  robots: 'noindex, nofollow',
};

// Деньги агента — только при открытой роли (#3212): по прямому адресу
// замороженный агент видит «раздел закрыт», а не начисления.
export default function AgentReferralPage() {
  if (!agentRoleOpen()) return <AgentMoneyClosed title="Реферальные ссылки" />;
  return <ReferralClient />;
}
