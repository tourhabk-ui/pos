import type { Metadata } from 'next';
import { AgentMoneyGate } from '@/components/agent/AgentFrozenNote';
import ReferralClient from './_ReferralClient';

export const metadata: Metadata = {
  title: 'Реферальные ссылки',
  description: 'Агентские реферальные ссылки и конверсии',
  robots: 'noindex, nofollow',
};

// Деньги агента — только при открытой роли (#3212): по прямому адресу
// замороженный агент видит «раздел закрыт», а не начисления
// (правило роли — в AgentMoneyGate).
export default function AgentReferralPage() {
  return (
    <AgentMoneyGate title="Реферальные ссылки">
      <ReferralClient />
    </AgentMoneyGate>
  );
}
