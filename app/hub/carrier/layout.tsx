'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, BookUser, ListChecks, BellDot } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';

// Кабинет перевозчика (схема 926, 02.09): парк, поездки и запросы мест живут
// на одном экране вкладками. Клиенты — отдельным разделом: экран CRM общий
// для всех партнёров (CRM #2325).
const SIDEBAR_ITEMS = [
  { href: '/hub/carrier', label: 'Кабинет', icon: LayoutDashboard },
  { href: '/hub/carrier/inbox', label: 'Входящие', icon: BellDot },
  { href: '/hub/carrier/clients', label: 'Клиенты', icon: BookUser },
  { href: '/hub/carrier/tasks', label: 'Задачи', icon: ListChecks },
];

export default function CarrierHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Перевозчик" requiredRole={['transfer', 'transfer_operator', 'admin']}>
      <PartnerChannelBanner />
      {children}
    </HubLayout>
  );
}
