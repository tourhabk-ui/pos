'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, BookUser, ListChecks, BellDot, CarFront } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';

// Кабинет перевозчика: парк машин (с 13.10 без поездок и запросов мест —
// трансфер продаётся машиной целиком). Клиенты — отдельным разделом: экран CRM
// общий для всех партнёров (CRM #2325). «Прокат» — машины без водителя,
// заявки и календарь (владелец 26.10, «Лагуна Прокат»).
const SIDEBAR_ITEMS = [
  { href: '/hub/carrier', label: 'Кабинет', icon: LayoutDashboard },
  { href: '/hub/carrier/rental', label: 'Прокат', icon: CarFront },
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
