'use client';

import { ReactNode } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// Кабинет перевозчика (схема 926, 02.09): парк, поездки и запросы мест живут
// на одном экране — разделов у кабинета пока три, и все умещаются во вкладки.
const SIDEBAR_ITEMS = [
  { href: '/hub/carrier', label: 'Кабинет', icon: LayoutDashboard },
];

export default function CarrierHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Перевозчик" requiredRole={['transfer', 'transfer_operator', 'admin']}>
      {children}
    </HubLayout>
  );
}
