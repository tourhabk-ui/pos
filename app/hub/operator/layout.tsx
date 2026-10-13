'use client';

import { ReactNode } from 'react';
import { HubLayout } from '@/components/layout/HubLayout';
import { ChatWidget } from '@/components/chat/ChatWidget';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';
import { ForcePasswordChangeBanner } from '@/components/operator/ForcePasswordChangeBanner';
import { OPERATOR_MENU, menuForSeat } from '@/components/operator/operator-menu';
import { useOperatorSeat } from '@/components/operator/use-operator-seat';

// Пункты меню и кому они видны — components/operator/operator-menu.ts (CRM 2г):
// менеджеру команды не показываются деньги и настройки, а скидки — только с
// правом цен. Защита при этом на сервере; меню лишь не зовёт туда, где откажут.
export default function OperatorHubLayout({ children }: { children: ReactNode }) {
  const seat = useOperatorSeat();
  return (
    <HubLayout sidebarItems={menuForSeat(OPERATOR_MENU, seat)} sidebarTitle="Кабинет оператора" requiredRole={['operator', 'admin']}>
      <ForcePasswordChangeBanner />
      <PartnerChannelBanner />
      {children}
      <ChatWidget />
    </HubLayout>
  );
}
