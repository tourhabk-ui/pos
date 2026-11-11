import type { Metadata } from 'next';
import { AgentMoneyGate } from '@/components/agent/AgentFrozenNote';
import AgentCommissionsPageClient from './_AgentCommissionsPageClient';

export const metadata: Metadata = {
  title: 'Комиссионные | Агент',
  description: 'Статистика и управление комиссионными агента',
  robots: 'noindex, nofollow',
};

// Деньги агента — только при открытой роли (#3212): по прямому адресу
// замороженный агент видит «раздел закрыт», а не начисления
// (правило роли — в AgentMoneyGate).
export default function AgentCommissionsPage() {
  return (
    <AgentMoneyGate title="Комиссии">
      <AgentCommissionsPageClient />
    </AgentMoneyGate>
  );
}
