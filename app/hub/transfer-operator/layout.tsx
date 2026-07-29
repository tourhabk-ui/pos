'use client';

import { ReactNode } from 'react';
import { Truck, Users, Car, ClipboardList, Map } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// section → на мобиле сетка иконок по разделам вместо ленты (см. HubSidebar).
// Брони и Маршруты существовали как страницы, но в навигации их не было —
// до них можно было добраться только прямой ссылкой (сироты).
const SIDEBAR_ITEMS = [
  { href: '/hub/transfer-operator',          label: 'Обзор',     icon: Truck },
  { href: '/hub/transfer-operator/bookings', label: 'Брони',     icon: ClipboardList, section: 'Продажи' },
  { href: '/hub/transfer-operator/routes',   label: 'Маршруты',  icon: Map,   section: 'Продажи' },
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
