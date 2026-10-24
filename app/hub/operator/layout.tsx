'use client';

import { ReactNode } from 'react';
import { HubLayout } from '@/components/layout/HubLayout';
import { ChatWidget } from '@/components/chat/ChatWidget';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';
import { ForcePasswordChangeBanner } from '@/components/operator/ForcePasswordChangeBanner';
import { MemberChannelBanner } from '@/components/operator/MemberChannelBanner';
import { OPERATOR_MENU, menuForSeat } from '@/components/operator/operator-menu';
import { isManagerSeat, useOperatorSeat } from '@/components/operator/use-operator-seat';
import { OperatorCabinetGate } from '@/components/operator/OperatorCabinetGate';

// Пункты меню и кому они видны — components/operator/operator-menu.ts (CRM 2г):
// менеджеру команды не показываются деньги и настройки, а скидки — только с
// правом цен. Защита при этом на сервере; меню лишь не зовёт туда, где откажут.

const TITLE = 'Кабинет оператора';
const ROLES = ['operator', 'admin'];

function QuietShell({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={menuForSeat(OPERATOR_MENU, { state: 'loading' })} sidebarTitle={TITLE} requiredRole={ROLES}>
      <ForcePasswordChangeBanner />
      {children}
    </HubLayout>
  );
}

function OpenCabinet({ children }: { children: ReactNode }) {
  const seat = useOperatorSeat();
  return (
    <HubLayout sidebarItems={menuForSeat(OPERATOR_MENU, seat)} sidebarTitle={TITLE} requiredRole={ROLES}>
      <ForcePasswordChangeBanner />
      {/* Чат кабинета подключает владелец; менеджер — свой мессенджер для
          копий уведомлений (2г-4). Пока место не узнано — ни того ни другого:
          менеджеру не мелькнёт чужой баннер со ссылкой, которую ему не дадут. */}
      {seat.state === 'loading' ? null : isManagerSeat(seat) ? <MemberChannelBanner /> : <PartnerChannelBanner />}
      <div className="min-w-0 max-w-full pb-20">{children}</div>
      <ChatWidget />
    </HubLayout>
  );
}

export default function OperatorHubLayout({ children }: { children: ReactNode }) {
  return (
    <OperatorCabinetGate
      quiet={(node) => <QuietShell>{node}</QuietShell>}
      ready={(node) => <OpenCabinet>{node}</OpenCabinet>}
    >
      {children}
    </OperatorCabinetGate>
  );
}
