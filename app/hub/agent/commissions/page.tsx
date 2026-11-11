import type { Metadata } from 'next';
import { agentRoleOpen } from '@/lib/auth/agent-role';
import { AgentMoneyClosed } from '@/components/agent/AgentFrozenNote';
import AgentCommissionsPageClient from './_AgentCommissionsPageClient';

export const metadata: Metadata = {
  title: 'Комиссионные | Агент',
  description: 'Статистика и управление комиссионными агента',
  robots: 'noindex, nofollow',
};

// Деньги агента — только при открытой роли (#3212): по прямому адресу
// замороженный агент видит «раздел закрыт», а не начисления.
export default function AgentCommissionsPage() {
  if (!agentRoleOpen()) return <AgentMoneyClosed title="Комиссии" />;
  return <AgentCommissionsPageClient />;
}
