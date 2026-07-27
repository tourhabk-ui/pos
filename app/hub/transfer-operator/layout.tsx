'use client';

import { ReactNode } from 'react';
import { Truck, Users, Car } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// section → на мобиле сетка иконок по разделам вместо ленты (см. HubSidebar).
const SIDEBAR_ITEMS = [
  { href: '/hub/transfer-operator',          label: 'Обзор',     icon: Truck },
  { href: '/hub/transfer-operator/vehicles', label: 'Автопарк',  icon: Car,   section: 'Управление' },
  { href: '/hub/transfer-operator/drivers',  label: 'Водители',  icon: Users, section: 'Управление' },
];

export default function TransferOperatorLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Трансфер-оператор" requiredRole={['transfer_operator', 'transfer', 'operator']}>
      {children}
    </HubLayout>
  );
}
