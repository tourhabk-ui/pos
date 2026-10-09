'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, BookUser } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// Кабинет перевозчика (схема 926, 02.09): парк, поездки и запросы мест живут
// на одном экране вкладками. Клиенты — отдельным разделом: экран CRM общий
// для всех партнёров (CRM #2325).
const SIDEBAR_ITEMS = [
  { href: '/hub/carrier', label: 'Кабинет', icon: LayoutDashboard },
  { href: '/hub/carrier/clients', label: 'Клиенты', icon: BookUser },
];

export default function CarrierHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Перевозчик" requiredRole={['transfer', 'transfer_operator', 'admin']}>
      {children}
    </HubLayout>
  );
}
